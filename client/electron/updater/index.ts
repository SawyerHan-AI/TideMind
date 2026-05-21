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
import { setQuitting, resetQuitting } from '../lifecycle.js'

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
  const prev = currentState
  currentState = next
  // 2026-05-21 修复:download-progress event 每秒触发数次,每次 setState 都打一行
  // `state → downloading` 重复 log(实测一次升级 10 秒打 34 行同样日志)。如果
  // 跟前一次 state 完全同形(status + version 相同),只更新 state 不打 log。
  // version 不同(可能 staged rollout 切版本)或 status 不同时仍打,保留转移记录。
  const prevVersion = (prev as { version?: string }).version
  const nextVersion = (next as { version?: string }).version
  const sameAsPrev = prev.status === next.status && prevVersion === nextVersion
  if (!sameAsPrev) {
    log.info(`state → ${next.status}${'version' in next ? ` (${next.version})` : ''}`)
  }
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:state-changed', next)
  }
}

export function getUpdaterState(): UpdaterState {
  return currentState
}

/**
 * Outer-level timeout 包装(2026-05-21 audit B-MEDIUM-2)。
 *
 * queryAndVerifyManifest 内部依赖 fetch + manifest 解析,理论上有内部 timeout,
 * 但历史曾出现 cloud-server endpoint 异常时 inflight 永远不释放、UI 卡 'checking'
 * 直到 app 重启。autoUpdater.checkForUpdates 同理。outer timeout 兜底:
 *   - 60s 超时 → reject + 调用方 catch 走 'error' 状态
 *   - inflight 释放
 *   - 4h 后 scheduler 再来一次,自动恢复
 *
 * 注意:不给 downloadUpdate 加 timeout,大文件下载可能 5-10 分钟,timeout 反而
 * 会误伤正常路径;downloadUpdate 由 'download-progress' 事件持续刷新状态。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

const MANIFEST_QUERY_TIMEOUT_MS = 60_000
const ELECTRON_UPDATER_CHECK_TIMEOUT_MS = 60_000

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
    // Audit-3 F3 修复(对应):此处也不再清 pendingMandatory。autoUpdater error 通常是
    // download / verify 失败,业务侧"mandatory 强制升级"标记不应该被这种瞬时错误清掉,
    // 让下一轮 check 重新走服务端 mandatory 字段(no-update / fetch-error / staged-out
    // 等分支已显式清)。
    //
    // F6 兜底:如果 error 触发在 'downloaded'/'downloading' 状态(install 或下载阶段),
    // 之前 setQuitting() 可能已经被调过(installUpdate);autoUpdater 内部 error 路径必须
    // 把 isQuitting 重置,否则 close handler 后续会误判 user-initiated quit。
    if (currentState.status === 'downloaded' || currentState.status === 'downloading') {
      resetQuitting()
    }
    setState({ status: 'error', message: err.message })
  })

  log.info('initialized')
}

/**
 * 完整检查流程:端点查询 + 验签 + 灰度判定 + 触发下载。
 *
 * inflight 锁防止 scheduler / 手动触发并发多次进入 — 同时刻只允许一个检查在跑。
 *
 * **autoDownload 语义**(2026-05-21 重构):
 *   - true (默认): 命中新版立即调 autoUpdater.downloadUpdate() → 直接进入 downloading
 *     用于 scheduler 启动 5s / 每 4h 定时检查 / setChannel 切换后兜底检查
 *   - false: 命中新版后停在 'available' 状态等用户手动调 triggerDownload()
 *     用于设置页用户主动点"检测更新",体感是"查到 → 看到新版本 → 点下载"两步
 *
 * **mandatory 强制下载**:无论 autoDownload 传什么,mandatory=true 都立即下载。
 * 强制更新不给用户选择。
 *
 * **'available' 状态的并发安全**:autoDownload=false 留下 'available' 状态后,
 * 4h 定时器到了 scheduler 会再来一次 runUpdateCheck(默认 autoDownload=true)。
 * 这次 check 看到 currentState.status === 'available' 不在 skip 列表里(只 skip
 * downloading / downloaded),会重新走 checking → available → 自动 download,
 * 用户停滞 4h 没操作的窗口期最长。
 */
