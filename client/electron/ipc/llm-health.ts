import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { getCircuitState, resetCircuitBreaker, setHealthChangeListener } from '../../../src/metabolism/scheduler'
import { clearClientCache } from '../../../src/llm/client'
import { triggerImmediateSchedulerTick } from '../daemon'
import { createLogger } from '../../../src/utils/logger'

const log = createLogger('ipc:llm-health')

export interface LLMHealthSnapshot {
  circuitState: 'closed' | 'open' | 'half-open'
  failures: number
  openedAt: number
  cooldownMs: number
  lastSuccessAt: number
  lastError: string | null
  lastErrorAt: number
}

function readSnapshot(db: Database.Database): LLMHealthSnapshot {
  const rows = db.prepare(
    `SELECT key, value FROM metadata
     WHERE key IN (
       'circuit_breaker_opened_at',
       'llm_last_success_at',
       'llm_last_error',
       'llm_last_error_at'
     )`,
  ).all() as Array<{ key: string; value: string }>
  const m = new Map(rows.map(r => [r.key, r.value]))
  const circuit = getCircuitState(db)
  return {
    circuitState: circuit.state,
    failures: circuit.failures,
    openedAt: Number(m.get('circuit_breaker_opened_at') ?? 0),
    cooldownMs: circuit.cooldownMs,
    lastSuccessAt: Number(m.get('llm_last_success_at') ?? 0),
    lastError: m.get('llm_last_error') ?? null,
    lastErrorAt: Number(m.get('llm_last_error_at') ?? 0),
  }
}

function broadcastHealth(db: Database.Database): void {
  let snapshot: LLMHealthSnapshot
  try { snapshot = readSnapshot(db) }
  catch { return /* main 进程不应因诊断查询失败崩溃 */ }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('llm-health-changed', snapshot)
    } catch { /* 窗口已销毁等竞态，忽略 */ }
  }
}

export function registerLLMHealthHandlers(db: Database.Database): void {
  ipcMain.handle('llm:health', () => readSnapshot(db))

  // 用户在 UI 上点「立即重试」时调用:
  //   1. 强制重置熔断器(清 failures + openedAt + cooldownMs)
  //   2. 清掉 LLM client cache(避免上次坏 SDK 实例被复用)
  //   3. 立即触发一次 scheduler tick(不等下个 60s/600s tick 周期)
  // 返回新的 snapshot 给 UI 即时刷新。
  ipcMain.handle('llm:reset-and-retry', async () => {
    try {
      resetCircuitBreaker(db)
      clearClientCache()
      // fire-and-forget tick——不 await,避免 IPC 调用一直等到 LLM 调用完成。
      // 用户点按钮的语义是"赶紧跑一下",不需要等结果(snapshot 会通过 health-change 自动推)。
      triggerImmediateSchedulerTick().catch(err => {
        log.warn(`triggerImmediateSchedulerTick 失败: ${(err as Error).message}`)
      })
    } catch (err) {
      log.error(`llm:reset-and-retry 失败: ${(err as Error).message}`)
      throw err
    }
    return readSnapshot(db)
  })

  // 注: 没有单独的 'llm:reset-circuit-breaker' IPC。connection 凭据变更场景由
  // connections.ts 内部直接调 clearClientCache() + resetCircuitBreaker() 处理,
  // 不需要走 IPC(那是同进程内部调用)。

  // 把 core scheduler 的状态变化 hook 接到 BrowserWindow 广播。
  // 注意：core 层 (src/metabolism/scheduler.ts) 不能直接 import electron，
  // 通过 setHealthChangeListener 注入回调实现解耦。
  setHealthChangeListener(() => broadcastHealth(db))
}
