import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { getCircuitState, setHealthChangeListener } from '../../../src/metabolism/scheduler'

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

  // 把 core scheduler 的状态变化 hook 接到 BrowserWindow 广播。
  // 注意：core 层 (src/metabolism/scheduler.ts) 不能直接 import electron，
  // 通过 setHealthChangeListener 注入回调实现解耦。
  setHealthChangeListener(() => broadcastHealth(db))
}
