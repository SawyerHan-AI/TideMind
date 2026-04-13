import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import path from 'node:path'
import { exec } from 'node:child_process'
import { getClientDb, closeClientDb, getDataDir } from './db'
import { registerAllHandlers } from './ipc/index'
import { startDaemon, stopDaemon } from './daemon'
import { startDataWatcher, stopDataWatcher } from './data-watcher'
import { writeShimAndRuntimePath } from './runtime/shim-writer'
import { selfHealPlugins } from './runtime/plugin-self-heal'
import { migrateDataDirIfNeeded } from '@server/utils/migrate-data-dir.js'
import { createLogger } from '@server/utils/logger.js'

const migrationLog = createLogger('client-migrate')

// 全局异常处理 — 防止 main process 无声崩溃
process.on('uncaughtException', (err) => {
  console.error('[eb:main] 未捕获异常:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[eb:main] 未处理的 Promise 拒绝:', reason)
})

/** 检测 Ollama 是否在运行，没运行则自动拉起（仅当 embedding 使用 ollama 时） */
async function ensureOllama(): Promise<void> {
  // 只在 embedding provider 为 ollama 时才自动启动
  const configPath = path.join(getDataDir(), 'config.toml')
  try {
    const { parse } = await import('smol-toml')
    const fs = await import('node:fs')
    if (fs.existsSync(configPath)) {
      const cfg = parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>
      if (cfg.embedding?.provider !== 'ollama') return
    } else {
      return // 无配置文件，默认不启动
    }
  } catch {
    return
  }

  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    if (resp.ok) return // 已在运行
  } catch {
    // 未运行，尝试启动
  }
  if (process.platform === 'darwin') {
    exec('open -a Ollama', (err) => {
      if (err) console.warn('Ollama 启动失败:', err.message)
      else console.log('Ollama 已自动启动')
    })
  }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 是否真正退出（区分关闭窗口 vs 退出应用） */
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // macOS: 关闭窗口时隐藏到后台，而不是退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 外部链接在浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 开发模式加载 Vite dev server，生产模式加载构建产物
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  // macOS Template 图标：文件名含 Template，系统自动适配深浅色模式
  const iconPath = path.join(__dirname, '../../resources/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Tide Mind')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // 左键点击显示并聚焦窗口
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

app.whenReady().then(() => {
  // ⚠️ 数据目录迁移必须是第一步！shim-writer 会创建 ~/.tidemind/bin/，
  // 一旦 ~/.tidemind/ 被任何子进程提前创建，迁移逻辑就会认为"已存在"而跳过，
  // 导致用户的 ~/.external-brain/ 数据孤立。
  try {
    const migrationResult = migrateDataDirIfNeeded(migrationLog)
    if (migrationResult.migrated) {
      console.log(`[eb:main] data dir migrated → ${migrationResult.newDir} (backup: ${migrationResult.backupDir})`)
    }
  } catch (err) {
    console.error('[eb:main] 数据目录迁移失败:', err)
  }

  // 在任何 plugin 配置被读/写之前：刷新 shim 和 runtime-path，再对已有 plugin 配置
  // 做一次自愈扫描。顺序：migrate → shim → runtime-path → self-heal。
  try {
    const result = writeShimAndRuntimePath()
    console.log(`[eb:main] shim updated=${result.shimUpdated} runtime-path updated=${result.runtimePathUpdated} → ${result.runtimePath}`)
  } catch (err) {
    console.error('[eb:main] 写入 tm-node shim 失败:', err)
  }

  // 初始化数据库和 IPC
  try {
    const db = getClientDb()
    const dataDir = getDataDir()
    registerAllHandlers(db, dataDir)
    startDataWatcher(db)

    // self-heal 依赖 dataDir 和 db（用于重建丢失的 MCP 条目），必须在 DB 初始化之后
    try {
      selfHealPlugins(dataDir, db)
    } catch (err) {
      console.error('[eb:main] plugin self-heal 失败:', err)
    }
  } catch (err) {
    console.error('数据库初始化失败:', err)
  }

  createWindow()
  createTray()

  // 后台确保 Ollama 运行，不阻塞应用启动
  ensureOllama()

  // 启动内嵌守护进程（定时维护任务）
  startDaemon().catch(err => console.error('daemon 启动失败:', err))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  stopDataWatcher()
  stopDaemon()
})

app.on('window-all-closed', () => {
  // macOS: 有 tray 时不退出，窗口关闭只是隐藏
  if (process.platform !== 'darwin') {
    closeClientDb()
    app.quit()
  }
})
