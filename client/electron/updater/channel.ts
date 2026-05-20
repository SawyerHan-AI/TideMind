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
 *
 * 修复(2026-05-20 Audit B-3):
 *   1. **原子写**:用 tmp file + rename 替代 writeFileSync。`writeFileSync` 在
 *      macOS / Linux 上不是原子的,truncate + write 两步之间另一线程 readFileSync
 *      会读到 0 字节 → parseToml('') → {} → 触发的 getConfig() 全字段 fallback
 *      到默认值 → 用户的 cloud session / data_dir / LLM provider 等都退到默认。
 *   2. **inflight 锁**:用户在 settings 上快速双击 Stable→Beta→Stable 会让两次
 *      setUpdateChannel 并发 read-modify-write,后写覆盖前写没问题,但中间窗口
 *      其他 IPC 的 getConfig() 还是可能读到部分写入。串行化 setUpdateChannel 自身。
 *      其他模块在 setUpdateChannel 跑期间调 getConfig 仍可能读到旧 raw,但读到的
 *      永远是"完整 raw",不会是"0 字节"。
 */
let setChannelInflight: Promise<void> = Promise.resolve()
export function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  const next = setChannelInflight.then(() => doSetUpdateChannel(channel))
  // chain 当前 inflight,不暴露错误中断后续调用
  setChannelInflight = next.catch(() => undefined)
  return next
}

function doSetUpdateChannel(channel: UpdateChannel): void {
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

  // 原子写:tmp file + rename(POSIX rename(2) 是原子的,跨设备不可用但 dataDir
  // 一定与 tmp file 同卷)。.tmp 文件用 pid + 时间戳避免多个 Electron 实例打架。
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmpPath, stringifyToml(raw), 'utf-8')
    fs.renameSync(tmpPath, configPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
  reloadConfig()
  log.info(`channel persisted → ${channel}`)
}
