import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id: number) => ipcRenderer.invoke('projects:get', id),
  createProject: (input: unknown) => ipcRenderer.invoke('projects:create', input),
  updateProject: (id: number, input: unknown) => ipcRenderer.invoke('projects:update', id, input),
  deleteProject: (id: number) => ipcRenderer.invoke('projects:delete', id),

  // Tasks
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  getTask: (id: number) => ipcRenderer.invoke('tasks:get', id),
  createTask: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
  updateTask: (id: number, input: unknown) => ipcRenderer.invoke('tasks:update', id, input),
  deleteTask: (id: number) => ipcRenderer.invoke('tasks:delete', id),

  // Dashboard / Logs
  dashboard: () => ipcRenderer.invoke('dashboard'),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  logsForTask: (taskId: number) => ipcRenderer.invoke('logs:forTask', taskId),
  getLog: (id: number) => ipcRenderer.invoke('logs:get', id),

  // Agents
  listAgents: () => ipcRenderer.invoke('agents:list'),
  agentStatuses: () => ipcRenderer.invoke('agents:statuses'),
  getAgent: (id: string) => ipcRenderer.invoke('agents:get', id),
  createAgent: (input: unknown) => ipcRenderer.invoke('agents:create', input),
  updateAgent: (id: string, input: unknown) => ipcRenderer.invoke('agents:update', id, input),
  deleteAgent: (id: string) => ipcRenderer.invoke('agents:delete', id),
  probeAgent: (id: string) => ipcRenderer.invoke('agents:probe', id),

  // Runs
  activeRuns: () => ipcRenderer.invoke('runs:active'),
  startRun: (taskId: number) => ipcRenderer.invoke('runs:start', taskId),
  cancelRun: (logId: number) => ipcRenderer.invoke('runs:cancel', logId),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  // Events from main
  onRunEvent: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('run:event', handler)
    return () => ipcRenderer.removeListener('run:event', handler)
  },
  onRunUpdated: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('run:updated', handler)
    return () => ipcRenderer.removeListener('run:updated', handler)
  },
  onRunFinished: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('run:finished', handler)
    return () => ipcRenderer.removeListener('run:finished', handler)
  },

  // Window controls（frameless 自绘标题栏）
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
