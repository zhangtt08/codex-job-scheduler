/**
 * Windows Task Scheduler adapter.
 *
 * Each scheduled Codex task maps to a Windows scheduled task under the
 * \CodexJobScheduler\ folder that launches the standalone runner at the
 * configured time — so tasks fire even when the desktop app is closed.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import type { Task } from './types'

const FOLDER = 'CodexJobScheduler'

/** Locate codex-runner.cjs whether this module runs from out/main (app) or dist-runner (standalone). */
export function resolveRunnerScript(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../dist-runner/codex-runner.cjs'), // electron-vite: out/main/index.js
    path.resolve(__dirname, 'codex-runner.cjs'), // bundled into dist-runner itself
    path.join(DATA_DIR, 'codex-runner.cjs') // installed copy
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

function schtasks(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim() || (err ? err.message : '')
      })
    })
  })
}

export function scheduledTaskName(taskId: number): string {
  return `\\${FOLDER}\\Task_${taskId}`
}

/** 降级写入的任务定义文件路径：与任务名同名同层级，保证计划服务加载出来是同一个任务。 */
function dropFilePath(taskId: number): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'Tasks', FOLDER, `Task_${taskId}`)
}

/** 注册时留在数据目录里的临时 XML 文件（仅用于 schtasks /XML）。 */
function stagingXmlPath(taskId: number): string {
  return path.join(DATA_DIR, `${FOLDER}_Task_${taskId}.xml`)
}

function removeQuietly(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}

/** 最近一次定位 node 失败的原因，用于给用户一句能照做的提示。 */
let lastNodeError: string | null = null
let cachedNode: string | null | undefined

/** node:sqlite 自 Node 22.5 起才内置。计划任务用的 node 必须支持它，
 *  否则 Runner 一加载就崩，到点执行会静默失败。 */
function nodeSupportsSqlite(nodePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      nodePath,
      ['-e', "try{require('node:sqlite')}catch(e){process.exit(1)}"],
      { windowsHide: true, timeout: 20000 },
      (err) => resolve(!err)
    )
  })
}

async function findNode(): Promise<string | null> {
  if (process.execPath.toLowerCase().endsWith('node.exe')) return process.execPath
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  const where = await new Promise<string>((resolve) => {
    execFile('where', ['node'], { windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : (stdout ?? '').split(/\r?\n/)[0])
    )
  })
  return where || null
}

