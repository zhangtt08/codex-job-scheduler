/**
 * Agent 后端抽象层。
 *
 * 这里是「支持任意 CLI agent」的落点：每个后端是一份配置（可执行文件 + 参数模板 +
 * 提示词传递方式 + stdout 解析方式），不把任何厂商硬编码进执行器。
 * codex / claude 提供内置探测规则，其余靠命令名走 PATH，或由用户填绝对路径。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile, AgentStatus, OutputParser, PromptVia } from './types'

export const DEFAULT_AGENT_ID = 'codex'

/** 默认的「成功后刷新」提示词（无 agent 倾向，纯问时间）。 */
export const DEFAULT_FOLLOWUP_PROMPT = '请告诉我现在的中国北京时间（含日期），以及 5 小时后是什么时间。'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface AgentPreset {
  id: string
  label: string
  bin: string
  new_args: string[]
  resume_args: string[]
  prompt_via: PromptVia
  parser: OutputParser
  notes: string
}

/**
 * 内置预设。
 *
 * 注意：除 codex 外，其余 CLI 的参数**未能在本机实测**（环境里没装，或沙箱禁止其调用
 * 系统程序）。因此它们只是「合理起点」——所有参数都能在 Agent 设置页里改。
 * 参数一旦与你的 CLI 版本不符，改模板即可，不用改代码。
 */
export const BUILTIN_AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: '',
    new_args: [
      'exec',
      '--json',
      '--color',
      'never',
      '--cd',
      '{cwd}',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      '{lastMessageFile}',
      '-m',
      '{model}'
    ],
    resume_args: [
      'exec',
      'resume',
      '--json',
      '--output-last-message',
      '{lastMessageFile}',
      '-c',
      'sandbox_mode="workspace-write"',
      '-m',
      '{model}',
      '{session}'
    ],
    prompt_via: 'stdin',
    parser: 'codex-jsonl',
    notes: '本机已验证。bin 留空时自动定位 npm 全局安装的原生 codex.exe。'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bin: '',
    new_args: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--model',
      '{model}'
    ],
    resume_args: [
      '-p',
      '--resume',
      '{session}',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--model',
      '{model}'
    ],
    prompt_via: 'stdin',
    parser: 'claude-jsonl',
    notes:
      'bin 留空时自动探测 ~/.local/bin/claude.exe 与 npm 全局。无人值守若需要更宽权限，把 acceptEdits 改成 bypassPermissions（有风险，自行评估）。'
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    new_args: ['-p', '--output-format', 'stream-json', '--model', '{model}'],
    resume_args: ['-p', '--resume', '{session}', '--output-format', 'stream-json', '--model', '{model}'],
    prompt_via: 'stdin',
    parser: 'plain',
    notes: '需自行安装 cursor-agent 并使其在 PATH 中；参数以官方文档为准，不适配时请改模板。'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    new_args: ['-p', '--yolo', '--model', '{model}'],
    resume_args: [],
    prompt_via: 'stdin',
    parser: 'plain',
    notes: '需自行安装 gemini CLI；--yolo 表示自动批准操作，介意的话换成 --approval-mode auto_edit。'
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    new_args: ['--yes-always', '--message'],
    resume_args: [],
    prompt_via: 'arg',
    parser: 'plain',
    notes: 'Aider 用 --message 接提示词，所以这里配成 arg 模式（提示词作为最后一个位置参数）。'
  },
  {
    id: 'custom',
    label: '自定义后端',
    bin: '',
    new_args: [],
    resume_args: [],
    prompt_via: 'stdin',
    parser: 'plain',
    notes:
      '空白模板：填可执行文件与参数即可接任意 CLI（zcode / windsurf / opencode / 自研脚本都能用）。占位符：{cwd} {model} {lastMessageFile} {session}。'
  }
]

const PRESET_BY_ID = new Map(BUILTIN_AGENT_PRESETS.map((p) => [p.id, p]))

export function isBuiltinAgentId(id: string): boolean {
  return PRESET_BY_ID.has(id)
}

