/**
 * 自动更新入口:整合 electron-updater + cloud-server manifest 端点 + ed25519 验签。
 *
 * 混合方案 C:
 *   1. 调 cloud-server 端点查询新版本 + 验签(防 GitHub 账号被盗后推恶意 release)
 *   2. 验签通过 → 灰度判定 → 触发 electron-updater 走 GitHub provider 下载(SHA512 校验 + macOS codesign)
 *   3. 'update-downloaded' → 横幅提示用户重启
 *
 * 开发模式(app.isPackaged === false)直接跳过整套流程,避免开发环境干扰。
 */

import { app, BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { createLogger } from '@server/utils/logger.js'
import { getDataDir } from '@server/config.js'
import type { UpdaterState } from '../../src/lib/api-contract'
import { queryAndVerifyManifest } from './verifier.js'
import { isInStagingBatch } from './staging.js'
import { getUpdateChannel, setUpdateChannel as persistChannel, type UpdateChannel } from './channel.js'
import { setQuitting } from '../lifecycle.js'

const log = createLogger('updater')

export type { UpdaterState }

let currentState: UpdaterState = { status: 'idle' }
let mainWindowRef: BrowserWindow | null = null
let initialized = false
let inflight = false
/**
 * mandatory 标记的模块级"幽灵"载体。
 *
 * 修复(2026-05-20 Audit B-11):mandatory 在 'available' state 上设置,但
 * autoUpdater 触发 downloadUpdate 后会先 emit 一系列 'download-progress' 事件
 * 把 state 改成 'downloading'(没有 mandatory 字段),最后 emit 'update-downloaded'。
 * 原实现读 `currentState.status === 'available' ? currentState.mandatory : false`
 * → state 已经是 'downloading' 了,mandatory 永远评估为 false → MandatoryUpdateModal
 * 永远不显示。这是 mandatory 整个 feature 的关键 bug,生产从未跑过所以一直没暴露。
 * 用一个模块级 let 把 mandatory 锁住到 reset(idle / error / 新一轮 check)为止。
 */
let pendingMandatory = false

function setState(next: UpdaterState): void {
  currentState = next
  log.info(`state → ${next.status}${'version' in next ? ` (${next.version})` : ''}`)
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:state-changed', next)
  }
}

export function getUpdaterState(): UpdaterState {
  return currentState
}

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  if (initialized) {
    log.warn('initAutoUpdater called more than once, ignoring')
    return
  }
  if (!app.isPackaged) {
    log.info('skipped (dev mode, !app.isPackaged)')
    return
  }
  initialized = true
  mainWindowRef = mainWindow

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  applyChannelToAutoUpdater()
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`[eu] ${String(m)}`),
    warn: (m: unknown) => log.warn(`[eu] ${String(m)}`),
    error: (m: unknown) => log.error(`[eu] ${String(m)}`),
    debug: () => {},
  }

  autoUpdater.on('update-available', (info) => {
    log.info(`electron-updater confirmed update available: ${info.version}`)
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info(`electron-updater says no update: ${info.version}`)
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const version = 'version' in currentState ? (currentState as { version?: string }).version ?? '' : ''
    setState({
      status: 'downloading',
      version,
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // 读模块级 pendingMandatory —— 'available' → 'downloading'(download-progress)
    // → 'downloaded' 的转移路径上,'downloading' state 不带 mandatory 字段。靠
    // currentState.status === 'available' 判定永远评不到 mandatory,模态永远不弹。
    setState({
      status: 'downloaded',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 500) : undefined,
      mandatory: pendingMandatory,
    })
  })

  autoUpdater.on('error', (err) => {
    log.error(`electron-updater error: ${err.message}`)
    // 错误路径重置 mandatory,避免下一轮 check 拿到错误值
    pendingMandatory = false
    setState({ status: 'error', message: err.message })
  })

  log.info('initialized')
}

/**
 * 完整检查流程:端点查询 + 验签 + 灰度判定 + 触发下载。
 *
 * inflight 锁防止 scheduler / 手动触发并发多次进入 — 同时刻只允许一个检查在跑。
 */
