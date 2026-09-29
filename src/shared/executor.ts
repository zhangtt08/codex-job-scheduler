/**
 * 任务执行器（agent 无关）。
 *
 * 这里只负责「跑一次任务」的通用流程：领取 → 预检 → 快照 → spawn agent → 收输出
 * → 落库 → 后续动作。具体调哪个 CLI、怎么传参、怎么解析输出，全部由 AgentProfile
 * 决定（见 shared/agents.ts）。因此新增/更换 agent 后端不需要动这个文件。
 */
import { spawn, ChildProcess, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import {
  effectiveAgentId,
  getAgent,
  getDb,
  getTask,
  createLog,
  updateLog,
  setTaskStatus,
  setTaskLastRun,
  rescheduleTaskForQuotaRetry,
  rescheduleTaskForRetry,
  resetRetryUsed,
  scheduleFollowup,
  refreshGitFlag,
  claimScheduledTask,
  listEnabledAgents,
  listRunningLogs,
  isProcessAlive
} from './db'
import { logDirForRun } from './paths'
import { syncScheduledTask } from './scheduler'
import { backupProjectToUsb, ejectDrive } from './usb'
import {
  buildAgentInvocation,
  createOutputAccumulator,
  finalizePlainResponse,
  parseAgentLine,
  probeAgent,
  type Invocation
} from './agents'
import type { AgentStatus, RunEvent, RunResult } from './types'

export { parseQuotaResetAt } from './agents'

// ---------------------------------------------------------------------------
// Agent availability
// ---------------------------------------------------------------------------

/** 探测所有已启用后端的可用性，供 UI 显示与任务保存时校验。 */
export async function detectAgents(): Promise<AgentStatus[]> {
  const agents = listEnabledAgents()
  return Promise.all(agents.map((a) => probeAgent(a)))
}

// ---------------------------------------------------------------------------
// Query helpers (shared by IPC and the MCP server)
// ---------------------------------------------------------------------------

/**
 * 该任务是否真的有一个活着的进程在跑。
 * 跨进程判断，靠 pid 存活而不是 DB 里的 status —— 残留的 running 记录不算数。
 */
export function taskIsRunning(taskId: number): boolean {
  return listRunningLogs().some((log) => log.task_id === taskId && isProcessAlive(log.pid))
}

/** 该任务正在运行的那条 log id；没有则返回 null。 */
export function runningLogIdForTask(taskId: number): number | null {
  const hit = listRunningLogs()
    .filter((log) => log.task_id === taskId && isProcessAlive(log.pid))
    .pop()
  return hit ? hit.id : null
}

// ---------------------------------------------------------------------------
// Git snapshot helpers
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, timeout: 20000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function gitSnapshot(dir: string, isRepo: boolean): Promise<{ changed: string | null; diff: string | null }> {
  if (!isRepo) return { changed: null, diff: null }
  const status = await git(dir, ['status', '--porcelain'])
  const diff = await git(dir, ['diff', '--stat'])
  return { changed: status, diff }
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

/** 连子进程一起杀掉。Windows 上用 taskkill /T，其它平台先试进程组。 */
export function killProcessTree(pid: number | undefined | null): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-Number(pid), 'SIGKILL')
    } catch {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run registry (for cancellation from the UI)
// ---------------------------------------------------------------------------

const running = new Map<number, ChildProcess>()
/** 被用户主动取消的运行。不能用 child.killed —— 外部 taskkill 不会置位它。 */
const cancelledLogIds = new Set<number>()

export function cancelRun(logId: number): boolean {
  const child = running.get(logId)
  if (!child || child.pid === undefined) return false
  cancelledLogIds.add(logId)
  killProcessTree(child.pid)
  return true
}

export function activeRunLogIds(): number[] {
  return [...running.keys()]
}

/** 单次执行的最大时长；超过则强制结束，避免 CLI 挂住导致任务永远停在"运行中"。 */
function maxRunMs(): number {
  const raw = Number(process.env.CODEX_SCHEDULER_MAX_RUN_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

export interface ExecuteCallbacks {
  onEvent?: (event: RunEvent) => void
  onLogUpdate?: (logId: number) => void
  /**
   * 由调度器（应用内调度器 / 计划任务 Runner）触发时置 true：
   * 先原子领取任务，抢不到就说明另一个触发源已经在跑，直接放弃。
   * 「立即运行」这类人工触发不要开启。
   */
  claim?: boolean
}

export interface ExecuteResult {
  logId: number
  result: RunResult
  exitCode: number | null
  quotaRetryScheduled: boolean
  quotaResetAt: string | null
  postAction: string | null
  /** 已安排普通失败重试 */
  retryScheduled?: boolean
  /** 未执行：任务已被另一个进程/触发源领取 */
  skipped?: boolean
}

function localDateParts(d: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

function runPostAction(action: string): void {
  if (action === 'shutdown') {
    // 60 秒缓冲后关机，取消窗口：shutdown /a
    spawn('shutdown', ['/s', '/t', '60', '/c', 'Codex Job Scheduler: task finished'], {
      detached: true,
      windowsHide: true
    }).unref()
  }
}

/** 关闭写流并等待落盘；流报错或超时也不会卡住调用方。 */
function closeStream(s: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 3000)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      if (s.writableEnded || s.destroyed) {
        clearTimeout(timer)
        finish()
        return
      }
      s.end(() => {
        clearTimeout(timer)
        finish()
      })
    } catch {
      clearTimeout(timer)
      finish()
    }
  })
}

