import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listLogs,
  listLogsForTask,
  getLog,
  listRunningLogs,
  listTaskIdsForProject,
  isProcessAlive,
  dashboardData,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent
} from '../shared/db'
import { detectAgents, executeTask, cancelRun, activeRunLogIds } from '../shared/executor'
import { invalidateProbeCache, probeAgent } from '../shared/agents'
import { syncScheduledTask, deleteScheduledTask } from '../shared/scheduler'
import type { AgentInput, ProjectInput, TaskInput } from '../shared/types'

type GetWindow = () => BrowserWindow | null

function broadcast(win: GetWindow, channel: string, payload: unknown): void {
  const w = win()
  if (!w || w.isDestroyed()) return
  try {
    w.webContents.send(channel, payload)
  } catch {
    /* 窗口正在销毁，丢弃这一次推送即可 */
  }
}

/** 该任务是否真的有一个活着的进程在跑（跨进程，靠 pid 存活判断，不信残留记录）。 */
function taskIsBusy(taskId: number): boolean {
  return listRunningLogs().some((log) => log.task_id === taskId && isProcessAlive(log.pid))
}

export function registerIpc(getWindow: GetWindow): void {
  // --- Projects ---
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:get', (_e, id: number) => getProject(Number(id)))
  ipcMain.handle('projects:create', (_e, input: ProjectInput) => createProject(input))
  ipcMain.handle('projects:update', (_e, id: number, input: ProjectInput) => updateProject(Number(id), input))
  ipcMain.handle('projects:delete', async (_e, id: number) => {
    const projectId = Number(id)
    // 先清掉该项目下所有任务的 Windows 计划任务。项目删了、任务跟着级联删了，
    // 计划任务却还在，到点会启动 Runner 去跑一个不存在的任务——每次必然失败。
    for (const taskId of listTaskIdsForProject(projectId)) {
      await deleteScheduledTask(taskId)
    }
    deleteProject(projectId)
  })

  // --- Tasks ---
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:get', (_e, id: number) => getTask(Number(id)))
  ipcMain.handle('tasks:create', async (_e, input: TaskInput) => {
    const task = createTask(input)
    return { task, schedule: await syncScheduledTask(task) }
  })
  ipcMain.handle('tasks:update', async (_e, id: number, input: TaskInput) => {
    const task = updateTask(Number(id), input)
    return { task, schedule: task ? await syncScheduledTask(task) : null }
  })
  ipcMain.handle('tasks:delete', async (_e, id: number) => {
    deleteTask(Number(id))
    await deleteScheduledTask(Number(id))
  })

  // --- Dashboard / Logs ---
  ipcMain.handle('dashboard', () => dashboardData())
  ipcMain.handle('logs:list', () => listLogs(200))
  ipcMain.handle('logs:forTask', (_e, taskId: number) => listLogsForTask(Number(taskId)))
  ipcMain.handle('logs:get', (_e, id: number) => getLog(Number(id)))

  // --- Agents（后端配置与可用性探测） ---
  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('agents:statuses', () => detectAgents())
  ipcMain.handle('agents:get', (_e, id: string) => getAgent(String(id)))
  ipcMain.handle('agents:create', (_e, input: AgentInput) => {
    const created = createAgent(input)
    invalidateProbeCache()
    return created
  })
  ipcMain.handle('agents:update', (_e, id: string, input: AgentInput) => {
    const updated = updateAgent(String(id), input)
    invalidateProbeCache(String(id))
    return updated
  })
  ipcMain.handle('agents:delete', (_e, id: string) => {
    deleteAgent(String(id))
    invalidateProbeCache()
  })
  ipcMain.handle('agents:probe', async (_e, id: string) => {
    const agent = getAgent(String(id))
    if (!agent) throw new Error(`agent「${id}」不存在`)
    invalidateProbeCache(String(id))
    return probeAgent(agent)
  })

  // --- Runs ---
  ipcMain.handle('runs:active', () => activeRunLogIds())
  ipcMain.handle('runs:start', async (_e, taskId: number) => {
    const id = Number(taskId)
    // 防连点：手动触发不做原子领取（可以重跑已完成的任务），但同一任务
    // 同时只允许一个真实进程在跑，否则两个 codex 会同时改同一个项目目录。
    if (taskIsBusy(id)) {
      return { success: false, error: '该任务正在运行中，请等当前这次结束或先取消。' }
    }
    try {
      const result = await executeTask(id, {
        onEvent: (event) => broadcast(getWindow, 'run:event', event),
        onLogUpdate: (logId) => broadcast(getWindow, 'run:updated', { logId })
      })
      broadcast(getWindow, 'run:finished', result)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('runs:cancel', (_e, logId: number) => cancelRun(Number(logId)))

  // --- Native dialogs ---
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