/** 判断某个后端是否支持「把最终消息写进文件」—— 模板里出现 {lastMessageFile} 即视为支持。 */
export function usesLastMessageFile(profile: Pick<AgentProfile, 'new_args' | 'resume_args'>): boolean {
  return [...profile.new_args, ...profile.resume_args].some((a) => a.includes('{lastMessageFile}'))
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const VENDOR_TRIPLE: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
}

/**
 * npm 全局安装目录。优先用 APPDATA，但**同时**用 os.homedir() 兜底：
 * APPDATA 可能被覆盖（例如测试把数据目录隔离到临时路径），只认它会导致
 * 明明装好的 codex 也探测不到。
 */
function npmGlobalRoots(): string[] {
  const roots: string[] = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'))
  const home = os.homedir()
  if (home) {
    const alt = path.join(home, 'AppData', 'Roaming', 'npm')
    if (!roots.some((r) => r.toLowerCase() === alt.toLowerCase())) roots.push(alt)
  }
  return roots
}

function codexBinaryCandidates(): string[] {
  const triple = VENDOR_TRIPLE[`${process.platform}-${process.arch}`]
  if (!triple) return []
  const out: string[] = []
  for (const root of npmGlobalRoots()) {
    out.push(
      path.join(
        root,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        `codex-${process.platform}-${process.arch}`,
        'vendor',
        triple,
        'bin',
        'codex.exe'
      ),
      // 局部安装的形态（某些版本会把原生包放在 codex 自身目录下）
      path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.exe')
    )
  }
  return out
}

function claudeBinaryCandidates(): string[] {
  const home = os.homedir()
  const list: string[] = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude')
  ]
  for (const root of npmGlobalRoots()) {
    list.push(path.join(root, 'claude.exe'), path.join(root, 'claude.cmd'))
  }
  if (process.env.LOCALAPPDATA) {
    list.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'),
      path.join(process.env.LOCALAPPDATA, 'claude', 'claude.exe')
    )
  }
  return list
}

/** 已知安装位置的名字 → 候选路径。返回第一个存在的。 */
function lookupKnownLocation(name: string): string | null {
  const key = name.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
  const candidates = key === 'codex' ? codexBinaryCandidates() : key === 'claude' ? claudeBinaryCandidates() : []
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * 解析出最终要 spawn 的可执行文件。
 *  - 绝对路径：存在即用，不存在返回 null
 *  - 命令名：先查内置已知位置，查不到交回原值（由 PATH 解析）
 */
export function resolveAgentBin(profile: Pick<AgentProfile, 'id' | 'bin'>): string | null {
  const raw = (profile.bin ?? '').trim()
  if (raw) {
    if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : null
    return lookupKnownLocation(raw) ?? raw
  }
  return lookupKnownLocation(profile.id)
}

/** .cmd / .bat 在 Windows 上必须经 shell 启动，spawn 直接执行会 EINVAL。 */
export function needsShell(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
}

// ---------------------------------------------------------------------------
// Capability probing
// ---------------------------------------------------------------------------

function runVersion(bin: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        ['--version'],
        { timeout: 15000, windowsHide: true, shell: needsShell(bin) },
        (err, stdout, stderr) => {
          const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
          resolve({ ok: !err, out })
        }
      )
    } catch (err) {
      resolve({ ok: false, out: (err as Error).message })
    }
  })
}

const versionCache = new Map<string, AgentStatus>()

export async function probeAgent(profile: AgentProfile, useCache = false): Promise<AgentStatus> {
  if (useCache) {
    const hit = versionCache.get(profile.id)
    if (hit) return hit
  }
  const bin = resolveAgentBin(profile)
  let status: AgentStatus
  if (!bin) {
    status = {
      id: profile.id,
      label: profile.label,
      resolvedBin: null,
      available: false,
      version: null,
      error: '未找到可执行文件。请填写绝对路径，或把命令加入 PATH。'
    }
  } else {
    const res = await runVersion(bin)
    const version = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? null
    status = {
      id: profile.id,
      label: profile.label,
      resolvedBin: bin,
      available: res.ok,
      version: res.ok ? version : null,
      error: res.ok ? null : res.out.slice(0, 500) || '执行 --version 失败'
    }
  }
  versionCache.set(profile.id, status)
  return status
}

