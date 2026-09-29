/**
 * Standalone task runner — runs without the Electron app.
 *
 *   node codex-runner.cjs --task 3
 *
 * Windows Task Scheduler invokes this at the scheduled time.
 */
import { executeTask } from '../shared/executor'
import { getDb, recoverInterruptedRuns, closeDb } from '../shared/db'

function parseTaskId(argv: string[]): number | null {
  const idx = argv.indexOf('--task')
  if (idx === -1 || !argv[idx + 1]) return null
  const id = Number(argv[idx + 1])
  return Number.isFinite(id) ? id : null
}

async function main(): Promise<number> {
  const taskId = parseTaskId(process.argv.slice(2))
  if (taskId === null) {
    console.error('用法：codex-runner --task <任务ID> [--force]')
    return 2
  }

  // 注意：本文件静态导入了 shared/db，而 db 静态导入 node:sqlite。若系统 node
  // 版本低于 22.5，崩溃会发生在模块加载阶段，这里捕获不到。因此 node 版本校验
  // 放在注册计划任务时（shared/scheduler.ts），在"保存任务"那一刻就报给用户。
  getDb() // ensure schema exists before reading the task
  const recovered = recoverInterruptedRuns()
  if (recovered) console.log(`[codex-runner] 已标记 ${recovered} 条中断的运行为失败`)

  // --force：人工触发（「立即运行」/ MCP 的 run_task_now）时跳过原子领取 ——
  // 这类触发面对的任务状态可能是 completed/failed，不该因为"不是 scheduled"被拒。
  const force = process.argv.includes('--force')
  console.log(`[codex-runner] 开始执行任务 ${taskId}${force ? '（人工触发，跳过领取）' : ''}`)
  const started = Date.now()
  const result = await executeTask(taskId, {
    // 计划任务触发属于调度触发：先原子领取，抢不到说明应用内调度器已经接手。
    claim: !force,
    onEvent: (event) => {
      // Keep the console output compact: codex JSONL lines can be very long.
      const trimmed = event.line.length > 300 ? event.line.slice(0, 300) + '…' : event.line
      process.stdout.write(`[${event.stream}] ${trimmed}\n`)
    }
  })

  if (result.skipped) {
    console.log(
      `[codex-runner] 任务 ${taskId} 当前状态已不是「已计划」（已被应用内调度器接手，或已执行/取消），本次不重复执行。`
    )
    closeDb()
    return 0
  }

  const duration = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`[codex-runner] 任务 ${taskId} 已结束：结果=${result.result} 退出码=${result.exitCode} 耗时 ${duration}s`)
  if (result.quotaRetryScheduled) {
    console.log(`[codex-runner] 已安排限额恢复后自动重试（${result.quotaResetAt} + 2 分钟），并更新 Windows 计划任务。`)
  }
  if (result.retryScheduled) {
    console.log('[codex-runner] 已安排失败自动重试（2 分钟后），并更新 Windows 计划任务。')
  }
  if (result.postAction) {
    console.log(`[codex-runner] 完成后动作：${result.postAction === 'shutdown' ? '60 秒后关机' : result.postAction}`)
  }
  closeDb()

  return result.result === 'success' ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[codex-runner] 致命错误：', err)
    process.exit(1)
  }
)
