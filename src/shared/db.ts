import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { DB_PATH, LOGS_DIR } from './paths'
import { BUILTIN_AGENT_PRESETS, DEFAULT_AGENT_ID } from './agents'
import { localDateString } from './runat'
import type {
  AgentInput,
  AgentProfile,
  DashboardData,
  ExecutionLog,
  OutputParser,
  Project,
  ProjectInput,
  RunResult,
  Task,
  TaskInput
} from './types'

let db: DatabaseSync | null = null

/** SQLite 写锁冲突时的等待上限。Electron 主进程与独立 Runner 会并发写同一个库。 */
const BUSY_TIMEOUT_MS = 15000

export function getDb(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(LOGS_DIR, { recursive: true })
  let handle: DatabaseSync
  try {
    handle = new DatabaseSync(DB_PATH, { timeout: BUSY_TIMEOUT_MS })
  } catch {
    handle = new DatabaseSync(DB_PATH)
  }
  // 关键：应用（主进程）和 Runner（独立进程）会同时读写同一个数据库文件。
  // 不设 busy_timeout 时并发写会立刻抛 SQLITE_BUSY，表现为「日志/状态莫名丢失、
  // 任务随机失败」。WAL 模式下多进程读写是支持的，配合 busy_timeout 即可。
  handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  handle.exec('PRAGMA foreign_keys = ON;')
  handle.exec('PRAGMA journal_mode = WAL;')
  handle.exec('PRAGMA synchronous = NORMAL;')
  // 注意：不要设置 wal_autocheckpoint = 1。逐页 checkpoint 会让每次写入都争抢
  // 文件锁，反而放大并发冲突。WAL + synchronous=NORMAL 已足够兼顾性能与安全。
  db = handle
  ensureSchema(db)
  return db
}

