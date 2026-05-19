/**
 * 更新频道读取。
 *
 * P0:只读取(默认 stable),P1 引入 Beta 切换时再加 setter。
 * Setter 走 ipc/config.ts 的 config:update IPC,renderer 调用,会自动 reloadConfig。
 */

import { getConfig } from '@server/config.js'

export type UpdateChannel = 'stable' | 'beta'

export function getUpdateChannel(): UpdateChannel {
  return getConfig().update?.channel ?? 'stable'
}
