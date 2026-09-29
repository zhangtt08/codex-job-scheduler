/**
 * U 盘备份：检测可移动磁盘并把项目文件拷贝过去。
 * 自动排除 node_modules / .git / tmp 等大目录。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'tmp', '.cache', '.next', '.turbo', 'backups'])

/** 默认存放目录（U 盘根下的子目录名）。 */
const DEFAULT_DEST_FOLDER = 'codex'

/** 列出所有可移动磁盘（U 盘），如 ['E:\\'] */
export function listRemovableDrives(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object -ExpandProperty DeviceID"],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          (stdout ?? '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => /^[A-Z]:\\?$/i.test(s))
            .map((s) => (s.endsWith('\\') ? s : s + '\\'))
        )
      }
    )
  })
}

/**
 * 把配置里的存放目录归一到「U 盘上的相对子路径」。
 * 兼容历史默认值：'D:\codex' → 'codex'（去掉盘符与首部斜杠）。
 */
export function normalizeDestFolder(raw?: string | null): string {
  const stripped = (raw ?? '').trim().replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, '')
  const cleaned = stripped
    .split(/[\\/]+/)
    .map((p) => p.replace(/[<>:"|?*]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .join('\\')
  return cleaned || DEFAULT_DEST_FOLDER
}

export function copyTree(src: string, dest: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // 跳过符号链接/联接点：既避免拷到项目外的内容，也避免目录环导致无限递归。
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      const r = copyTree(s, d)
      files += r.files
      bytes += r.bytes
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d)
      files++
      bytes += fs.statSync(s).size
    }
  }
  return { files, bytes }
}

export interface UsbBackupResult {
  ok: boolean
  dest?: string
  drive?: string
  files?: number
  bytes?: number
  message: string
  /** 失败原因是「当前没有可移动磁盘」——调用方据此决定是否等待后重试。 */
  noDrive?: boolean
}

export function backupProjectToUsb(
  projectDir: string,
  projectName: string,
  subdir?: string | null,
  destFolder?: string | null
): Promise<UsbBackupResult> {
  return (async () => {
    const src = subdir?.trim() ? path.join(projectDir, subdir.trim()) : projectDir
    if (!fs.existsSync(src)) return { ok: false, message: `备份源目录不存在：${src}` }
    const drives = await listRemovableDrives()
    if (!drives.length) return { ok: false, message: '未检测到 U 盘（可移动磁盘）', noDrive: true }
    const drive = drives[0]
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`
    const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_')
    const dest = path.join(drive, normalizeDestFolder(destFolder), `${safeName}_${stamp}`)
    const r = copyTree(src, dest)
    return {
      ok: true,
      dest,
      drive,
      files: r.files,
      bytes: r.bytes,
      message: `已备份 ${r.files} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）到 ${dest}`
    }
  })()
}

/** 通过资源管理器"弹出" verb 安全移除 U 盘（无需管理员）。 */
export function ejectDrive(drive: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const root = drive.replace(/\\+$/, '')
    const ps = `$s = (New-Object -ComObject Shell.Application).NameSpace(0x11); $i = $s.ParseName('${root}\\'); if ($i) { $i.InvokeVerb('Eject'); 'ejected' } else { 'notfound' }`
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      const out = (stdout ?? '').trim()
      if (err && !out) return resolve({ ok: false, message: `弹出失败：${err.message}` })
      resolve({
        ok: out === 'ejected',
        message: out === 'ejected' ? `U 盘 ${drive} 已安全弹出` : `弹出指令已发送（结果：${out || err?.message}）`
      })
    })
  })
}