export function closeDb(): void {
  if (!db) return
  try {
    db.close()
  } catch {
    /* already closed */
  }
  db = null
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      default_session_id TEXT,
      default_prompt TEXT,
      is_git_repo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      run_date TEXT,
      run_time TEXT,
      prompt TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'new_session',
      session_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      post_action TEXT NOT NULL DEFAULT 'none',
      wake_enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      final_response TEXT,
      session_id TEXT,
      changed_files TEXT,
      git_diff_summary TEXT,
      stdout_path TEXT,
      stderr_path TEXT,
      error_message TEXT,
      pid INTEGER,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      bin TEXT NOT NULL DEFAULT '',
      new_args TEXT NOT NULL DEFAULT '[]',
      resume_args TEXT NOT NULL DEFAULT '[]',
      prompt_via TEXT NOT NULL DEFAULT 'stdin',
      parser TEXT NOT NULL DEFAULT 'plain',
      env TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  migrateColumns(db)
  seedBuiltinAgents(db)
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

function migrateColumns(db: DatabaseSync): void {
  addColumn(db, 'tasks', 'quota_retry', 'quota_retry INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'quota_retry_count', 'quota_retry_count INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'sleep_after_minutes', 'sleep_after_minutes INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'retry_prompt', 'retry_prompt TEXT')
  addColumn(db, 'tasks', 'followup_prompt', 'followup_prompt TEXT')
  addColumn(db, 'tasks', 'followup_model', "followup_model TEXT NOT NULL DEFAULT 'gpt-5.6-luna'")
  addColumn(db, 'tasks', 'usb_backup', 'usb_backup INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'usb_copy_subdir', 'usb_copy_subdir TEXT')
  addColumn(db, 'tasks', 'usb_dest_folder', "usb_dest_folder TEXT NOT NULL DEFAULT 'codex'")
  addColumn(db, 'tasks', 'success_followup', 'success_followup INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'followup_pending', 'followup_pending INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'retry_used', 'retry_used INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'tasks', 'agent_id', 'agent_id TEXT')
  addColumn(db, 'projects', 'agent_id', 'agent_id TEXT')
  addColumn(db, 'execution_logs', 'pid', 'pid INTEGER')
  addColumn(db, 'execution_logs', 'agent_id', 'agent_id TEXT')
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function serializeArgs(v: string[] | null | undefined): string {
  return JSON.stringify(Array.isArray(v) ? v : [])
}

function parseArgs(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseEnv(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

function rowToAgent(row: Record<string, unknown>): AgentProfile {
  return {
    id: String(row.id),
    label: String(row.label),
    bin: typeof row.bin === 'string' ? row.bin : '',
    new_args: parseArgs(row.new_args),
    resume_args: parseArgs(row.resume_args),
    prompt_via: row.prompt_via === 'arg' ? 'arg' : 'stdin',
    parser: (row.parser === 'codex-jsonl' || row.parser === 'claude-jsonl' ? row.parser : 'plain') as OutputParser,
    env: parseEnv(row.env),
    builtin: Number(row.builtin ?? 0),
    enabled: Number(row.enabled ?? 1),
    notes: typeof row.notes === 'string' ? row.notes : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  }
}

/** 首次运行时把内置预设写进库；已存在的记录不动（用户改过的参数不会被覆盖）。 */
function seedBuiltinAgents(db: DatabaseSync): void {
  const t = now()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agents
      (id, label, bin, new_args, resume_args, prompt_via, parser, env, builtin, enabled, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?)`
  )
  for (const p of BUILTIN_AGENT_PRESETS) {
    insert.run(
      p.id,
      p.label,
      p.bin,
      serializeArgs(p.new_args),
      serializeArgs(p.resume_args),
      p.prompt_via,
      p.parser,
      p.notes,
      t,
      t
    )
  }
}

export function listAgents(): AgentProfile[] {
  const rows = getDb().prepare('SELECT * FROM agents ORDER BY builtin DESC, id').all() as unknown as Array<
    Record<string, unknown>
  >
  return rows.map(rowToAgent)
}

export function listEnabledAgents(): AgentProfile[] {
  return listAgents().filter((a) => a.enabled === 1)
}

export function getAgent(id: string): AgentProfile | undefined {
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as
    | Record<string, unknown>
    | undefined
  return row ? rowToAgent(row) : undefined
}

export function createAgent(input: AgentInput): AgentProfile {
  const id = (input.id?.trim() || `custom-${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._-]/g, '-')
  if (getAgent(id)) throw new Error(`agent「${id}」已存在`)
  const t = now()
  getDb()
    .prepare(
      `INSERT INTO agents (id, label, bin, new_args, resume_args, prompt_via, parser, env, builtin, enabled, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.label,
      input.bin ?? '',
      serializeArgs(input.new_args),
      serializeArgs(input.resume_args),
      input.prompt_via === 'arg' ? 'arg' : 'stdin',
      input.parser ?? 'plain',
      input.env ? JSON.stringify(input.env) : null,
      input.enabled ?? 1,
      input.notes ?? null,
      t,
      t
    )
  return getAgent(id)!
}

export function updateAgent(id: string, input: AgentInput): AgentProfile | undefined {
  const existing = getAgent(id)
  if (!existing) return undefined
  getDb()
    .prepare(
      `UPDATE agents SET label = ?, bin = ?, new_args = ?, resume_args = ?, prompt_via = ?, parser = ?, env = ?, enabled = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      input.label ?? existing.label,
      input.bin ?? '',
      serializeArgs(input.new_args ?? existing.new_args),
      serializeArgs(input.resume_args ?? existing.resume_args),
      input.prompt_via ?? existing.prompt_via,
      input.parser ?? existing.parser,
      input.env ? JSON.stringify(input.env) : null,
      input.enabled ?? existing.enabled,
      input.notes ?? existing.notes,
      now(),
      id
    )
  return getAgent(id)
}

export function deleteAgent(id: string): void {
  const existing = getAgent(id)
  if (!existing) return
  if (existing.builtin === 1) throw new Error('内置后端不可删除，如需停用请把「启用」关掉。')
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(id)
  // 引用了它的任务/项目回落到默认后端，避免悬空引用
  const t = now()
  getDb().prepare('UPDATE tasks SET agent_id = NULL, updated_at = ? WHERE agent_id = ?').run(t, id)
  getDb().prepare('UPDATE projects SET agent_id = NULL, updated_at = ? WHERE agent_id = ?').run(t, id)
}

/** 任务实际生效的后端：任务自身 > 项目默认 > codex。 */
export function effectiveAgentId(task: Pick<Task, 'agent_id' | 'project_agent_id'>): string {
  return task.agent_id || task.project_agent_id || DEFAULT_AGENT_ID
}

const now = () => new Date().toISOString()

/** 本地日期（YYYY-MM-DD）。实现见 shared/runat.ts —— 复用同一份，避免两处口径不一致。
 *  （注意不能用 toISOString().slice(0,10)：那是 UTC，东八区每天 08:00 前会算成前一天。） */
export { localDateString }

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY name').all() as unknown as Project[]
}

export function getProject(id: number): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined
}

export function createProject(input: ProjectInput): Project {
  const t = now()
  const info = getDb()
    .prepare(
      `INSERT INTO projects (name, path, default_session_id, default_prompt, is_git_repo, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.path,
      input.default_session_id ?? null,
      input.default_prompt ?? null,
      0, // is_git_repo is derived from disk right below
      input.agent_id ?? null,
      t,
      t
    )
  const project = getProject(Number(info.lastInsertRowid))!
  refreshGitFlag(project.id)
  return getProject(project.id)!
}

export function updateProject(id: number, input: ProjectInput): Project | undefined {
  getDb()
    .prepare(
      `UPDATE projects SET name = ?, path = ?, default_session_id = ?, default_prompt = ?, agent_id = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      input.name,
      input.path,
      input.default_session_id ?? null,
      input.default_prompt ?? null,
      input.agent_id ?? null,
      now(),
      id
    )
  refreshGitFlag(id)
  return getProject(id)
}

export function deleteProject(id: number): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** Reads `path/.git` and persists the flag; called on create/update. */
export function refreshGitFlag(id: number): boolean {
  const p = getProject(id)
  if (!p) return false
  const isRepo = fs.existsSync(p.path) && fs.existsSync(`${p.path}/.git`)
  getDb().prepare('UPDATE projects SET is_git_repo = ? WHERE id = ?').run(isRepo ? 1 : 0, id)
  return isRepo
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_WITH_PROJECT = `
  SELECT tasks.*, projects.name AS project_name, projects.path AS project_path,
         projects.agent_id AS project_agent_id
  FROM tasks JOIN projects ON projects.id = tasks.project_id
`

/** 给一行任务补上「实际生效的 agent 后端」，供 UI 与执行器直接使用。 */
function withEffectiveAgent(task: Task): Task {
  task.effective_agent_id = effectiveAgentId(task)
  return task
}

export function listTasks(): Task[] {
  const rows = getDb()
    .prepare(`${TASK_WITH_PROJECT} ORDER BY tasks.run_date IS NULL, tasks.run_date, tasks.run_time, tasks.id DESC`)
    .all() as unknown as Task[]
  // Display-level: a scheduled task whose time has passed well beyond the run
  // window (>= 10 min) without starting is shown as missed. A task within the
  // window is likely being picked up by the scheduler right now — don't mark it.
  const nowLocal = new Date()
  for (const t of rows) {
    if (t.status === 'scheduled' && t.run_date && t.run_time) {
      const due = new Date(`${t.run_date}T${t.run_time}:00`)
      if (!Number.isNaN(due.getTime()) && nowLocal.getTime() - due.getTime() >= 10 * 60_000) {
        t.status = 'missed'
      }
    }
    withEffectiveAgent(t)
  }
  return rows
}

/** 调度器专用：原始查询，不做显示级 missed 标记（避免把到点任务提前误判为错过）。 */
export function listSchedulableTasks(): Task[] {
  const rows = getDb()
    .prepare(
      `${TASK_WITH_PROJECT}
       WHERE tasks.status = 'scheduled' AND tasks.run_date IS NOT NULL AND tasks.run_time IS NOT NULL
       ORDER BY tasks.run_date, tasks.run_time`
    )
    .all() as unknown as Task[]
  for (const t of rows) withEffectiveAgent(t)
  return rows
}

export function listTaskIdsForProject(projectId: number): number[] {
  const rows = getDb().prepare('SELECT id FROM tasks WHERE project_id = ?').all(projectId) as unknown as Array<{
    id: number
  }>
  return rows.map((r) => Number(r.id))
}

export function getTask(id: number): Task | undefined {
  const row = getDb().prepare(`${TASK_WITH_PROJECT} WHERE tasks.id = ?`).get(id) as unknown as Task | undefined
  return row ? withEffectiveAgent(row) : undefined
}

/** 写入一个任务的公共列，create/update 共用，避免两处字段遗漏。 */
const TASK_COLUMNS = [
  'project_id',
  'name',
  'run_date',
  'run_time',
  'prompt',
  'execution_mode',
  'session_id',
  'retry_count',
  'post_action',
  'wake_enabled',
  'quota_retry',
  'sleep_after_minutes',
  'followup_prompt',
  'followup_model',
  'success_followup',
  'usb_backup',
  'usb_copy_subdir',
  'usb_dest_folder',
  'agent_id'
] as const

function taskColumnValues(input: TaskInput): Array<string | number | null> {
  return [
    input.project_id,
    input.name,
    input.run_date ?? null,
    input.run_time ?? null,
    input.prompt,
    input.execution_mode,
    input.session_id ?? null,
    input.retry_count ?? 0,
    input.post_action ?? 'none',
    input.wake_enabled ?? 0,
    input.quota_retry ?? 0,
    input.sleep_after_minutes ?? 0,
    input.followup_prompt ?? null,
    input.followup_model ?? 'gpt-5.6-luna',
    input.success_followup ?? 0,
    input.usb_backup ?? 0,
    input.usb_copy_subdir ?? null,
    input.usb_dest_folder ?? 'codex',
    input.agent_id ?? null
  ]
}

export function createTask(input: TaskInput): Task {
  const t = now()
  const placeholders = TASK_COLUMNS.map(() => '?').join(', ')
  const info = getDb()
    .prepare(
      `INSERT INTO tasks (${TASK_COLUMNS.join(', ')}, status, retry_used, created_at, updated_at)
       VALUES (${placeholders}, 'scheduled', 0, ?, ?)`
    )
    .run(...taskColumnValues(input), t, t)
  return getTask(Number(info.lastInsertRowid))!
}

export function updateTask(id: number, input: TaskInput): Task | undefined {
  const assignments = TASK_COLUMNS.map((c) => `${c} = ?`).join(', ')
  getDb()
    .prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...taskColumnValues(input), now(), id)
  return getTask(id)
}

export function deleteTask(id: number): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

export function setTaskStatus(id: number, status: string): void {
  getDb().prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
}

export function setTaskLastRun(id: number, sessionId?: string | null): void {
  getDb()
    .prepare('UPDATE tasks SET last_run_at = ?, session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?')
    .run(now(), sessionId ?? null, now(), id)
}

/**
 * 原子领取一个到点任务：仅当任务仍是 'scheduled' 时领取成功。
 *
 * 这是「同一任务被跑两次」的根治手段：应用内调度器和 Windows 计划任务会在同一
 * 分钟各自触发一次，而它们分属两个进程。SQLite 单条 UPDATE 自带原子性，
 * 因此两个触发源里只有一方能把 scheduled 抢成 preparing，另一方直接放弃。
 */
export function claimScheduledTask(id: number): boolean {
  const info = getDb()
    .prepare("UPDATE tasks SET status = 'preparing', updated_at = ? WHERE id = ? AND status = 'scheduled'")
    .run(now(), id)
  return Number(info.changes) === 1
}

/** 安排一次限额恢复后的自动重试：更新排期并递增重试计数。 */
export function rescheduleTaskForQuotaRetry(id: number, date: string, time: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET run_date = ?, run_time = ?, status = 'scheduled', quota_retry_count = quota_retry_count + 1, updated_at = ? WHERE id = ?`
    )
    .run(date, time, now(), id)
}

/** 安排一次普通失败重试（由任务的「重试次数」驱动）。 */
export function rescheduleTaskForRetry(id: number, date: string, time: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET run_date = ?, run_time = ?, status = 'scheduled', retry_used = retry_used + 1, updated_at = ? WHERE id = ?`
    )
    .run(date, time, now(), id)
}

/** 任务成功后清空普通重试计数，下次失败可以重新用完额度。 */
export function resetRetryUsed(id: number): void {
  getDb().prepare('UPDATE tasks SET retry_used = 0, updated_at = ? WHERE id = ?').run(now(), id)
}

/** 安排一次"成功后刷新"执行：下次执行发送轻量消息。 */
export function scheduleFollowup(id: number, date: string, time: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET run_date = ?, run_time = ?, status = 'scheduled', followup_pending = 1, updated_at = ? WHERE id = ?`
    )
    .run(date, time, now(), id)
}

export function nextScheduledTask(): Task | undefined {
  return getDb()
    .prepare(
      `${TASK_WITH_PROJECT}
       WHERE tasks.status = 'scheduled' AND tasks.run_date IS NOT NULL AND tasks.run_time IS NOT NULL
         AND (tasks.run_date || ' ' || tasks.run_time) >= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
       ORDER BY tasks.run_date, tasks.run_time LIMIT 1`
    )
    .get() as unknown as Task | undefined
}

// ---------------------------------------------------------------------------
// Execution logs
// ---------------------------------------------------------------------------

const LOG_WITH_NAMES = `
  SELECT execution_logs.*, tasks.name AS task_name, projects.name AS project_name, projects.path AS project_path
  FROM execution_logs
  JOIN tasks ON tasks.id = execution_logs.task_id
  JOIN projects ON projects.id = execution_logs.project_id
`

export function listLogs(limit = 100): ExecutionLog[] {
  return getDb()
    .prepare(`${LOG_WITH_NAMES} ORDER BY execution_logs.id DESC LIMIT ?`)
    .all(limit) as unknown as ExecutionLog[]
}

export function listLogsForTask(taskId: number): ExecutionLog[] {
  return getDb()
    .prepare(`${LOG_WITH_NAMES} WHERE execution_logs.task_id = ? ORDER BY execution_logs.id DESC`)
    .all(taskId) as unknown as ExecutionLog[]
}

export function getLog(id: number): ExecutionLog | undefined {
  return getDb().prepare(`${LOG_WITH_NAMES} WHERE execution_logs.id = ?`).get(id) as unknown as
    | ExecutionLog
    | undefined
}

export function getRunningLog(): ExecutionLog | undefined {
  return getDb()
    .prepare(`${LOG_WITH_NAMES} WHERE execution_logs.status = 'running' ORDER BY execution_logs.id DESC LIMIT 1`)
    .get() as unknown as ExecutionLog | undefined
}

export function listRunningLogs(): ExecutionLog[] {
  return getDb()
    .prepare(`${LOG_WITH_NAMES} WHERE execution_logs.status = 'running' ORDER BY execution_logs.id`)
    .all() as unknown as ExecutionLog[]
}

/** 进程是否仍存活。用于区分「真的还在跑」和「进程已死留下的 running 残留」。 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (err) {
    // EPERM：进程存在但当前用户无权限（例如以管理员身份启动的任务）。
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Marks runs left in 'running' state as failed — e.g. the runner or the app
 * was killed mid-execution. Called on startup of the app and the runner.
 *
 * 重要：应用与 Runner 是两个进程，各自启动时都会跑这里。如果无条件把所有
 * running 记录判为失败，就会出现「A 进程正在跑任务，B 进程启动时把它的记录
 * 改成失败、任务状态改成 failed」的互相踩踏。因此这里按 pid 存活检测：
 * 持有该运行的进程还活着，就跳过。
 */
export function recoverInterruptedRuns(): number {
  const running = listRunningLogs()
  const endedAt = now()
  let recovered = 0
  for (const log of running) {
    if (isProcessAlive(log.pid)) continue
    updateLog(log.id, {
      status: 'failed',
      ended_at: endedAt,
      error_message: '执行进程被中断（Runner 或应用提前退出），未获得完整结果。'
    })
    const task = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(log.task_id) as
      | { status: string }
      | undefined
    if (task && (task.status === 'running' || task.status === 'preparing')) {
      setTaskStatus(log.task_id, 'failed')
    }
    recovered++
  }
  return recovered
}

export function createLog(
  taskId: number,
  projectId: number,
  startedAt: string,
  pid?: number | null,
  agentId?: string | null
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO execution_logs (task_id, project_id, started_at, status, pid, agent_id) VALUES (?, ?, ?, 'running', ?, ?)`
    )
    .run(taskId, projectId, startedAt, pid ?? process.pid, agentId ?? null)
  return Number(info.lastInsertRowid)
}

export function updateLog(id: number, fields: Partial<ExecutionLog>): void {
  const allowed = [
    'ended_at',
    'duration_ms',
    'exit_code',
    'status',
    'final_response',
    'session_id',
    'changed_files',
    'git_diff_summary',
    'stdout_path',
    'stderr_path',
    'error_message',
    'pid',
    'agent_id'
  ] as const
  const sets: string[] = []
  const values: (string | number | null)[] = []
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`)
      const value = (fields as Record<string, unknown>)[key]
      values.push(typeof value === 'string' || typeof value === 'number' ? value : null)
    }
  }
  if (!sets.length) return
  values.push(id)
  getDb().prepare(`UPDATE execution_logs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function finishLog(id: number, result: RunResult, fields: Partial<ExecutionLog>): void {
  updateLog(id, { status: result, ...fields })
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function dashboardData(): DashboardData {
  const tasks = listTasks()
  const today = localDateString()
  return {
    nextTask: nextScheduledTask() ?? null,
    todayTasks: tasks.filter((t) => t.run_date === today),
    runningTasks: tasks.filter((t) => t.status === 'running' || t.status === 'preparing'),
    counts: {
      scheduled: tasks.filter((t) => t.status === 'scheduled').length,
      running: tasks.filter((t) => t.status === 'running' || t.status === 'preparing').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length
    },
    recentLogs: listLogs(8)
  }
}
