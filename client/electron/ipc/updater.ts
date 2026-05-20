/**
 * Updater IPC handlers — renderer 端查询状态、手动触发检查、确认安装的入口。
 *
 * 状态变更事件('updater:state-changed')由 updater/index.ts 主动推送,renderer
 * 通过 preload 的 onStateChanged 订阅,这里不重复挂事件。
 */

import { ipcMain } from 'electron'
import { createLogger } from '@server/utils/logger.js'
import { getUpdaterState, runUpdateCheck, triggerDownload, installUpdate, setUpdateChannel } from '../updater/index.js'
import { getUpdateChannel, type UpdateChannel } from '../updater/channel.js'

const log = createLogger('ipc-updater')

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:get-state', () => getUpdaterState())

  // renderer 透传 { autoDownload }:
  //   - 设置页"检测更新"按钮:autoDownload=false,停在 available 等用户点下载
  //   - 其它内部调用(不常见,目前没有 renderer 直接传 true):走默认值 true
  //
  // **严格三态判定**(audit B-HIGH-4):
  //   - autoDownload === true → 自动下载
  //   - autoDownload === false → 停在 available
  //   - 其它(undefined / null / string / number / 缺字段)→ 默认值 true
  //
  // 不用 Boolean() cast:Boolean("no") === true / Boolean(0) === false 这种隐式
  // 转换会让 renderer 传 `{autoDownload: "no"}` 被识别成 true 进入"自动下载",
  // 跟用户预期相反。严格 === 让边界 case 安全。
  ipcMain.handle('updater:check-now', async (_event, options: unknown) => {
    let autoDownload: boolean | undefined
    if (typeof options === 'object' && options !== null && 'autoDownload' in options) {
      const raw = (options as { autoDownload: unknown }).autoDownload
      if (raw === true) autoDownload = true
      else if (raw === false) autoDownload = false
      else {
        // log.warn 不能让 sanitize 自己 crash:JSON.stringify 在 BigInt / circular
        // ref / Symbol 上会 throw,如果让 throw 一路冒上去 IPC reject,renderer
        // 看到一个混淆的错误吐司(audit C MEDIUM-4)。
        let display: string
        try {
          display = JSON.stringify(raw)
        } catch {
          display = `<unstringifiable ${typeof raw}>`
        }
        log.warn(`ignoring non-boolean autoDownload value: ${display}`)
        autoDownload = undefined
      }
    }
    log.info(`manual check triggered from renderer (autoDownload=${autoDownload ?? 'default'})`)
    await runUpdateCheck(autoDownload === undefined ? {} : { autoDownload })
  })

  // 用户在 'available' 状态下点"下载"按钮触发。
  // updater.triggerDownload() 内部有 state guard,误调用是 no-op,不需要这里再校验。
  ipcMain.handle('updater:download-now', async () => {
    log.info('manual download triggered from renderer')
    await triggerDownload()
  })

  ipcMain.handle('updater:install', () => {
    log.info('install triggered from renderer')
    installUpdate()
  })

  ipcMain.handle('updater:get-channel', (): UpdateChannel => getUpdateChannel())

  ipcMain.handle('updater:set-channel', async (_event, channel: unknown) => {
    // 显式白名单 — renderer 传 'main' / 任意字符串都会被拒。
    // 修复(2026-05-20 Audit B-13):非法值显式抛错让 renderer 能 catch 弹 toast,
    // 比静默 return undefined 调试友好;同时 await setUpdateChannel 让 renderer
    // 真正等到磁盘 + autoUpdater 一致后才解锁 UI。
    if (channel !== 'stable' && channel !== 'beta') {
      log.warn(`set-channel rejected: invalid channel=${String(channel)}`)
      throw new Error(`Invalid update channel: ${String(channel)}`)
    }
    await setUpdateChannel(channel)
  })
}