function readLastMessage(file: string | null): string | null {
  if (!file) return null
  try {
    return fs.readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * Runs one task end-to-end. Used by the Electron main process ("Run Now"),
 * by the app scheduler, and by the standalone runner binary.
 */
export async function executeTask(taskId: number, callbacks: ExecuteCallbacks = {}): Promise<ExecuteResult> {
  const emit = (logId: number, stream: RunEvent['stream'], line: string) =>
    callbacks.onEvent?.({ logId, stream, line })

  // 0. 调度触发时的跨进程互斥。应用内调度器与 Windows 计划任务会在同一分钟
  //    各自触发，若不加锁同一个任务会被并发跑两次（两个 agent 同改一个项目目录）。
  if (callbacks.claim) {
    // 先确认任务存在：任务不存在时 claim 同样是"改到 0 行"，会被误判成
    // "已被别的触发源抢走"，把"任务不存在"洗成一次安静的跳过。
    const current = getTask(taskId)
    if (!current) throw new Error(`任务 ${taskId} 不存在`)
    if (!claimScheduledTask(taskId)) {
      // 任务在，但状态已不是 scheduled —— 另一个触发源已接手，或它已被处理过。
      return {
        logId: -1,
        result: 'cancelled',
        exitCode: null,
        quotaRetryScheduled: false,
        quotaResetAt: null,
        postAction: null,
        skipped: true
      }
    }
  }

  const task = getTask(taskId)
  if (!task) throw new Error(`任务 ${taskId} 不存在`)

  // 1. 解析这次执行用哪个 agent 后端。
  const agentId = effectiveAgentId(task)
  const profile = getAgent(agentId)
  const startedAt = Date.now()

  const failWithLog = async (logId: number, message: string): Promise<ExecuteResult> => {
    updateLog(logId, { status: 'failed', ended_at: new Date().toISOString(), error_message: message })
    setTaskStatus(taskId, 'failed')
    callbacks.onLogUpdate?.(logId)
    emit(logId, 'stderr', message)
    return { logId, result: 'failed', exitCode: null, quotaRetryScheduled: false, quotaResetAt: null, postAction: null }
  }

  const logId = createLog(taskId, task.project_id, new Date().toISOString(), process.pid, agentId)
  callbacks.onLogUpdate?.(logId)
  setTaskStatus(taskId, 'preparing')

  if (!profile) {
    return failWithLog(logId, `任务配置的 agent 后端「${agentId}」不存在或已被删除，请到 Agent 设置里重新指定。`)
  }
  if (profile.enabled !== 1) {
    return failWithLog(logId, `agent 后端「${profile.label}」已被停用，请先启用或改选其它后端。`)
  }

  // 本次执行使用的提示词：
  //  - 普通执行 / 限额重试：一律用原任务提示词（限额中断 = 项目没做完，继续做）
  //  - 成功后刷新（followup）：用「刷新提示词」（未填则默认询问当前时间与 5 小时后时间）
  const isFollowupRun = task.followup_pending === 1
  let effectivePrompt = task.prompt
  if (isFollowupRun) {
    effectivePrompt =
      task.followup_prompt?.trim() || '请告诉我现在的中国北京时间（含日期），以及 5 小时后是什么时间。'
    getDb().prepare('UPDATE tasks SET followup_pending = 0 WHERE id = ?').run(taskId)
  }

  const wantResume = task.execution_mode === 'resume_session'
  if (wantResume && !task.session_id) {
    return failWithLog(logId, '执行模式为「恢复会话」，但该任务没有配置 Session ID。')
  }
  if (wantResume && !profile.resume_args.length) {
    return failWithLog(
      logId,
      `agent 后端「${profile.label}」没有配置恢复会话的参数，无法使用「恢复会话」模式。请改用「新建会话」，或在 Agent 设置里补上 resume 参数。`
    )
  }

  // 2. Validate the project directory.
  const projectDir = task.project_path
  if (!projectDir || !fs.existsSync(projectDir)) {
    return failWithLog(logId, `项目目录不存在：${projectDir}`)
  }

  // 3. 组装命令行。
  const dir = logDirForRun(logId)
  fs.mkdirSync(dir, { recursive: true })
  const stdoutPath = path.join(dir, 'stdout.jsonl')
  const stderrPath = path.join(dir, 'stderr.log')
  const finalPath = path.join(dir, 'final-response.md')

  let invocation: Invocation
  try {
    invocation = buildAgentInvocation(
      profile,
      {
        cwd: projectDir,
        // 刷新执行用低档模型省额度；普通执行不传，交给 CLI 自己的默认值。
        model: isFollowupRun ? (task.followup_model ?? '').trim() || null : null,
        lastMessageFile: finalPath,
        sessionId: wantResume ? task.session_id : null
      },
      wantResume ? 'resume' : 'new'
    )
  } catch (err) {
    return failWithLog(logId, (err as Error).message)
  }

  const isRepo = refreshGitFlag(task.project_id)

  // 4. Git safety snapshot before the run (record only, never mutate).
  const before = await gitSnapshot(projectDir, isRepo)
  emit(logId, 'stdout', `[agent:${profile.label}] 执行前 git 状态：\n${before.changed ?? '（工作区干净）'}`)

  // 5. Spawn the agent CLI inside the project directory.
  setTaskStatus(taskId, 'running')

  // 用写流而不是 writeSync：CLI 可能输出大量行，同步写会阻塞事件循环，
  // 反过来把子进程的管道憋住。
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' })
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'w' })
  stdoutStream.on('error', () => {})
  stderrStream.on('error', () => {})

  const finalArgs = [...invocation.args]
  if (invocation.promptAsArg) finalArgs.push(effectivePrompt)

  emit(
    logId,
    'stdout',
    `[agent:${profile.label}] ${invocation.bin} ${finalArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}` +
      (invocation.promptAsArg ? '' : ' <提示词经 stdin 传入>')
  )

  const acc = createOutputAccumulator()
  let stderrTail = ''

  const child = spawn(invocation.bin, finalArgs, {
    cwd: projectDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: invocation.env,
    shell: invocation.shell
  })
  running.set(logId, child)

  // 管道上的 'error' 必须有人接。CLI 若因参数错误瞬间退出，往 stdin 写会触发
  // EPIPE；没有监听器时 EventEmitter 会抛出未捕获异常，直接打崩 Electron 主进程。
  child.stdin?.on('error', () => {})
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})

  if (!invocation.promptAsArg) {
    // Prompt goes over stdin: no command-line length or quoting concerns.
    try {
      child.stdin?.write(effectivePrompt)
      child.stdin?.end()
    } catch {
      /* 子进程已退出，忽略；退出码会说明问题 */
    }
  } else {
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
  }

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    stdoutStream.write(line + '\n')
    emit(logId, 'stdout', line)
    parseAgentLine(profile.parser, line, acc)
  })

  const rlErr = createInterface({ input: child.stderr! })
  rlErr.on('line', (line) => {
    stderrStream.write(line + '\n')
    stderrTail = (stderrTail + line + '\n').slice(-8000)
    emit(logId, 'stderr', line)
  })

  // 6. Wait for completion.
  // Windows 上进程被强杀时 spawn 的 'close' 有时不派发，只有 'exit'。
  // 双事件 + 轮询进程存在性 + 超时上限兜底，确保绝不永久挂起（否则调度器会死锁）。
  const limit = maxRunMs()
  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false
    let timedOut = false
    let probe: NodeJS.Timeout | undefined
    let limitTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      if (probe) clearInterval(probe)
      if (limitTimer) clearTimeout(limitTimer)
      if (graceTimer) clearTimeout(graceTimer)
      resolve(code)
    }
    child.on('error', (err) => {
      emit(logId, 'stderr', `[agent] 启动进程失败：${err.message}`)
      finish(-1)
    })
    child.on('close', (code) => finish(code))
    child.on('exit', (code) => finish(code))

    // 兜底 A：进程已不存在但事件丢失。
    probe = setInterval(() => {
      if (settled) return
      let alive = false
      try {
        process.kill(child.pid!, 0)
        alive = true
      } catch {
        alive = false
      }
      if (!alive) {
        emit(logId, 'stderr', '[agent] 检测到子进程已消失（事件丢失），按异常退出处理。')
        finish(-1)
      }
    }, 5000)

    // 兜底 B：总时长上限。超时先杀进程树，10 秒宽限后仍未收到退出事件就强制收尾。
    limitTimer = setTimeout(() => {
      if (settled || timedOut) return
      timedOut = true
      emit(
        logId,
        'stderr',
        `[agent] 执行已超过上限 ${(limit / 3600000).toFixed(1)} 小时，正在强制终止子进程。`
      )
      killProcessTree(child.pid)
    }, limit)
    graceTimer = setTimeout(() => {
      if (settled) return
      emit(logId, 'stderr', '[agent] 进程未在宽限期内退出，强制收尾。')
      finish(-2)
    }, limit + 10_000)
  })

  rl.close()
  rlErr.close()
  await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)])
  running.delete(logId)
  const wasCancelled = cancelledLogIds.delete(logId)

  let result: RunResult = 'failed'
  if (wasCancelled) result = 'cancelled'
  else if (exitCode === 0) result = 'success'

  // 7. Collect results. 最终响应优先级：CLI 落盘文件 > 事件流解析 > 纯文本全文
  let finalResponse = readLastMessage(invocation.lastMessageFile)
  if (!finalResponse) finalResponse = acc.finalResponse ?? null
  if (!finalResponse && profile.parser === 'plain') finalResponse = finalizePlainResponse(acc.rawLines)

  const after = await gitSnapshot(projectDir, isRepo)
  if (!acc.changedFiles.size && after.changed) {
    for (const line of after.changed.split('\n')) {
      const file = line.slice(3).trim()
      if (file) acc.changedFiles.add(file)
    }
  }

  const endedAt = new Date().toISOString()
  updateLog(logId, {
    status: result,
    ended_at: endedAt,
    duration_ms: Date.now() - startedAt,
    exit_code: exitCode,
    final_response: finalResponse,
    session_id: acc.sessionId ?? task.session_id ?? null,
    changed_files: acc.changedFiles.size ? JSON.stringify([...acc.changedFiles]) : null,
    git_diff_summary: after.diff ?? after.changed,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    agent_id: agentId,
    error_message:
      result === 'failed'
        ? exitCode === -2
          ? `执行超时（超过 ${(limit / 3600000).toFixed(1)} 小时），已被强制终止。`
          : acc.lastError ?? (stderrTail.trim().slice(-2000) || `${profile.label} 以退出码 ${exitCode} 结束`)
        : null
  })

  if (result === 'success') {
    setTaskStatus(taskId, 'completed')
    setTaskLastRun(taskId, acc.sessionId ?? null)
    resetRetryUsed(taskId)
  } else if (result === 'cancelled') {
    setTaskStatus(taskId, 'cancelled')
  } else {
    setTaskStatus(taskId, 'failed')
  }
  callbacks.onLogUpdate?.(logId)

  // 8a. 限额自动重试：失败原因是用量限额时，把任务重排到恢复时间约 2 分钟后，
  // 并重新注册 Windows 计划任务（沿用唤醒设置），应用关着也能到点执行。
  let quotaRetryScheduled = false
  if (result === 'failed' && task.quota_retry === 1 && acc.quotaResetAt && task.quota_retry_count < 10) {
    const retryAt = new Date(acc.quotaResetAt.getTime() + 2 * 60 * 1000)
    if (retryAt.getTime() <= Date.now()) retryAt.setTime(Date.now() + 2 * 60 * 1000)
    const parts = localDateParts(retryAt)
    rescheduleTaskForQuotaRetry(taskId, parts.date, parts.time)
    const refreshed = getTask(taskId)
    if (refreshed) await syncScheduledTask(refreshed)
    quotaRetryScheduled = true
    emit(
      logId,
      'stdout',
      `[agent] 检测到用量限额（${acc.quotaResetAt.toLocaleString()} 恢复），已自动重排到 ${parts.date} ${parts.time} 执行。`
    )
  }

  // 8a2. 普通失败重试：任务配置了「重试次数」时，失败后 2 分钟自动重跑，
  // 直到用完额度或任务成功（成功后 retry_used 归零）。
  let retryScheduled = false
  if (
    result === 'failed' &&
    !quotaRetryScheduled &&
    task.retry_count > 0 &&
    (task.retry_used ?? 0) < task.retry_count
  ) {
    const parts = localDateParts(new Date(Date.now() + 2 * 60 * 1000))
    rescheduleTaskForRetry(taskId, parts.date, parts.time)
    const refreshed = getTask(taskId)
    if (refreshed) await syncScheduledTask(refreshed)
    retryScheduled = true
    emit(
      logId,
      'stdout',
      `[agent] 执行失败，已安排第 ${(task.retry_used ?? 0) + 1}/${task.retry_count} 次自动重试：${parts.date} ${parts.time}。`
    )
  }

  // 8b. U 盘备份（可选）：项目完成后把最新项目文件拷贝到 U 盘。
  // 未插 U 盘时最多等 3 轮（每轮 20 秒），仍没有则跳过并记录。
  if (result === 'success' && task.usb_backup === 1) {
    emit(logId, 'stdout', '[agent] 项目已完成，开始备份到 U 盘…')
    const projectName = task.project_name ?? `project-${task.project_id}`
    let backup = await backupProjectToUsb(projectDir, projectName, task.usb_copy_subdir, task.usb_dest_folder)
    for (let attempt = 2; attempt <= 3 && !backup.ok && backup.noDrive; attempt++) {
      emit(logId, 'stdout', `[agent] ${backup.message}，20 秒后重试（${attempt}/3）…`)
      await new Promise((r) => setTimeout(r, 20000))
      backup = await backupProjectToUsb(projectDir, projectName, task.usb_copy_subdir, task.usb_dest_folder)
    }
    emit(logId, 'stdout', `[agent] U 盘备份：${backup.message}`)
    if (backup.ok && backup.drive) {
      const eject = await ejectDrive(backup.drive)
      emit(logId, 'stdout', `[agent] ${eject.message}，可以安全拔出。`)
    }
  }

  // 8c. 成功后刷新（可选）：任务完成后 5 小时自动发一条轻量消息，
  // 用于开启下一个限额窗口。刷新执行本身不再级联安排新的刷新。
  let followupScheduled = false
  if (result === 'success' && task.success_followup === 1 && !isFollowupRun) {
    const at = new Date(Date.now() + 5 * 60 * 60 * 1000)
    const parts = localDateParts(at)
    scheduleFollowup(taskId, parts.date, parts.time)
    const refreshed = getTask(taskId)
    if (refreshed) await syncScheduledTask(refreshed)
    followupScheduled = true
    emit(logId, 'stdout', `[agent] 任务已完成，已安排 ${parts.date} ${parts.time} 自动发送刷新消息。`)
  }

  // 8d. Post Action：
  //  - 刷新执行成功 = agent 正常回答了消息 = 限额窗口已往后延续 5 小时，
  //    且没有其它待办 → 直接关机收尾。
  //  - 有其它后续安排（限额重试/普通重试/新刷新）时：绝不关机（从关机唤醒不可靠），保持运行等待下一轮。
  //  - 没有后续安排的普通执行：按用户选择的动作执行（默认关机）。
  let postActionResult: string | null = null
  const hasPendingWork = quotaRetryScheduled || retryScheduled || followupScheduled
  if (isFollowupRun && result === 'success') {
    runPostAction('shutdown')
    postActionResult = 'shutdown'
    emit(logId, 'stdout', '[agent] 刷新消息已确认（限额窗口已往后延续 5 小时），60 秒后自动关机（shutdown /a 可取消）。')
  } else if (hasPendingWork && task.post_action === 'shutdown') {
    emit(logId, 'stdout', '[agent] 仍有后续安排，已忽略「关机」动作，保持运行等待下一轮（避免关机后无法继续）。')
  } else if (!hasPendingWork && task.post_action && task.post_action !== 'none') {
    runPostAction(task.post_action)
    postActionResult = task.post_action
  }

  return {
    logId,
    result,
    exitCode,
    quotaRetryScheduled,
    quotaResetAt: acc.quotaResetAt?.toISOString() ?? null,
    postAction: postActionResult,
    retryScheduled
  }
}
