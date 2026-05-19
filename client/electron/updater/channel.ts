/**
 * 更新频道读写。
 *
 * Setter 直接改 config.toml 并刷新缓存(reloadConfig),再触发 autoUpdater 重新读 channel。
 * 比让 renderer 走 config:update IPC + 再调 updater:reload-channel 两步少一次跳转,
 * 减少 channel 切换期间状态不一致的窗口。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { getConfig, getDataDir, reloadConfig } from '@server/config.js'
import { createLogger } from '@server/utils/logger.js'

const log = createLogger('updater-channel')

export type UpdateChannel = 'stable' | 'beta'

export function getUpdateChannel(): UpdateChannel {
  return getConfig().update?.channel ?? 'stable'
}

/**
 * 把 channel 写入 ${dataDir}/config.toml 的 [update] 节点,然后刷新 config 缓存。
 *
 * Why: renderer 切换 Beta 频道时必须持久化,不能只改内存;同时 autoUpdater 实例需要
 * 读最新值才能在下次检查时拉对应 channel 的 release。
 * How to apply: 配合 updater/index.ts reloadChannel() 立即对当前 autoUpdater 生效。
 */
export function setUpdateChannel(channel: UpdateChannel): void {
  const configPath = path.join(getDataDir(), 'config.toml')
  let raw: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      raw = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch (err) {
      log.warn(`parse config.toml failed: ${(err as Error).message},rewriting from scratch`)
      raw = {}
    }
  }
  const update = (raw.update && typeof raw.update === 'object' ? raw.update : {}) as Record<string, unknown>
  update.channel = channel
  raw.update = update
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, stringifyToml(raw), 'utf-8')
  reloadConfig()
  log.info(`channel persisted → ${channel}`)
}
