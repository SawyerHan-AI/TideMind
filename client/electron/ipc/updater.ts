/**
 * Updater IPC handlers — renderer 端查询状态、手动触发检查、确认安装的入口。
 *
 * 状态变更事件('updater:state-changed')由 updater/index.ts 主动推送,renderer
 * 通过 preload 的 onStateChanged 订阅,这里不重复挂事件。
 */

import { ipcMain } from 'electron'
import { createLogger } from '@server/utils/logger.js'
import { getUpdaterState, runUpdateCheck, installUpdate } from '../updater/index.js'

const log = createLogger('ipc-updater')

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:get-state', () => getUpdaterState())

  ipcMain.handle('updater:check-now', async () => {
    log.info('manual check triggered from renderer')
    await runUpdateCheck()
  })

  ipcMain.handle('updater:install', () => {
    log.info('install triggered from renderer')
    installUpdate()
  })
}
