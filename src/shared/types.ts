export type TaskStatus =
  | 'scheduled'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'missed'

export type ExecutionMode = 'new_session' | 'resume_session'

export type PostAction = 'none' | 'shutdown'

export type RunResult = 'running' | 'success' | 'failed' | 'cancelled'

// ---------------------------------------------------------------------------
// Agent backends
// ---------------------------------------------------------------------------

/** 提示词如何交给 CLI：走 stdin，还是当成最后一个参数追加。 */
export type PromptVia = 'stdin' | 'arg'

/**
 * stdout 的解析方式。不同 CLI 的事件流格式不同，用解析器区分：
 *  - codex-jsonl  ：codex exec --json（thread.started / item.agent_message / error）
 *  - claude-jsonl ：claude -p --output-format stream-json（system.init / result）
 *  - plain        ：不解析，整段 stdout 当作最终响应
 */
export type OutputParser = 'codex-jsonl' | 'claude-jsonl' | 'plain'

/**
 * 一个 agent 后端配置。
 *
 * 参数模板里可用的占位符：
 *   {cwd}             项目工作目录
 *   {model}           该次执行要用的模型（所在的那一组参数在模型为空时整组跳过）
 *   {lastMessageFile} 最终响应落盘路径；模板里出现它 = 该 CLI 支持把最终消息写文件
 *   {session}         会话 ID（仅 resume_args 有意义）
 */
export interface AgentProfile {
  id: string
  label: string
  /** 可执行文件路径或命令名。留空 = 自动探测（codex / claude 有内置探测规则）。 */
  bin: string
  new_args: string[]
  resume_args: string[]
  prompt_via: PromptVia
  parser: OutputParser
  /** 附加环境变量 */
  env: Record<string, string> | null
  /** 1 = 内置预设（参数可改，但不可删除） */
  builtin: number
  enabled: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AgentInput {
  id?: string
  label: string
  bin?: string | null
  new_args?: string[]
  resume_args?: string[]
  prompt_via?: PromptVia
  parser?: OutputParser
  env?: Record<string, string> | null
  enabled?: number
  notes?: string | null
}

/** 某个 agent 后端在本机的可用性探测结果。 */
export interface AgentStatus {
  id: string
  label: string
  /** 实际解析到的可执行文件路径；null = 未找到 */
  resolvedBin: string | null
  available: boolean
  version: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface Project {
  id: number
  name: string
  path: string
  default_session_id: string | null
  default_prompt: string | null
  is_git_repo: number
  /** 该项目下新建任务时默认使用的 agent 后端 */
  agent_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectInput {
  name: string
  path: string
  default_session_id?: string | null
  default_prompt?: string | null
  agent_id?: string | null
}

export interface Task {
  id: number
  project_id: number
  name: string
  run_date: string | null
  run_time: string | null
  prompt: string
  execution_mode: ExecutionMode
  session_id: string | null
  retry_count: number
  post_action: PostAction
  wake_enabled: number
  status: TaskStatus
  created_at: string
  updated_at: string
  last_run_at: string | null
  quota_retry: number
  quota_retry_count: number
  sleep_after_minutes: number
  /** 成功后刷新消息的自定义提示词；空 = 默认询问当前时间与 5 小时后时间 */
  followup_prompt: string | null
  /** 刷新执行使用的模型；空 = 不追加模型参数 */
  followup_model: string | null
  /** 成功后 5 小时自动发送一条刷新消息 */
  success_followup: number
  /** 内部标记：下一次执行是"成功后刷新"消息 */
  followup_pending: number
  /** 项目完成后自动备份到 U 盘 */
  usb_backup: number
  /** 只备份项目根下的这个子目录；空 = 整个项目目录 */
  usb_copy_subdir: string | null
  /** U 盘上的存放目录名（默认 codex）；可含子路径，如 codex/bak */
  usb_dest_folder: string | null
  /** 已消耗的通用失败重试次数；任务成功后归零 */
  retry_used: number
  /** 执行这个任务用哪个 agent 后端；空 = 用项目的默认值 */
  agent_id: string | null
  /** 实际会生效的后端（任务未指定时回落到项目默认值，再回落到 codex） */
  effective_agent_id?: string
  project_name?: string
  project_path?: string
  project_agent_id?: string | null
}

export interface TaskInput {
  project_id: number
  name: string
  run_date?: string | null
  run_time?: string | null
  prompt: string
  execution_mode: ExecutionMode
  session_id?: string | null
  retry_count?: number
  post_action?: PostAction
  wake_enabled?: number
  quota_retry?: number
  sleep_after_minutes?: number
  followup_prompt?: string | null
  followup_model?: string | null
  success_followup?: number
  usb_backup?: number
  usb_copy_subdir?: string | null
  usb_dest_folder?: string | null
  agent_id?: string | null
}

export interface ExecutionLog {
  id: number
  task_id: number
  project_id: number
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  exit_code: number | null
  status: RunResult
  final_response: string | null
  session_id: string | null
  changed_files: string | null
  git_diff_summary: string | null
  stdout_path: string | null
  stderr_path: string | null
  error_message: string | null
  /** 持有这次运行的进程 PID；用于区分"仍在运行"与"进程已死的中断残留" */
  pid: number | null
  /** 这次执行实际使用的 agent 后端 */
  agent_id: string | null
  task_name?: string
  project_name?: string
  project_path?: string
}

export interface DashboardData {
  nextTask: Task | null
  todayTasks: Task[]
  runningTasks: Task[]
  counts: {
    scheduled: number
    running: number
    completed: number
    failed: number
  }
  recentLogs: ExecutionLog[]
}

export interface RunEvent {
  logId: number
  stream: 'stdout' | 'stderr'
  line: string
}