async function locateNode(): Promise<string | null> {
  if (cachedNode !== undefined) return cachedNode
  lastNodeError = null
  const found = await findNode()
  if (!found) {
    lastNodeError = '未找到 node.exe，无法注册计划任务。请安装 Node.js 后重启本应用。'
    cachedNode = null
    return null
  }
  if (!(await nodeSupportsSqlite(found))) {
    lastNodeError = `计划任务用的 Node（${found}）版本过低，缺少内置的 node:sqlite。请安装 Node 22.5 或更高版本后重新保存任务。`
    cachedNode = null
    return null
  }
  cachedNode = found
  return found
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** 当前交互式用户的 "域\用户名"。缺了它 schtasks 在部分环境下会拒绝 /XML 注册。 */
function currentUserId(): string | null {
  const user = process.env.USERNAME
  if (!user) return null
  const domain = process.env.USERDOMAIN
  return domain ? `${domain}\\${user}` : user
}

function buildTaskXml(
  description: string,
  startBoundary: string,
  wake: boolean,
  command: string,
  args: string
): string {
  const userId = currentUserId()
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${escapeXml(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${userId ? `\n      <UserId>${escapeXml(userId)}</UserId>` : ''}
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <WakeToRun>${wake}</WakeToRun>
    <ExecutionTimeLimit>PT6H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(DATA_DIR)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`
}

export interface ScheduleResult {
  ok: boolean
  message: string
  /** schtasks = 服务注册；file-drop = 直接写入任务定义文件（服务下次加载时生效） */
  mode?: 'schtasks' | 'file-drop'
}

/** Create/update the Windows scheduled task for one Codex task (overwrites existing). */
export async function syncScheduledTask(task: Task): Promise<ScheduleResult> {
  if (!task.run_date || !task.run_time) {
    await deleteScheduledTask(task.id)
    return { ok: true, message: '未排期，已清除计划任务。' }
  }

  const runner = resolveRunnerScript()
  if (!runner) return { ok: false, message: '未找到 codex-runner.cjs，请先运行 npm run build:runner。' }

  const node = await locateNode()
  if (!node) return { ok: false, message: lastNodeError ?? '未找到 node.exe，无法注册计划任务。' }

  const xml = buildTaskXml(
    `Codex Job Scheduler — task ${task.id}`,
    `${task.run_date}T${task.run_time}:00`,
    task.wake_enabled === 1,
    node,
    `"${runner}" --task ${task.id}`
  )
  return registerTaskXml(task.id, xml)
}

/** schtasks 注册，被拒时降级为直接写入任务定义文件。 */
async function registerTaskXml(taskId: number, xml: string): Promise<ScheduleResult> {
  const name = scheduledTaskName(taskId)
  const xmlPath = stagingXmlPath(taskId)
  // schtasks requires UTF-16
  fs.writeFileSync(xmlPath, '\ufeff' + xml, 'utf16le')

  const res = await schtasks(['/Create', '/TN', name, '/XML', xmlPath, '/F'])
  if (res.ok) return { ok: true, mode: 'schtasks', message: '已写入 Windows 任务计划程序。' }

  // 降级：服务注册被拒（受限会话/权限策略）时，直接把任务定义文件写入系统的
  // Tasks 目录。该目录普通用户即可写入（CREATOR OWNER），Windows 任务计划服务
  // 在下次加载目录（如重启电脑）时会读取它；无需管理员。
  //
  // 注意落盘路径必须与任务名同构（Tasks\CodexJobScheduler\Task_N），否则计划服务
  // 会把它当成另一个顶层任务，删除时也删不掉，留下"幽灵任务"到点乱跑。
  const denied = /(拒绝访问|denied|0x80070005)/i.test(res.stderr + res.stdout)
  const dropPath = dropFilePath(taskId)
  try {
    fs.mkdirSync(path.dirname(dropPath), { recursive: true })
    fs.writeFileSync(dropPath, '\ufeff' + xml, 'utf16le')
    return {
      ok: true,
      mode: 'file-drop',
      message: denied
        ? '服务注册被拒，已改为任务文件方式写入（电脑重启或计划服务重新加载时生效；如需立即生效，请以管理员身份运行本应用后重新保存任务）。'
        : `服务注册异常，已改为任务文件方式写入：${res.stderr || res.stdout}`
    }
  } catch (err) {
    return {
      ok: false,
      message: denied
        ? `注册计划任务被拒绝访问，且任务文件写入失败（${(err as Error).message}）。请以管理员身份运行本应用后重新保存任务。`
        : `注册计划任务失败：${res.stderr || res.stdout}`
    }
  }
}

/**
 * 删除任务时把三条路径都清掉：服务注册、降级写入的定义文件、暂存 XML。
 * 只删服务注册的话，降级文件会在重启后被计划服务重新加载，任务复活。
 */
export async function deleteScheduledTask(taskId: number): Promise<ScheduleResult> {
  const res = await schtasks(['/Delete', '/TN', scheduledTaskName(taskId), '/F'])
  removeQuietly(dropFilePath(taskId))
  removeQuietly(stagingXmlPath(taskId))
  // 兼容早期版本留下的扁平命名文件
  removeQuietly(path.join(DATA_DIR, `task-${taskId}.xml`))
  // "does not exist" is fine
  const missing = !res.ok && /(不存在|找不到|does not exist|cannot find|0x80070002)/i.test(res.stderr + res.stdout)
  return res.ok || missing
    ? { ok: true, message: '已删除计划任务。' }
    : { ok: false, message: `删除计划任务失败：${res.stderr || res.stdout}` }
}
