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

const log = createLogger('updater')

export type { UpdaterState }

let currentState: UpdaterState = { status: 'idle' }
let mainWindowRef: BrowserWindow | null = null
let initialized = false
let inflight = false

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
    setState({
      status: 'downloaded',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 500) : undefined,
      mandatory: false,
    })
  })

  autoUpdater.on('error', (err) => {
    log.error(`electron-updater error: ${err.message}`)
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
      setState({ status: 'up-to-date', version: result.version ?? app.getVersion() })
      return
    }
    if (result.status === 'fetch-error') {
      setState({ status: 'error', message: 'manifest fetch failed' })
      return
    }
    if (result.status === 'invalid') {
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
      setState({ status: 'staged-out', version: result.version ?? '' })
      return
    }

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
  autoUpdater.quitAndInstall(false, true)
}
