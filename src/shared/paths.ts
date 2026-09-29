import os from 'node:os'
import path from 'node:path'

/**
 * All persistent state lives in one directory that both the Electron main
 * process and the standalone runner resolve identically, without importing
 * Electron.
 */
export const DATA_DIR = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'CodexJobScheduler'
)

export const DB_PATH = path.join(DATA_DIR, 'scheduler.db')
export const LOGS_DIR = path.join(DATA_DIR, 'logs')

export function logDirForRun(logId: number): string {
  return path.join(LOGS_DIR, String(logId))
}
