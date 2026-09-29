import type {
  AgentInput,
  AgentProfile,
  AgentStatus,
  DashboardData,
  ExecutionLog,
  Project,
  ProjectInput,
  Task,
  TaskInput
} from '../../shared/types'

export interface ScheduleResult {
  ok: boolean
  message: string
}

export interface TaskSaveResult {
  task: Task | null
  schedule: ScheduleResult | null
}

export interface Api {
  listProjects(): Promise<Project[]>
  getProject(id: number): Promise<Project | null>
  createProject(input: ProjectInput): Promise<Project>
  updateProject(id: number, input: ProjectInput): Promise<Project | null>
  deleteProject(id: number): Promise<void>

  listTasks(): Promise<Task[]>
  getTask(id: number): Promise<Task | null>
  createTask(input: TaskInput): Promise<TaskSaveResult>
  updateTask(id: number, input: TaskInput): Promise<TaskSaveResult>
  deleteTask(id: number): Promise<void>

  dashboard(): Promise<DashboardData>
  listLogs(): Promise<ExecutionLog[]>
  logsForTask(taskId: number): Promise<ExecutionLog[]>
  getLog(id: number): Promise<ExecutionLog | null>

  listAgents(): Promise<AgentProfile[]>
  agentStatuses(): Promise<AgentStatus[]>
  getAgent(id: string): Promise<AgentProfile | null>
  createAgent(input: AgentInput): Promise<AgentProfile>
  updateAgent(id: string, input: AgentInput): Promise<AgentProfile | null>
  deleteAgent(id: string): Promise<void>
  probeAgent(id: string): Promise<AgentStatus>

  activeRuns(): Promise<number[]>
  startRun(taskId: number): Promise<{ success: boolean; logId?: number; result?: string; exitCode?: number | null; error?: string }>
  cancelRun(logId: number): Promise<boolean>

  pickFolder(): Promise<string | null>

  onRunEvent(cb: (payload: { logId: number; stream: 'stdout' | 'stderr'; line: string }) => void): () => void
  onRunUpdated(cb: (payload: { logId: number }) => void): () => void
  onRunFinished(cb: (payload: { logId: number; result: string; exitCode: number | null }) => void): () => void
}

export const api: Api = (window as unknown as { api: Api }).api