export function invalidateProbeCache(id?: string): void {
  if (id) versionCache.delete(id)
  else versionCache.clear()
}

// ---------------------------------------------------------------------------
// Argument templating
// ---------------------------------------------------------------------------

export interface InvocationContext {
  cwd: string
  model?: string | null
  lastMessageFile?: string | null
  sessionId?: string | null
}

/**
 * 占位符替换。
 *
 * 规则：**纯占位符取到空值时，连同紧邻在前的那个 flag 一起丢弃**。
 * 这样 `['-m', '{model}']` 在没指定模型时会整组消失，而不是把空字符串塞给 CLI。
 *
 * 调用方要保证「取值不会为空」的占位符不要写成这种紧随 flag 的形式
 * （例如 {session} 在 resume 场景必须有值，否则会连带吃掉前面的参数）。
 */
export function substituteArgs(template: string[], ctx: InvocationContext): string[] {
  const values: Record<string, string> = {
    cwd: ctx.cwd,
    model: ctx.model ?? '',
    lastMessageFile: ctx.lastMessageFile ?? '',
    session: ctx.sessionId ?? ''
  }
  const out: string[] = []
  for (const raw of template) {
    const pure = /^\{(\w+)\}$/.exec(raw)
    if (pure) {
      const value = values[pure[1]] ?? ''
      if (!value) {
        if (out.length && /^-/.test(out[out.length - 1])) out.pop()
        continue
      }
      out.push(value)
      continue
    }
    out.push(raw.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? ''))
  }
  return out
}

export interface Invocation {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  shell: boolean
  /** 本次执行会把最终响应写进这个文件（模板声明了 {lastMessageFile} 时） */
  lastMessageFile: string | null
  /** 提示词是否作为最后一个参数追加 */
  promptAsArg: boolean
}

