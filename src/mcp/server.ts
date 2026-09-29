/**
 * MCP 服务器（stdio 传输，NDJSON）。
 *
 * 让任意支持 MCP 的 agent（Claude Code / Codex / WorkBuddy 等）用自然语言直接
 * 操作这个调度器：「明天下午四点提醒我发消息」→ agent 调 create_task → 到点执行。
 *
 * 协议约定：
 *  - stdout 只能出现协议消息（一行一个 JSON-RPC）。所有日志/调试一律走 stderr，
 *    否则会污染协议流导致客户端解析失败。
 *  - 本进程独立访问 SQLite（WAL + busy_timeout），与 Electron 主进程并发安全。
 *  - 因此它也不需要应用开着：建完任务会顺手注册 Windows 计划任务，关掉一切也照常跑。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  createProject,
  createTask,
  deleteTask,
  getAgent,
  getDb,
  getLog,
  getTask,
  listAgents,
  listLogsForTask,
  listProjects,
  listTasks,
  setTaskStatus
} from '../shared/db'
import { deleteScheduledTask, resolveRunnerScript, syncScheduledTask } from '../shared/scheduler'
import { cancelRun, runningLogIdForTask, taskIsRunning } from '../shared/executor'
import { resolveAgentBin } from '../shared/agents'
import { describeWhen, parseRunAt } from '../shared/runat'
import type { Project, Task } from '../shared/types'

const SERVER_NAME = 'codex-job-scheduler'
const SERVER_VERSION = '0.2.0'
const PROTOCOL_FALLBACK = '2025-06-18'

function log(...parts: unknown[]): void {
  process.stderr.write(`[mcp] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`)
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

// 时间解析（parseRunAt / describeWhen）在 shared/runat.ts —— 纯函数，可单独测试。

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProject(args: Record<string, unknown>): Project {
  const byName = args.project != null ? String(args.project).trim() : ''
  const byPath = args.project_path != null ? String(args.project_path).trim() : ''
  const all = listProjects()

  if (byName) {
    const hit = all.find((p) => String(p.id) === byName || p.name === byName)
    if (hit) return hit
    if (!all.length) throw new Error(`找不到项目「${byName}」，当前还没有任何项目。请提供 project_path 新建一个。`)
    throw new Error(`找不到项目「${byName}」。已有项目：${all.map((p) => `${p.name}(#${p.id})`).join('、')}`)
  }

  if (byPath) {
    if (!fs.existsSync(byPath)) throw new Error(`目录不存在：${byPath}`)
    const hit = all.find((p) => p.path.toLowerCase() === byPath.toLowerCase())
    if (hit) return hit
    const created = createProject({ name: path.basename(byPath) || byPath, path: byPath })
    log(`created project #${created.id} for ${byPath}`)
    return created
  }

  if (all.length === 1) return all[0]
  if (!all.length) throw new Error('还没有任何项目。请提供 project_path（本地目录）来新建项目。')
  throw new Error(`有多个项目，必须指定 project。可选：${all.map((p) => `${p.name}(#${p.id})`).join('、')}`)
}

function summarizeTask(task: Task): string {
  const lines = [
    `任务 #${task.id}「${task.name}」`,
    `  项目：${task.project_name ?? task.project_id}${task.project_path ? ` (${task.project_path})` : ''}`,
    `  后端：${task.agent_id || `（跟随项目：${task.project_agent_id ?? '未设置'}）`} → 实际使用 ${task.effective_agent_id ?? task.agent_id ?? 'codex'}`,
    `  状态：${task.status}`
  ]
  if (task.run_date && task.run_time) lines.push(`  排期：${describeWhen(task.run_date, task.run_time)}`)
  else lines.push('  排期：未排期（只能手动触发）')
  if (task.execution_mode === 'resume_session') lines.push(`  模式：恢复会话 ${task.session_id ?? ''}`)
  if (task.last_run_at) lines.push(`  上次运行：${task.last_run_at}`)
  lines.push(`  提示词：${task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt}`)
  return lines.join('\n')
}

function describeLastRun(taskId: number): string {
  const logs = listLogsForTask(taskId)
  if (!logs.length) return '  运行记录：无'
  const latest = logs[0]
  const parts = [
    `  最近一次运行 #${latest.id}：${latest.status}`,
    `    开始 ${latest.started_at}`,
    latest.ended_at ? `    结束 ${latest.ended_at}` : '',
    latest.duration_ms != null ? `    耗时 ${(latest.duration_ms / 1000).toFixed(1)} 秒` : '',
    latest.exit_code != null ? `    退出码 ${latest.exit_code}` : '',
    latest.agent_id ? `    后端 ${latest.agent_id}` : '',
    latest.error_message ? `    错误：${latest.error_message.slice(0, 300)}` : '',
    latest.final_response ? `    最终响应：${latest.final_response.slice(0, 800)}` : ''
  ]
  return parts.filter(Boolean).join('\n')
}

function spawnRunner(taskId: number, force: boolean): string {
  const runner = resolveRunnerScript()
  if (!runner) throw new Error('未找到 codex-runner.cjs，请先在项目里运行 npm run build:runner。')
  const args = [runner, '--task', String(taskId)]
  if (force) args.push('--force')
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(runner)
  })
  child.unref()
  return `已在后台启动独立 Runner（pid ${child.pid ?? '未知'}）。`
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string

const HANDLERS: Record<string, ToolHandler> = {
  async create_task(args) {
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) throw new Error('prompt 不能为空。')

    const project = resolveProject(args)

    // 时间：优先 run_at，其次 run_date + run_time
    let date: string | null = null
    let time: string | null = null
    if (args.run_at != null && String(args.run_at).trim()) {
      const parsed = parseRunAt(String(args.run_at))
      if (!parsed) {
        throw new Error(
          `无法解析执行时间「${args.run_at}」。可用格式：16:00、4:00 PM、2026-09-24T16:00、2026-09-24 16:00。`
        )
      }
      date = parsed.date
      time = parsed.time
    } else if (args.run_date != null || args.run_time != null) {
      const d = args.run_date != null ? String(args.run_date).trim() : ''
      const t = args.run_time != null ? String(args.run_time).trim() : ''
      if (!d || !t) throw new Error('run_date 与 run_time 必须同时提供（或改用 run_at）。')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`run_date 格式应为 YYYY-MM-DD，收到「${d}」。`)
      const parsed = parseRunAt(`${d} ${t}`)
      if (!parsed) throw new Error(`无法解析 run_time「${t}」，应为 HH:MM 或 HH:MM:SS。`)
      date = parsed.date
      time = parsed.time
    }

    // 后端：显式指定 > 项目默认
    const agentId = args.agent != null && String(args.agent).trim() ? String(args.agent).trim() : null
    if (agentId) {
      const profile = getAgent(agentId)
      if (!profile) {
        const avail = listAgents().map((a) => a.id).join('、')
        throw new Error(`agent 后端「${agentId}」不存在。可用后端：${avail}`)
      }
      if (profile.enabled !== 1) throw new Error(`agent 后端「${agentId}」已被停用。`)
    }

    const mode = String(args.execution_mode ?? 'new_session')
    if (mode !== 'new_session' && mode !== 'resume_session') {
      throw new Error('execution_mode 只能是 new_session 或 resume_session。')
    }
    const sessionId = args.session_id != null ? String(args.session_id).trim() : ''
    if (mode === 'resume_session' && !sessionId) {
      throw new Error('execution_mode 为 resume_session 时必须提供 session_id。')
    }

    const postAction = String(args.post_action ?? 'none')
    if (postAction !== 'none' && postAction !== 'shutdown') {
      throw new Error('post_action 只能是 none 或 shutdown。')
    }

    const name = args.name != null && String(args.name).trim() ? String(args.name).trim() : `定时任务 ${date ?? ''} ${time ?? ''}`.trim()

    const task = createTask({
      project_id: project.id,
      name,
      run_date: date,
      run_time: time,
      prompt,
      execution_mode: mode,
      session_id: sessionId || null,
      agent_id: agentId,
      wake_enabled: args.wake === true ? 1 : 0,
      // 注意：MCP 建的任务默认**不关机**。UI 里默认关机是给人用的；
      // 让 agent 顺手建个提醒就把机器关了是灾难。
      post_action: postAction as 'none' | 'shutdown',
      quota_retry: args.quota_retry === true ? 1 : 0,
      retry_count: Number(args.retry_count ?? 0) || 0,
      usb_backup: args.usb_backup === true ? 1 : 0,
      usb_copy_subdir: args.usb_copy_subdir != null ? String(args.usb_copy_subdir) : null
    })

    let scheduleNote = '未排期，需要手动触发。'
    if (task.run_date && task.run_time) {
      try {
        const res = await syncScheduledTask(task)
        scheduleNote = res.ok
          ? res.mode === 'file-drop'
            ? `已写入任务定义文件（${res.message}）`
            : '已注册到 Windows 任务计划程序，到点自动执行。'
          : `注册计划任务失败：${res.message}（应用启动时会重试；也可在应用里重新保存该任务）`
      } catch (err) {
        scheduleNote = `注册计划任务时出错：${(err as Error).message}`
      }
    }

    const refreshed = getTask(task.id)!
    return [
      '已创建任务。',
      summarizeTask(refreshed),
      `  计划任务：${scheduleNote}`,
      '',
      `后续可用 get_task(${task.id}) 查看进度、get_run_result(${task.id}) 取最终响应、run_task_now(${task.id}) 立即执行。`
    ].join('\n')
  },

  list_tasks(args) {
    const status = args.status != null ? String(args.status) : ''
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200)
    let tasks = listTasks()
    if (status) tasks = tasks.filter((t) => t.status === status)
    tasks = tasks.slice(0, limit)
    if (!tasks.length) return '没有匹配的任务。'
    return tasks
      .map(
        (t) =>
          `#${t.id} [${t.status}] ${t.name} · ${t.project_name ?? ''} · ${t.effective_agent_id ?? 'codex'} · ` +
          (t.run_date && t.run_time ? `${t.run_date} ${t.run_time}` : '未排期')
      )
      .join('\n')
  },

  get_task(args) {
    const id = Number(args.task_id)
    if (!Number.isFinite(id)) throw new Error('task_id 必须是数字。')
    const task = getTask(id)
    if (!task) throw new Error(`任务 ${id} 不存在。`)
    return [summarizeTask(task), describeLastRun(id)].join('\n')
  },

  get_run_result(args) {
    let logId: number | null = null
    if (args.log_id != null) {
      logId = Number(args.log_id)
    } else if (args.task_id != null) {
      const id = Number(args.task_id)
      const logs = listLogsForTask(id)
      if (!logs.length) return `任务 ${id} 还没有任何运行记录。`
      logId = logs[0].id
    } else {
      throw new Error('需要提供 task_id 或 log_id。')
    }
    const log = getLog(logId)
    if (!log) throw new Error(`运行记录 ${logId} 不存在。`)
    const lines = [
      `运行 #${log.id}（任务 #${log.task_id}${log.task_name ? ` ${log.task_name}` : ''}）`,
      `  状态：${log.status}`,
      `  后端：${log.agent_id ?? '未知'}`,
      `  开始：${log.started_at}${log.ended_at ? `  结束：${log.ended_at}` : ''}`,
      log.duration_ms != null ? `  耗时：${(log.duration_ms / 1000).toFixed(1)} 秒` : '',
      log.exit_code != null ? `  退出码：${log.exit_code}` : '',
      log.session_id ? `  会话：${log.session_id}` : '',
      log.error_message ? `  错误：${log.error_message}` : '',
      log.final_response ? `\n最终响应：\n${log.final_response}` : '\n（还没有最终响应）'
    ].filter(Boolean)
    if (log.status === 'running') lines.push('\n该运行仍在进行中，稍后再查。')
    return lines.join('\n')
  },

  run_task_now(args) {
    const id = Number(args.task_id)
    if (!Number.isFinite(id)) throw new Error('task_id 必须是数字。')
    const task = getTask(id)
    if (!task) throw new Error(`任务 ${id} 不存在。`)
    if (taskIsRunning(id)) {
      const logId = runningLogIdForTask(id)
      return `任务 ${id} 正在运行中${logId ? `（运行 #${logId}）` : ''}，未重复触发。可用 get_run_result(${id}) 查看进度。`
    }
    const note = spawnRunner(id, true)
    return [
      `任务 ${id}「${task.name}」${note}`,
      '这是异步执行：立刻返回，不阻塞。',
      '稍后用 get_run_result(' + id + ') 取最终响应。'
    ].join('\n')
  },

  async cancel_task(args) {
    const id = Number(args.task_id)
    if (!Number.isFinite(id)) throw new Error('task_id 必须是数字。')
    const task = getTask(id)
    if (!task) throw new Error(`任务 ${id} 不存在。`)
    const lines: string[] = []
    const logId = runningLogIdForTask(id)
    if (logId != null) {
      lines.push(cancelRun(logId) ? `已发出终止信号（运行 #${logId}）。` : `运行 #${logId} 无法取消（进程可能已结束）。`)
    } else {
      lines.push('该任务当前没有在运行的实例。')
    }
    setTaskStatus(id, 'cancelled')
    const del = await deleteScheduledTask(id)
    lines.push(del.ok ? '已清除计划任务，不会再自动触发。' : `清除计划任务失败：${del.message}`)
    lines.push('（任务本身保留，可用编辑功能重新排期。）')
    return lines.join('\n')
  },

  async delete_task(args) {
    const id = Number(args.task_id)
    if (!Number.isFinite(id)) throw new Error('task_id 必须是数字。')
    const task = getTask(id)
    if (!task) throw new Error(`任务 ${id} 不存在。`)
    if (taskIsRunning(id)) throw new Error(`任务 ${id} 正在运行中，请先 cancel_task 再删除。`)
    deleteTask(id)
    const del = await deleteScheduledTask(id)
    return `已删除任务 ${id}「${task.name}」及其运行记录。${del.ok ? '计划任务已清除。' : `（计划任务清除失败：${del.message}）`}`
  },

  list_projects() {
    const projects = listProjects()
    if (!projects.length) return '还没有任何项目。'
    return projects
      .map(
        (p) =>
          `#${p.id} ${p.name} · ${p.path} · ${p.is_git_repo ? 'git 仓库' : '非 git'}` +
          (p.agent_id ? ` · 默认后端 ${p.agent_id}` : '')
      )
      .join('\n')
  },

  create_project(args) {
    const p = args.path != null ? String(args.path).trim() : ''
    if (!p) throw new Error('path 不能为空（本地项目目录的绝对路径）。')
    if (!fs.existsSync(p)) throw new Error(`目录不存在：${p}`)
    const existing = listProjects().find((x) => x.path.toLowerCase() === p.toLowerCase())
    if (existing) return `该目录已有项目：#${existing.id} ${existing.name}`
    const name = args.name != null && String(args.name).trim() ? String(args.name).trim() : path.basename(p)
    const agentId = args.agent != null && String(args.agent).trim() ? String(args.agent).trim() : null
    if (agentId && !getAgent(agentId)) {
      throw new Error(`agent 后端「${agentId}」不存在。可用：${listAgents().map((a) => a.id).join('、')}`)
    }
    const created = createProject({ name, path: p, agent_id: agentId })
    return `已创建项目 #${created.id}「${created.name}」→ ${created.path}${created.agent_id ? `（默认后端 ${created.agent_id}）` : ''}`
  },

  list_agents() {
    const agents = listAgents()
    if (!agents.length) return '没有任何 agent 后端。'
    return agents
      .map((a) => {
        const bin = resolveAgentBin(a)
        return (
          `#${a.id} ${a.label}` +
          (a.enabled === 1 ? '' : '（已停用）') +
          ` · 可执行文件：${bin ?? '未找到'} · 提示词：${a.prompt_via} · 解析：${a.parser}` +
          (a.resume_args.length ? '' : ' · 不支持恢复会话')
        )
      })
      .join('\n')
  }
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_task',
    description:
      '创建一个定时任务：到指定时间，用指定的 agent 后端在某个项目目录里执行一段提示词。' +
      '这是「四点提醒我做某事」这类请求的落点。默认异步——创建后立刻返回，到点自动执行。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '交给 agent 执行的提示词内容' },
        name: { type: 'string', description: '任务名称；留空自动生成' },
        project: { type: 'string', description: '项目名称或 ID。只有一个项目时可省略。' },
        project_path: { type: 'string', description: '用本地目录指定项目；项目不存在时会自动创建。' },
        run_at: {
          type: 'string',
          description:
            '执行时间。支持 16:00（今天该时刻，已过则顺延到明天）、4:00 PM、2026-09-24T16:00、2026-09-24 16:00。不填则创建为未排期（只能手动触发）。'
        },
        run_date: { type: 'string', description: '执行日期 YYYY-MM-DD（需与 run_time 同时提供）' },
        run_time: { type: 'string', description: '执行时间 HH:MM（需与 run_date 同时提供）' },
        agent: {
          type: 'string',
          description: 'agent 后端 ID（如 codex、claude）。留空则用项目的默认后端，再回落到 codex。'
        },
        execution_mode: {
          type: 'string',
          enum: ['new_session', 'resume_session'],
          description: 'new_session = 开新会话（默认）；resume_session = 恢复既有会话，需同时给 session_id'
        },
        session_id: { type: 'string', description: '恢复会话时要接续的会话 ID' },
        wake: { type: 'boolean', description: '到点若计算机处于睡眠，是否唤醒它执行（默认 false）' },
        post_action: {
          type: 'string',
          enum: ['none', 'shutdown'],
          description: '执行完成后的动作。默认 none（不关机）。慎重使用 shutdown。'
        },
        quota_retry: { type: 'boolean', description: '若因用量限额中断，是否自动重排到限额恢复后重试' },
        retry_count: { type: 'integer', description: '普通失败自动重试次数（0-5）' },
        usb_backup: { type: 'boolean', description: '成功后是否把项目备份到 U 盘并弹出' },
        usb_copy_subdir: { type: 'string', description: '只备份项目下的这个子目录；留空备份整个项目' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_tasks',
    description: '列出调度器里的任务（含状态、排期、使用的后端）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['scheduled', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'missed'],
          description: '按状态过滤'
        },
        limit: { type: 'integer', description: '最多返回多少条，默认 20' }
      }
    }
  },
  {
    name: 'get_task',
    description: '查看单个任务的详情与最近一次运行结果。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'get_run_result',
    description: '获取某次运行的最终响应与结果。给 task_id 取该任务最近一次运行，或直接给 log_id。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: '任务 ID（取其最近一次运行）' },
        log_id: { type: 'integer', description: '运行记录 ID（精确指定某一次）' }
      }
    }
  },
  {
    name: 'run_task_now',
    description: '立即在后台执行一个任务（异步：立刻返回，不等待执行结束）。执行结果稍后用 get_run_result 取。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'cancel_task',
    description: '取消一个任务：终止正在运行的实例、清除它的 Windows 计划任务并标记为已取消（任务本身保留）。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    description: '彻底删除一个任务（连同它的运行记录与计划任务）。正在运行的任务需先 cancel_task。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'integer', description: '任务 ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'list_projects',
    description: '列出所有项目（本地目录）。任务必须挂在某个项目下。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_project',
    description: '把一个本地目录注册为项目。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地目录绝对路径' },
        name: { type: 'string', description: '项目名称；留空用目录名' },
        agent: { type: 'string', description: '该项目默认使用的 agent 后端 ID' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_agents',
    description: '列出可用的 agent 后端（codex / claude / 自定义等），含可执行文件是否就位。',
    inputSchema: { type: 'object', properties: {} }
  }
]

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMessage(msg: RpcMessage): Promise<void> {
  const { id, method } = msg
  const isRequest = id !== undefined && id !== null

  try {
    switch (method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_FALLBACK,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              '这是本地定时任务调度器。用户说「四点提醒我…」「明天下午三点让 Claude 处理 X」这类请求时，' +
              '用 create_task 建任务（用 run_at 传时间），它会异步执行。' +
              '建完后如需确认，用 get_task / get_run_result 查询；要立刻跑用 run_task_now；' +
              '查询可用后端用 list_agents，查询可用项目用 list_projects。' +
              '除非用户明确要求，不要设置 post_action=shutdown。'
          }
        })
        return
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
        return
      case 'tools/call': {
        const name = String(msg.params?.name ?? '')
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        const handler = HANDLERS[name]
        if (!handler) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `未知工具「${name}」。可用：${Object.keys(HANDLERS).join('、')}` }],
              isError: true
            }
          })
          return
        }
        try {
          const text = await handler(args)
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `错误：${(err as Error).message}` }],
              isError: true
            }
          })
        }
        return
      }
      default: {
        if (!isRequest) return // 未知通知：静默忽略
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `不支持的方法：${method}` }
        })
      }
    }
  } catch (err) {
    log('handler failed', (err as Error).message)
    if (isRequest) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: (err as Error).message }
      })
    }
  }
}

function main(): void {
  try {
    getDb()
  } catch (err) {
    log('数据库初始化失败', (err as Error).message)
  }
  log(`启动：${SERVER_NAME} v${SERVER_VERSION}（node ${process.version}）`)

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: RpcMessage
    try {
      msg = JSON.parse(trimmed) as RpcMessage
    } catch {
      log('收到无法解析的行，已忽略')
      return
    }
    void handleMessage(msg)
  })
  rl.on('close', () => {
    log('stdin 关闭，退出')
    process.exit(0)
  })
}

main()