export async function runUpdateCheck(
  options: { autoDownload?: boolean } = {}
): Promise<void> {
  const autoDownload = options.autoDownload ?? true

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
    const result = await withTimeout(
      queryAndVerifyManifest(),
      MANIFEST_QUERY_TIMEOUT_MS,
      'queryAndVerifyManifest'
    )

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

    // CRITICAL 防御(2026-05-21 audit B-CRITICAL):
    // verifier 验过 cloud-server manifest 后,让 electron-updater 也拉一次 GitHub
    // manifest 做 **version cross-check**。两边 version 不一致 → 标记 signature-invalid。
    //
    // 关闭的攻击路径:攻击者控制 GitHub 账号但未拿到 ed25519 私钥,推恶意 release
    // (改 SHA512 + 用同 cert 重签 binary)→ cloud-server manifest 仍是受信的旧 version,
    // GitHub 是新的恶意 version → 这里 mismatch 会被拦截。
    //
    // 同时 electron-updater 内部会 cache 这次 checkForUpdates 拿到的 manifest。
    // 后续 downloadUpdate(无论自动路径还是 triggerDownload)都**复用 cache**,
    // 不再独立去 GitHub 拉,所以"verifier 通过 → 用户停在 available → 攻击者
    // 推 GitHub 恶意 release → 用户点下载"的窗口期被关闭。
    log.info(`pre-fetching electron-updater manifest for cross-check (verifier said v${result.version})`)
    let euVersion: string | undefined
    let euCheckFailed = false
    try {
      const euResult = await withTimeout(
        autoUpdater.checkForUpdates(),
        ELECTRON_UPDATER_CHECK_TIMEOUT_MS,
        'autoUpdater.checkForUpdates'
      )
      euVersion = euResult?.updateInfo.version
    } catch (err) {
      // 不直接 return — 之前的实现错误地假设 autoUpdater.on('error') 已经 setState
      // 'error',但 withTimeout race / GitHub 404 / ERR_UPDATER_CHANNEL_FILE_NOT_FOUND
      // 等典型"GitHub release 还没就绪" 错误**不会** trigger autoUpdater.on('error'),
      // 也就是说之前 UI 会卡在 'checking' 直到下一轮 scheduler — 而这恰好是 release-pending
      // 想消除的核心场景。v0.2.72 audit HIGH 1。
      log.warn(
        `electron-updater checkForUpdates failed (${(err as Error).message}) — ` +
        `interpreting as release-pending (GitHub release likely still rolling out)`
      )
      euCheckFailed = true
    }

    // Cross-check 二态(2026-05-21 audit HIGH-1 + Agent C MEDIUM-2 修复):
    //   1. release-pending:任何让 cross-check 拿不到 verifier-equal version 的
    //      情况都归这一类 — electron-updater throw / 看到空 / 看到当前版本 /
    //      看到不一致版本。**所有非验签问题归一处**,文案"rolling out"灰色提示,
    //      不放红色危险标识。
    //   2. cross-check OK:两边 version 一致,继续推进 available。
    //
    // 旧实现把 "version 不一致" 标 signature-invalid 红色危险,但实际上这种情况
    // 99% 是 cloud-server cache lag / GitHub CDN 同步,不是 supply chain 攻击。
    // 即使是攻击者控制 GitHub 推恶意 release,后续 codesign + notarize + verifier
    // 端的 ed25519 验签三重防御兜底,cross-check 不必扮演"红色告警"角色。
    //
    // signature-invalid 状态留给 verifier 端 ed25519 验签真正失败时(result.status
    // === 'invalid' 分支已经处理),那才是供应链信号。
    const currentAppVersion = app.getVersion()
    const crossCheckOk =
      !euCheckFailed && !!euVersion && euVersion !== currentAppVersion && euVersion === result.version

    if (!crossCheckOk) {
      log.info(
        `release-pending: cloud-server says v${result.version}, ` +
        `electron-updater sees v${euVersion ?? '(none/error)'} — waiting for next 4h check`
      )
      pendingMandatory = false
      setState({ status: 'release-pending', version: result.version ?? '' })
      return
    }
    log.info(`cross-check OK: both sides say v${result.version}`)

    // 锁住 mandatory 到 pendingMandatory,跨过 'downloading' 中间态不丢
    pendingMandatory = mandatory
    setState({
      status: 'available',
      version: result.version ?? '',
      releaseNotes: result.releaseNotes,
      mandatory,
    })

    // 手动 check 且非强制更新:停在 available,等用户调 triggerDownload()
    if (!autoDownload && !mandatory) {
      log.info(`manual check found ${result.version}, waiting for user to trigger download`)
      return
    }

    log.info(`triggering electron-updater download for ${result.version}`)
    // checkForUpdates 已经在 cross-check 阶段调过,electron-updater 内部 cache 了
    // manifest,直接 downloadUpdate 复用 cache。
    await autoUpdater.downloadUpdate()
  } catch (err) {
    log.error(`runUpdateCheck failed: ${(err as Error).message}`)
    // Audit-3 F3 修复:不要在错误路径清 pendingMandatory。
    // pendingMandatory 只在下一轮 check 真拿到 mandatory=false 的服务端响应时清(no-update / fetch-error /
    // invalid / staged-out / release-pending 分支都已显式清)。否则 download 失败一次就清掉,
    // 会让"网络一抖 → 永远逃过强制升级"成为绕过路径。
    setState({ status: 'error', message: (err as Error).message })
  } finally {
    inflight = false
  }
}

