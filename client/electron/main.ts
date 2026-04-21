import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } from 'electron'
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
import { mainT } from './i18n'

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

// ── tidemind:// 协议注册 ────────────────────────────────
// 在 macOS 上，第二次打开链接不会启动新进程，而是发送 open-url 事件。
// 在 Windows/Linux 上，会启动新进程，需要通过 second-instance 事件处理。

const PROTOCOL = 'tidemind'

if (process.defaultApp) {
  // 开发模式：需要传递 Electron 路径
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// 确保单实例
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: 第二个实例启动时，URL 在 argv 中
    const url = argv.find(arg => arg.startsWith(`${PROTOCOL}://`))
    if (url) handleProtocolUrl(url)
    // 聚焦主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// macOS: open-url 事件（可能在 app.whenReady() 之前触发，需缓存）
let pendingProtocolUrl: string | null = null

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!app.isReady() || !mainWindow) {
    // app 还没 ready 或窗口还没创建，缓存 URL 稍后处理
    pendingProtocolUrl = url
  } else {
    handleProtocolUrl(url)
  }
})

/** 处理 tidemind:// 协议链接 */
async function handleProtocolUrl(url: string): Promise<void> {
  const log = createLogger('protocol')
  log.info(`handling protocol URL: ${url
    .replace(/access_token=([^&]{4})[^&]*/g, 'access_token=$1...')
    .replace(/refresh_token=([^&]{4})[^&]*/g, 'refresh_token=$1...')}`)

  try {
    const parsed = new URL(url)
    // tidemind://auth/callback → WHATWG URL 解析为 hostname='auth', pathname='/callback'
    // 不能直接检查 pathname === '/auth/callback'
    const isAuthCallback =
      (parsed.hostname === 'auth' && parsed.pathname === '/callback') ||
      parsed.pathname === '/auth/callback'
    if (isAuthCallback) {
      // OAuth 回调
      const { handleOAuthCallback } = await import('./cloud/auth-client.js')
      const auth = await handleOAuthCallback(url)
      // 通知渲染进程刷新状态
      mainWindow?.webContents.send('data-changed', { scopes: ['cloud'] })
      log.info(`OAuth login success: ${auth.email}`)
    } else {
      log.warn(`unrecognized protocol path: hostname=${parsed.hostname}, pathname=${parsed.pathname}`)
    }
  } catch (err) {
    const msg = (err as Error).message
    log.error(`protocol handler error: ${msg}`)
    // 显示错误对话框以便排查
    dialog.showErrorBox(mainT('login.errorTitle'), msg)
  }
}

/** 处理 app ready 之前缓存的协议 URL */
function flushPendingProtocolUrl(): void {
  if (pendingProtocolUrl) {
    const url = pendingProtocolUrl
    pendingProtocolUrl = null
    handleProtocolUrl(url)
  }
}

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

  // 外部链接在浏览器打开（只允许 http/https，防止 file:// / javascript: 等被打开）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch { /* invalid URL, deny */ }
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
      label: mainT('tray.showWindow'),
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: 'separator' },
    {
      label: mainT('tray.quit'),
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

app.whenReady().then(async () => {
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
  let db: ReturnType<typeof getClientDb> | null = null
  try {
    db = getClientDb()
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

  // 恢复上次的云登录会话 + 条件性启动 sync client
  try {
    const { initAuth, isLoggedIn } = await import('./cloud/auth-client.js')
    initAuth()

    if (isLoggedIn() && db) {
      const { getConfig: getAppConfig } = await import('../../src/config.js')
      const config = getAppConfig()
      if (config.cloud?.sync_enabled) {
        const { createCloudSyncClient } = await import('./cloud/sync-client.js')
        const syncClient = createCloudSyncClient(db)
        syncClient.start().catch(err => console.error('[eb:main] sync client start failed:', err))
      }
    }
  } catch (err) {
    console.error('[eb:main] cloud auth init failed:', err)
  }

  createWindow()
  createTray()

  // 处理 app ready 之前收到的协议 URL（如从浏览器冷启动 app 的场景）
  flushPendingProtocolUrl()

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
  closeClientDb()
})

app.on('window-all-closed', () => {
  // macOS: 有 tray 时不退出，窗口关闭只是隐藏
  if (process.platform !== 'darwin') {
    closeClientDb()
    app.quit()
  }
})
