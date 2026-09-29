/**
 * 应用内准点调度器：应用开着时，每 20 秒检查一次数据库里到点（且状态为
 * scheduled）的任务并触发执行。不依赖 Windows 计划服务 —— 解决计划任务
 * 在部分环境下无法注册/不加载导致“到点不跑、显示已错过”的问题。
 *
 * 与 Windows 计划任务的关系：两者会在同一分钟各自触发同一个任务，因此这里
 * 一律通过 executeTask({ claim: true }) 走"原子领取"——抢到 scheduled 的那个
 * 触发源才真正执行，另一个直接放弃，避免同一任务被并发跑两次。
 *
 * 限额重试 / 成功后刷新：由 Runner 在每次执行结束后自动重排（更新 run_date/
 * run_time/status），本调度器只需照常轮询即可。
 */
import { listSchedulableTasks, setTaskStatus } from '../shared/db'
import { executeTask } from '../shared/executor'
import type { Task } from '../shared/types'

let timer: NodeJS.Timeout | null = null
let ticking = false
const runningTaskIds = new Set<number>()

function taskDueAt(task: Task, now: Date): boolean {
  if (!task.run_date || !task.run_time) return false
  if (task.status !== 'scheduled') return false
  const due = new Date(`${task.run_date}T${task.run_time}:00`)
  if (Number.isNaN(due.getTime())) return false
  // 到点后 10 分钟内视为有效（避免“已错过”误判），超过则标记 missed
  return due.getTime() <= now.getTime() && now.getTime() - due.getTime() < 10 * 60_000
}

function markMissed(task: Task, now: Date): void {
  if (!task.run_date || !task.run_time || task.status !== 'scheduled') return
  const due = new Date(`${task.run_date}T${task.run_time}:00`)
  if (!Number.isNaN(due.getTime()) && now.getTime() - due.getTime() >= 10 * 60_000) {
    setTaskStatus(task.id, 'missed')
    console.log(`[app-scheduler] 任务 ${task.id} 已错过（${task.run_date} ${task.run_time}）`)
  }
}

async function tick(): Promise<void> {
  // 上一轮还在等某个任务跑完时，不要再叠一轮：executeTask 可能持续数小时。
  if (ticking) return
  ticking = true
  try {
    const now = new Date()
    for (const task of listSchedulableTasks()) {
      if (runningTaskIds.has(task.id)) continue
      if (taskDueAt(task, now)) {
        runningTaskIds.add(task.id)
        console.log(`[app-scheduler] 触发任务 ${task.id}「${task.name}」`)
        try {
          const result = await executeTask(task.id, {
            claim: true,
            onLogUpdate: () => {}
          })
          if (result.skipped) {
            console.log(`[app-scheduler] 任务 ${task.id} 已被其它触发源（计划任务）领取，跳过。`)
          } else {
            console.log(
              `[app-scheduler] 任务 ${task.id} 完成: ${result.result} exit=${result.exitCode}` +
                (result.quotaRetryScheduled ? '（已安排限额重试）' : '') +
                (result.retryScheduled ? '（已安排失败重试）' : '') +
                (result.postAction ? ` postAction=${result.postAction}` : '')
            )
          }
        } catch (err) {
          console.error(`[app-scheduler] 任务 ${task.id} 执行异常:`, err)
        } finally {
          runningTaskIds.delete(task.id)
        }
      } else {
        markMissed(task, now)
      }
    }
  } finally {
    ticking = false
  }
}

export function startAppScheduler(): void {
  if (timer) return
  console.log('[app-scheduler] 应用内准点调度已启动（每 20 秒检查一次）')
  void tick()
  timer = setInterval(() => void tick(), 20_000)
}

export function stopAppScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
