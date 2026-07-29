import { app, BrowserWindow, Menu, Tray, nativeImage, session, shell, dialog, powerMonitor } from 'electron'
import path from 'node:path'
import { exec } from 'node:child_process'
import { getClientDb, closeClientDb, getDataDir } from './db'
import { registerAllHandlers } from './ipc/index'
import { startDaemon, stopDaemon } from './daemon'
import { startDataWatcher, stopDataWatcher } from './data-watcher'
import { writeShimAndRuntimePath } from './runtime/shim-writer'
import { selfHealPlugins } from './runtime/plugin-self-heal'
import { initAutoUpdater, runUpdateCheck } from './updater/index'
import { scheduleUpdateChecks } from './updater/scheduler'
import { getActivityState } from './activity-state'
import { migrateDataDirIfNeeded } from '@server/utils/migrate-data-dir.js'
import { createLogger } from '@server/utils/logger.js'
import { mainT } from './i18n'

const migrationLog = createLogger('client-migrate')
const mainLog = createLogger('main')

// 全局异常处理 — 防止 main process 无声崩溃
process.on('uncaughtException', (err) => {
  mainLog.error('uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  mainLog.error('unhandled promise rejection:', reason)
})

/** 检测 Ollama 是否在运行，没运行则自动拉起（仅当 embedding 使用 ollama 时） */
async function ensureOllama(): Promise<void> {
  // 只在 embedding provider 为 ollama 时才自动启动
  const configPath = path.join(getDataDir(), 'config.toml')
  try {
    const { parse } = await import('smol-toml')
    const fs = await import('node:fs')
    if (fs.existsSync(configPath)) {
      const cfg = parse(fs.readFileSync(configPath, 'utf-8')) as {
        embedding?: { provider?: unknown }
      }
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
  if (getIsQuitting()) return
  if (process.platform === 'darwin') {
    exec('open -a Ollama', (err) => {
      if (err) mainLog.warn(`Ollama start failed: ${err.message}`)
      else mainLog.info('Ollama started automatically')
    })
  } else {
    // Linux / Windows: 没有"启动已安装 app"的统一入口；只通知 renderer
    // 提示用户手动启动 Ollama。mainWindow 此时可能尚未 ready-to-show，
    // 加个小延迟避免事件被吞。
    mainLog.warn(`Ollama not reachable and auto-start unsupported on platform=${process.platform}`)
    const notify = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('data-changed', { scopes: ['ollama-missing'] })
      }
    }
    if (mainWindow) notify()
    else setTimeout(notify, 2000)
  }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/**
 * 是否真正退出（区分关闭窗口 vs 退出应用）。
 * 抽到 lifecycle.ts 共享给 updater 模块,在 quitAndInstall 之前置 true,让
 * close() handler 放行 quit 路径(详见 lifecycle.ts 注释 + Audit B-5)。
 */
import { getIsQuitting, resetQuitting, setQuitting } from './lifecycle.js'

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

/**
 * 在满足条件(已登录 + sync_enabled + db 就绪)时创建并启动 cloud sync client。
 * 启动路径(whenReady)和 OAuth 登录回调路径共用,保证两条登录入口都自动起同步。
 * createCloudSyncClient 内部先 stop 旧 singleton,重复调用安全(幂等)。
 * before-quit 走 destroySyncClient() 销毁当前 singleton,不依赖此处的引用。
 */
async function maybeStartCloudSync(dbForCloud: ReturnType<typeof getClientDb>): Promise<void> {
  const { isLoggedIn } = await import('./cloud/auth-client.js')
  if (!isLoggedIn()) return
  const { getConfig: getAppConfig } = await import('../../src/config.js')
  if (!getAppConfig().cloud?.sync_enabled) return
  const { getCloudSyncClient, createCloudSyncClient } = await import('./cloud/sync-client.js')
  if (getCloudSyncClient()) return // 已有实例(如启动路径已建),不重复建
  const syncClient = createCloudSyncClient(dbForCloud)
  syncClient.start().catch(err => mainLog.error('sync client start failed:', err))
}

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
      // OAuth 登录后自动启动 sync client(对齐启动路径)。原实现:启动时未登录会在
      // `if (!isLoggedIn()) return` 提前退出,永不建 client;OAuth 回调只 emit
      // data-changed 不建 client → 本会话内 30s 轮询 / WS / reconcile 全不启动,
      // 用户以为"登录回来就恢复同步了"但实际要手动点"立即同步"或重启 app。
      // maybeStartCloudSync 内部已判 sync_enabled + 已有实例去重,失败不阻塞登录。
      try {
        const dbForCloud = getClientDb()
        await maybeStartCloudSync(dbForCloud)
      } catch (e) {
        mainLog.warn('post-OAuth sync start failed (non-fatal):', (e as Error).message)
      }
      // 客户端日志写到本地 logs/,但仍按 PII 卫生掩码邮箱(避免日志被分享/上报时泄漏)
      const masked = (auth.email ?? '').replace(/(.{3}).*@/, '$1***@')
      log.info(`OAuth login success: ${masked}`)
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

/**
 * 处理 app ready 之前缓存的协议 URL。
 *
 * Audit-3 F15 修复:必须等 mainWindow 的 webContents 完全 load 完毕再调用,
 * 否则 handleProtocolUrl 内部走 `mainWindow.webContents.send('data-changed')`
 * 时 renderer 还没注册监听,事件 silently 丢掉(冷启动用户点 OAuth 链接 →
 * tokens 写到 keychain 但 UI 不刷,显示"未登录"直到下次切 tab)。
 */
function flushPendingProtocolUrl(): void {
  if (!pendingProtocolUrl) return
  const url = pendingProtocolUrl
  pendingProtocolUrl = null
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    handleProtocolUrl(url)
  } else if (mainWindow) {
    // 等 loadURL 跑完(did-finish-load 是 webContents 发的)
    mainWindow.webContents.once('did-finish-load', () => {
      handleProtocolUrl(url)
    })
  } else {
    // 没有 mainWindow 还能 flush? 防御:延后到下个 tick 重试
    pendingProtocolUrl = url
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

  // 仅 macOS 遵循"关窗隐藏到 tray、不退出"的平台惯例;Windows/Linux 关窗即退出
  // (放行 close → window-all-closed → app.quit())。getIsQuitting() 为 true 时
  // (托盘 Quit / cmd+Q / quitAndInstall)所有平台都放行。
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !getIsQuitting()) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 活动状态信号:hide/minimize → idle, show/restore/focus → active, blur → 延迟 idle。
  // 订阅方(data-watcher / sync-client / daemon)据此 pause / 错峰恢复后台任务,避免
  // Chromium 把窗口隐藏期间的定时器全节流积压,回前台时一次性 fire 撞 SQL 同步 API。
  const activity = getActivityState()
  mainWindow.on('hide', () => { activity.notifyHidden('hide') })
  mainWindow.on('minimize', () => { activity.notifyHidden('minimize') })
  mainWindow.on('show', () => { activity.notifyVisible('show') })
  mainWindow.on('restore', () => { activity.notifyVisible('restore') })
  mainWindow.on('focus', () => { activity.notifyVisible('focus') })
  mainWindow.on('blur', () => { activity.notifyBlur() })

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
        setQuitting()
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

/**
 * 注入 Content-Security-Policy 响应头 — 防御 XSS 升级为 RCE。
 * meta 标签里的 CSP 在 DevTools 里可以被删，header 不行；两层都加。
 *
 * Dev 模式需要放开 vite HMR：
 *   - script-src 加 'unsafe-inline' 和 'unsafe-eval'（HMR runtime + react-refresh）
 *   - connect-src 加 ws://localhost:* 和 http://localhost:* (vite dev server)
 *
 * Prod 模式严格策略：no inline script, no eval。
 */
function installCspHeader(): void {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const connectSrc = [
    "'self'",
    'https://cloud.tidemind.ai',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    'https://api.openai.com',
    'http://localhost:11434',
    'http://127.0.0.1:11434',
  ]
  if (isDev) {
    // vite HMR + dev server
    connectSrc.push('ws://localhost:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'http://127.0.0.1:*')
  }

  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" // vite HMR
    : "script-src 'self'"

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

let daemonStartTimer: NodeJS.Timeout | null = null
let dataWatcherStartTimer: NodeJS.Timeout | null = null
let cloudStartupPromise: Promise<void> | null = null
let daemonStartupPromise: Promise<void> | null = null

app.whenReady().then(async () => {
  // 必须在 createWindow 之前装好 CSP，否则首次 loadURL/loadFile 拿不到 header
  installCspHeader()

  // ⚠️ 数据目录迁移必须是第一步！shim-writer 会创建 ~/.tidemind/bin/，
  // 一旦 ~/.tidemind/ 被任何子进程提前创建，迁移逻辑就会认为"已存在"而跳过，
  // 导致用户的 ~/.external-brain/ 数据孤立。
  try {
    const migrationResult = migrateDataDirIfNeeded(migrationLog)
    if (migrationResult.migrated) {
      migrationLog.info(`data dir migrated → ${migrationResult.newDir} (backup: ${migrationResult.backupDir})`)
    }
  } catch (err) {
    migrationLog.error('data dir migration failed:', err)
  }

  // 在任何 plugin 配置被读/写之前：刷新 shim 和 runtime-path。
  // self-heal 延迟到首屏后异步执行（见下方）。
  try {
    const result = writeShimAndRuntimePath()
    mainLog.info(`shim updated=${result.shimUpdated} runtime-path updated=${result.runtimePathUpdated} → ${result.runtimePath}`)
  } catch (err) {
    mainLog.error('writing tm-node shim failed:', err)
  }

  // 启动期同步阻塞最小化（perf-optimization-2026-05-17 P0-1）：
  // createWindow 之前只做"首屏 IPC 必需"的事：DB 打开 + handler 注册。
  // 其他全部延迟到窗口显示之后（self-heal、云模块、data-watcher、daemon）。
  let db: ReturnType<typeof getClientDb> | null = null
  try {
    db = getClientDb()
    registerAllHandlers(db, getDataDir())
  } catch (err) {
    mainLog.error('database init failed:', err)
  }

  createWindow()
  createTray()

  // 处理 app ready 之前收到的协议 URL（如从浏览器冷启动 app 的场景）
  flushPendingProtocolUrl()

  // 系统级活动信号:即使窗口不是 hide/minimize(比如用户合盖、设置 displaysleep),
  // 这两个信号也能把状态切到 idle/active,让后台任务对齐用户感知。
  try {
    powerMonitor.on('suspend', () => { getActivityState().notifySuspend() })
    powerMonitor.on('resume', () => { getActivityState().notifyResume('resume') })
    powerMonitor.on('unlock-screen', () => { getActivityState().notifyResume('unlock-screen') })
  } catch (err) {
    // powerMonitor 在某些 Linux 桌面环境可能初始化失败,降级即可:仍有 BrowserWindow 信号兜底
    mainLog.warn(`powerMonitor subscribe failed (non-fatal): ${(err as Error).message}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // ─── 以下全部不阻塞首屏：让 ready-to-show 尽快触发 ────────────────────

  // plugin self-heal：扫描外部 agent 配置文件，纯本地 I/O，但无首屏依赖
  if (db) {
    const dbForHeal = db
    queueMicrotask(() => {
      try {
        selfHealPlugins(getDataDir(), dbForHeal)
      } catch (err) {
        mainLog.error('plugin self-heal failed:', err)
      }
    })
  }

  // 云模块：完全 fire-and-forget。原 await 链让 createWindow 排在三个
  // dynamic import 之后，是冷启的主要可见瓶颈之一。
  if (db) {
    const dbForCloud = db
    cloudStartupPromise = (async () => {
      try {
        const { initAuth } = await import('./cloud/auth-client.js')
        if (getIsQuitting()) return
        initAuth()
        // 启动时未登录/未开同步则不建 client;中途登录由 OAuth 回调路径补建
        // (见 handleProtocolUrl 的 maybeStartCloudSync 调用)。
        if (!getIsQuitting()) await maybeStartCloudSync(dbForCloud)
      } catch (err) {
        mainLog.error('cloud auth init failed:', err)
      }
    })().finally(() => {
      cloudStartupPromise = null
    })
  }

  // 后台确保 Ollama 运行（本身已经是非阻塞）
  ensureOllama()

  // data-watcher 延迟 1s 启动：避开首屏 IPC 高峰，给 renderer 第一波拉数让路
  if (db) {
    const dbForWatcher = db
    dataWatcherStartTimer = setTimeout(() => {
      dataWatcherStartTimer = null
      if (getIsQuitting()) return
      try {
        startDataWatcher(dbForWatcher)
      } catch (err) {
        mainLog.error('data-watcher start failed:', err)
      }
    }, 1000)
  }

  // 内嵌守护进程延迟 2s 启动：调度任务（含 LLM）和首屏完全错开
  daemonStartTimer = setTimeout(() => {
    daemonStartTimer = null
    if (getIsQuitting()) return
    const current = startDaemon()
      .catch(err => mainLog.error('daemon start failed:', err))
      .finally(() => {
        if (daemonStartupPromise === current) daemonStartupPromise = null
      })
    daemonStartupPromise = current
  }, 2000)

  // 自动更新:打包模式下启用。initAutoUpdater 内部已判断 !app.isPackaged 直接返回。
  // scheduler 自带 30s 首检 + 4h 周期,与首屏 IPC 高峰错开。
  // try/catch 包裹防御 — 即使 electron-updater 初始化抛错(罕见,如 native 加载失败),
  // 也不能让 app 启动失败。失败时记日志,用户仍可通过 AboutSection 手动检查更新。
  if (mainWindow) {
    try {
      initAutoUpdater(mainWindow)
      scheduleUpdateChecks(runUpdateCheck)
    } catch (err) {
      mainLog.error('autoUpdater init failed (non-fatal):', err)
    }
  }
})

let quitCleanupPromise: Promise<void> | null = null
let quitCleanupComplete = false

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  event.preventDefault()
  setQuitting()
  if (daemonStartTimer) {
    clearTimeout(daemonStartTimer)
    daemonStartTimer = null
  }
  if (dataWatcherStartTimer) {
    clearTimeout(dataWatcherStartTimer)
    dataWatcherStartTimer = null
  }
  stopDataWatcher()
  // 必须停止 cloud sync client,否则 WebSocket / 重连定时器 / 慢重试 timer 全泄漏:
  // app 退出过程中 ws 仍尝试发握手或重连;若 slowRetry 触发新 ws 连接,close handler
  // 在 db 关闭后尝试写 metadata 会触发 "database is closed" 异常。
  //
  // 不能依赖 syncClientDestroyer:它只在**启动时**(已登录 + sync_enabled)被赋值。
  // 用户启动时未登录/未开同步、会话中途经 cloud:set-sync-enabled 或 cloud:trigger-sync
  // 自救路径创建的 sync client,该引用仍为 null,退出时不会被清理。改为动态 import
  // sync-client 模块、直接调 destroySyncClient()——它销毁当前 singleton(无论哪条路径
  // 建的),没有则 no-op。dynamic import 在 before-quit 同步段发起,promise 进微任务队列。
  if (quitCleanupPromise) return
  quitCleanupPromise = (async () => {
    // 先主动中止所有 LLM/CLI 子进程，再等待 daemon 与 cloud 收尾。Electron 事件
    // 本身不会 await promise，因此 before-quit 必须 preventDefault，并在全部资源
    // 已关闭后再次 app.quit()。
    const llmShutdown = import('../../src/llm/client.js')
      .then(m => m.shutdownLLMClient())
    const pendingCloudStartup = cloudStartupPromise
    const pendingDaemonStartup = daemonStartupPromise
    const cloudShutdown = (async () => {
      await pendingCloudStartup
      const cloud = await import('./cloud/sync-client.js')
      await cloud.destroySyncClient()
    })()
      .catch(err => mainLog.warn('destroySyncClient failed:', (err as Error).message))

    await llmShutdown
    // stopDaemon 会让在途 start generation 失效并等待它退出；这里保留显式引用，
    // 防止 timer callback 清空后启动 promise 变成退出 barrier 的盲区。
    const daemonShutdown = stopDaemon()
    await Promise.all([
      cloudShutdown,
      daemonShutdown,
      pendingDaemonStartup?.catch(() => undefined),
    ])
    closeClientDb()
    quitCleanupComplete = true
    app.quit()
  })().catch(err => {
    // CLI 进程或 DB 收尾未完成时禁止强退，否则 prompt 已提交的后台任务
    // 可能被错误重放。保留数据库与进程，下一次退出动作可重试清理。
    mainLog.error('quit cleanup failed; quit cancelled:', err)
    quitCleanupPromise = null
    resetQuitting()
  })
})

app.on('window-all-closed', () => {
  // macOS 关窗只隐藏(close handler 已 preventDefault),不会走到这里;此分支留给
  // Windows/Linux 关窗退出。只调 app.quit() 触发 before-quit 统一清理——绝不在此
  // 直接 closeClientDb():否则 DB 会早于 before-quit 的 stopDaemon 关闭,daemon
  // in-flight tick 撞 'database is closed'。退出顺序必须是 stopDaemon → closeClientDb。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