export async function runUpdateCheck(): Promise<void> {
  if (!initialized) {
    log.info('runUpdateCheck called but updater not initialized (dev mode or init failed)')
    return
  }
  if (inflight) {
    log.info('check already in progress, skipping')
    return
  }
  if (currentState.status === 'downloading' || currentState.status === 'downloaded') {
    log.info(`check skipped: state=${currentState.status}`)
    return
  }

  inflight = true
  setState({ status: 'checking' })

  try {
    const result = await queryAndVerifyManifest()

    if (result.status === 'no-update') {
      pendingMandatory = false
      setState({ status: 'up-to-date', version: result.version ?? app.getVersion() })
      return
    }
    if (result.status === 'fetch-error') {
      pendingMandatory = false
      setState({ status: 'error', message: 'manifest fetch failed' })
      return
    }
    if (result.status === 'invalid') {
      pendingMandatory = false
      setState({
        status: 'signature-invalid',
        version: result.version ?? '',
        releaseUrl: result.releaseUrl,
      })
      return
    }

    const mandatory = result.mandatory ?? false
    if (!mandatory && !isInStagingBatch(result.stagingPercentage, getDataDir())) {
      log.info(`staged-out: percentage=${result.stagingPercentage}, version=${result.version}`)
      pendingMandatory = false
      setState({ status: 'staged-out', version: result.version ?? '' })
      return
    }

    // 锁住 mandatory 到 pendingMandatory,跨过 'downloading' 中间态不丢
    pendingMandatory = mandatory
    setState({
      status: 'available',
      version: result.version ?? '',
      releaseNotes: result.releaseNotes,
      mandatory,
    })

    log.info(`triggering electron-updater download for ${result.version}`)
    await autoUpdater.checkForUpdates()
    await autoUpdater.downloadUpdate()
  } catch (err) {
    log.error(`runUpdateCheck failed: ${(err as Error).message}`)
    setState({ status: 'error', message: (err as Error).message })
  } finally {
    inflight = false
  }
}

function applyChannelToAutoUpdater(): void {
  const channel = getUpdateChannel()
  // GitHub provider 下 allowPrerelease=true 让 autoUpdater 在拉 manifest 时接受
  // prerelease tag 的 release。verifier.ts 也会把 channel 传给 cloud-server 端点,
  // 端点路由 prerelease。两端一致才能保证 Beta 流程贯通。
  autoUpdater.allowPrerelease = channel === 'beta'
  log.info(`channel applied → ${channel} (allowPrerelease=${autoUpdater.allowPrerelease})`)
}

/**
 * 切换更新频道:持久化到 config.toml 并立即应用到 autoUpdater 实例。
 *
 * 老版本下载完未安装时切换 channel,不会撤回那条下载 — quitAndInstall 仍生效。
 * 切换的"立即生效"只针对未来检查路径。
 *
 * 修复(2026-05-20 Audit B-12):切换后立即 fire-and-forget 触发一次 runUpdateCheck,
 * 让用户切到新 channel 后不用等 4h 周期才看到新版本。inflight 锁会 skip 当前
 * 正在跑的 check,不会双跑。
 */
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await persistChannel(channel)
  if (initialized) {
    applyChannelToAutoUpdater()
    runUpdateCheck().catch(err => log.warn(`post-switch update check failed: ${(err as Error).message}`))
  }
}

export function installUpdate(): void {
  if (!initialized) {
    log.warn('installUpdate called but updater not initialized')
    return
  }
  if (currentState.status !== 'downloaded') {
    log.warn(`installUpdate called with state=${currentState.status}, ignoring`)
    return
  }
  log.info('quitAndInstall')
  // 修复(2026-05-20 Audit B-5):
  // 原实现 setTimeout(app.exit(0), 500) 是个错误诊断的 workaround。
  // 真正的 root cause 是:autoUpdater.quitAndInstall 内部走 app.quit() 触发
  // mainWindow.on('close'),close handler 看到 isQuitting=false 就 preventDefault
  // 把窗口隐藏(macOS tray pattern),进程不退 → Squirrel.Mac swap 完 forceRunAfter
  // 也跑不起来。
  // 正确做法:在 quitAndInstall 之前显式标记 quit 意图,close handler 见 isQuitting=true
  // 放行真正的 quit 路径,before-quit 钩子能跑完(syncClient 清理 / closeClientDb /
  // SQLite WAL flush),autoUpdater 完成 swap 后正常 relaunch。
  // app.exit(0) 这种硬退出会跳过 before-quit,WAL 状态不一致风险 + sync 数据丢失。
  setQuitting()
  autoUpdater.quitAndInstall(false, true)
}
