import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from '../shared/paths'
import { getDb, listTasks, recoverInterruptedRuns, closeDb } from '../shared/db'
import { syncScheduledTask } from '../shared/scheduler'
import { registerIpc } from './ipc'
import { startAppScheduler, stopAppScheduler } from './appScheduler'

// Keep the data directory stable for the standalone runner regardless of
// how Electron names userData.
app.setPath('userData', DATA_DIR)

/** 把致命异常落到磁盘，避免"闪一下就没了"而没有任何线索。 */
function logFatal(kind: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err)
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  console.error(`[main] ${line.trim()}`)
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), line)
  } catch {
    /* ignore */
  }
}

// 常驻调度器不能因为一次未捕获异常就整体退出：记下来，继续跑。
process.on('uncaughtException', (err) => logFatal('uncaughtException', err))
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let trayHintShown = false

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const iconPath = path.join(__dirname, '../../assets/icon.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // 图标缺失不应阻断启动，托盘至少还能用默认图标显示。
    image = nativeImage.createEmpty()
  }
  try {
    tray = new Tray(image)
  } catch (err) {
    logFatal('tray', err)
    tray = null
    return
  }
  tray.setToolTip('Codex 任务调度器 — 调度运行中')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '退出（同时停止调度）',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => showWindow())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Agent 任务调度器',
    backgroundColor: '#f3f4f6',
    // hiddenInset 只在 macOS 生效；Windows 上写它会落到无边框样式，
    // 结果窗口拖不动、也没有系统按钮。按平台区分：
    // macOS 保留系统红绿灯（hiddenInset），Windows 用 frame:false 自绘标题栏。
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 最大化状态变化推给渲染层，驱动自绘标题栏的最大化/还原图标切换。
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  // 关窗口 = 收进托盘，不退出。调度器必须保持在线，否则"关掉窗口就不跑了"。
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown && tray) {
      trayHintShown = true
      try {
        tray.displayBalloon({
          title: 'Codex 任务调度器仍在运行',
          content: '窗口已收进托盘，定时任务照常执行。右键托盘图标可退出。'
        })
      } catch {
        /* displayBalloon 在部分环境不支持，忽略 */
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 单实例：多开会让每个实例各跑一套应用内调度器，同一任务被重复执行。
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    getDb()
    recoverInterruptedRuns()
    registerIpc(() => mainWindow)
    createTray()
    // Keep Windows scheduled tasks in sync with the DB on every launch.
    for (const task of listTasks()) {
      if (task.run_date && task.run_time && task.status === 'scheduled') {
        syncScheduledTask(task).catch(() => {})
      }
    }
    // 应用内准点调度：应用开着时保证到点执行（不依赖 Windows 计划服务）。
    startAppScheduler()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // 有托盘常驻，关掉窗口不等于退出。
  app.on('window-all-closed', () => {
    /* 保持运行 */
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('will-quit', () => {
    stopAppScheduler()
    closeDb()
  })
}