/**
 * 用户手动触发下载(仅在 'available' 状态下生效)。
 *
 * 配合 runUpdateCheck({ autoDownload: false }) 的两步走流程:
 *   1. 用户点"检测更新" → runUpdateCheck({ autoDownload: false }) → 停在 'available'
 *      (期间已经做过 verifier 验签 + electron-updater cross-check)
 *   2. 用户点"下载"      → triggerDownload()                       → 进入 'downloading'
 *
 * **不再独立调 autoUpdater.checkForUpdates**(2026-05-21 CRITICAL 修复):
 * runUpdateCheck 阶段已经 cross-check 过 cloud-server 跟 GitHub 两边的 version,
 * electron-updater 内部 cache 了 manifest。这里直接 downloadUpdate 复用 cache,
 * 不留"用户停在 available 期间 GitHub manifest 被替换"的攻击窗口期。
 *
 * 状态守卫:不在 'available' 时直接 return,避免 renderer 误触把 'idle' /
 * 'downloaded' 等无关状态推进到非法路径。
 *
 * inflight 互斥:跟 runUpdateCheck 共用同一个 inflight 锁。极端竞态(用户点
 * "下载"恰好 scheduler 也在跑 check)下 throw error,renderer 可 catch 后给反馈;
 * silent skip 会让 UI 没有任何变化让用户困惑(audit B-HIGH-3 修复)。
 */
export async function triggerDownload(): Promise<void> {
  if (!initialized) {
    log.info('triggerDownload called but updater not initialized')
    return
  }
  if (currentState.status !== 'available') {
    log.info(`triggerDownload skipped: state=${currentState.status} (expected 'available')`)
    return
  }
  if (inflight) {
    log.warn('triggerDownload rejected: another updater operation in progress')
    // 不 silent skip — renderer 拿不到反馈会以为按钮坏了。throw 让 IPC reject,
    // 调用方可以 toast。
    throw new Error('Update operation in progress, please try again in a moment')
  }

  inflight = true
  try {
    log.info(`user triggered download for ${currentState.version} (using cached manifest from prior cross-check)`)
    // 复用 runUpdateCheck 阶段 electron-updater 内部 cache 的 manifest(version
    // 已 cross-check 过)。不重新走 checkForUpdates。
    await autoUpdater.downloadUpdate()
  } catch (err) {
    log.error(`triggerDownload failed: ${(err as Error).message}`)
    // Audit-3 F3:download 失败时不清 pendingMandatory,保留 mandatory 让下次重试 / 下一轮 check 时
    // 仍能强制弹窗(网络问题导致下载失败时尤其重要)。
    setState({ status: 'error', message: (err as Error).message })
    throw err
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
 *
 * 修复(2026-05-21 audit B-MEDIUM-1):autoDownload=false。切 channel 的语义是
 * "我想看看新 channel 有没有新版",**不是**"立即下载新 channel 任何版本"——
 * 跟设置页"检测更新"按钮一致。命中新版后停在 'available',等用户决定下不下载。
 * mandatory 版本仍然自动下载(runUpdateCheck 内部规则),所以强制更新路径不变。
 */
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await persistChannel(channel)
  if (initialized) {
    applyChannelToAutoUpdater()
    runUpdateCheck({ autoDownload: false }).catch(err =>
      log.warn(`post-switch update check failed: ${(err as Error).message}`)
    )
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
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    // Audit-3 F6 修复:quitAndInstall 抛错时 isQuitting 已被置 true,
    // 但 app 实际没退出 — 必须 reset 否则下次用户关窗口的 mac tray pattern 会
    // 误判为 user-initiated quit 让 close handler 放行真退出。
    log.error(`quitAndInstall failed: ${(err as Error).message}`)
    resetQuitting()
    setState({ status: 'error', message: 'install_failed' })
  }
}