export function buildAgentInvocation(
  profile: AgentProfile,
  ctx: InvocationContext,
  mode: 'new' | 'resume'
): Invocation {
  const bin = resolveAgentBin(profile)
  if (!bin) throw new Error(`agent「${profile.label}」未找到可执行文件`)
  const template = mode === 'resume' ? profile.resume_args : profile.new_args
  const env: NodeJS.ProcessEnv = { ...process.env, ...(profile.env ?? {}) }
  return {
    bin,
    args: substituteArgs(template, ctx),
    env,
    shell: needsShell(bin),
    lastMessageFile: usesLastMessageFile(profile) ? (ctx.lastMessageFile ?? null) : null,
    promptAsArg: profile.prompt_via === 'arg'
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export interface ParsedAgentOutput {
  sessionId?: string
  finalResponse?: string
  lastError?: string
  quotaResetAt?: Date
  changedFiles: Set<string>
  /** plain 解析模式下的原文行 */
  rawLines: string[]
}

export function createOutputAccumulator(): ParsedAgentOutput {
  return { changedFiles: new Set(), rawLines: [] }
}

/**
 * 从错误消息里解析限额恢复时间。覆盖多种 CLI 的措辞：
 *  - "…try again at Aug 31st, 2026 2:47 AM."
 *  - "…try again at 2:47 AM."
 *  - "…usage limit reached|1726000000"（Unix 秒）
 *  - "…limit will reset at 3:00 PM"
 */
export function parseQuotaResetAt(message: string | null | undefined): Date | null {
  if (!message) return null
  if (!/(usage limit|limit reached|rate limit|quota|try again at|reset at)/i.test(message)) return null

  // 形态一：Unix 时间戳，如 "limit reached|1726000000"
  const epoch = message.match(/\|(\d{10,13})\b/)
  if (epoch) {
    const n = Number(epoch[1])
    const d = new Date(n < 1e12 ? n * 1000 : n)
    if (!Number.isNaN(d.getTime())) return d
  }

  // 形态二：自然语言时间
  const m = message.match(/(?:try again at|resets? at|available at|reset at)\s+([^.]+(?:\.[^"'[\]]+)?)/i)
  if (!m) return null
  const text = m[1].replace(/(\d+)(st|nd|rd|th)\b/gi, '$1').trim()
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) return parsed
  // 只有时间（"2:47 AM"）：取今天该时刻，已过则算明天
  const t = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (t) {
    let hour = Number(t[1]) % 24
    const minute = Number(t[2])
    const meridiem = t[3]?.toUpperCase()
    if (meridiem === 'PM' && hour < 12) hour += 12
    if (meridiem === 'AM' && hour === 12) hour = 0
    const d = new Date()
    d.setHours(hour, minute, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d
  }
  return null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function parseCodexLine(evt: Record<string, unknown>, acc: ParsedAgentOutput): void {
  if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') acc.sessionId = evt.thread_id
  if (evt.type === 'session.created' && typeof evt.session_id === 'string') acc.sessionId = evt.session_id
  if (evt.type === 'error' && typeof evt.message === 'string') {
    acc.lastError = evt.message
    const reset = parseQuotaResetAt(evt.message)
    if (reset) acc.quotaResetAt = reset
  }
  const failedError = asRecord(evt.error)
  if (evt.type === 'turn.failed' && failedError && typeof failedError.message === 'string') {
    if (!acc.lastError) acc.lastError = failedError.message
    const reset = parseQuotaResetAt(failedError.message)
    if (reset) acc.quotaResetAt = reset
  }
  const item = asRecord(evt.item)
  if (item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') acc.finalResponse = item.text
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      for (const change of item.changes as Array<Record<string, unknown>>) {
        if (typeof change.path === 'string') acc.changedFiles.add(change.path)
      }
    }
  }
}

/**
 * Claude Code 的 stream-json：
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"..."}
 */
function parseClaudeLine(evt: Record<string, unknown>, acc: ParsedAgentOutput): void {
  if (typeof evt.session_id === 'string' && evt.session_id) acc.sessionId = evt.session_id

  if (evt.type === 'assistant') {
    const message = asRecord(evt.message)
    const content = message && Array.isArray(message.content) ? message.content : null
    if (content) {
      const texts = content
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => !!c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
      if (texts.length) acc.finalResponse = texts.join('\n')
    }
    return
  }

  if (evt.type === 'result') {
    if (typeof evt.result === 'string' && evt.result.trim()) acc.finalResponse = evt.result
    if (evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype.startsWith('error'))) {
      const detail =
        (typeof evt.result === 'string' && evt.result) ||
        (typeof evt.subtype === 'string' && evt.subtype) ||
        '执行失败'
      acc.lastError = detail
      const reset = parseQuotaResetAt(detail)
      if (reset) acc.quotaResetAt = reset
    }
    return
  }

  // 顶层直接给错误的情况
  if (evt.type === 'error' && typeof evt.message === 'string') {
    acc.lastError = evt.message
    const reset = parseQuotaResetAt(evt.message)
    if (reset) acc.quotaResetAt = reset
  }
}

/** 解析一行 stdout。jsonl 模式解析失败时静默忽略（CLI 可能插入非 JSON 的告警行）。 */
export function parseAgentLine(parser: OutputParser, raw: string, acc: ParsedAgentOutput): void {
  if (parser === 'plain') {
    acc.rawLines.push(raw)
    if (acc.rawLines.length > 4000) acc.rawLines.splice(0, acc.rawLines.length - 4000)
    const reset = parseQuotaResetAt(raw)
    if (reset) acc.quotaResetAt = reset
    // 纯文本模式下，把明显的错误行记下来
    if (/\b(error|failed|usage limit|rate limit)\b/i.test(raw)) acc.lastError = raw.trim().slice(0, 2000)
    return
  }
  let evt: Record<string, unknown>
  try {
    evt = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // 非 JSON 行：仍尝试抓限额信息（有的 CLI 把告警打到 stdout 明文）
    const reset = parseQuotaResetAt(raw)
    if (reset && !acc.quotaResetAt) acc.quotaResetAt = reset
    return
  }
  if (parser === 'codex-jsonl') parseCodexLine(evt, acc)
  else parseClaudeLine(evt, acc)
}

/** plain 模式收尾：最后一段非空文本作为最终响应。 */
export function finalizePlainResponse(lines: string[]): string | null {
  const text = lines.join('\n').trim()
  return text || null
}
