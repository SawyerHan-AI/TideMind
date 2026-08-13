import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import {
  listConnectionHealth,
  resetConnectionHealth,
  setConnectionHealthChangeListener,
} from '../../../src/llm/connection-health'
import {
  setActiveLLMTaskListener,
  type ActiveLLMTask,
} from '../../../src/llm/invocation-context'
import { clearClientCache } from '../../../src/llm/client'
import { getMetabolismWorkerDegradedReason, restartMetabolismWorkerAndTriggerImmediate } from '../daemon'
import { createLogger } from '../../../src/utils/logger'
import { MetabolismWorkerActiveTaskMirror } from '../workers/metabolism-worker-active-task-mirror'
import type { MetabolismWorkerToMainMessage } from '../workers/metabolism-worker-protocol'

const log = createLogger('ipc:llm-health')

export interface ConnectionHealthItem {
  connectionId: string
  connectionName: string
  providerType: string
  kind: string
  message: string
  needsUserAction: boolean
  occurredAt: number
  retryAt: number | null
  circuitState: 'closed' | 'open' | 'half-open'
  openedAt: number | null
  cooldownMs: number
}

export interface LLMHealthSnapshot {
  // Legacy fields remain during the renderer migration.
  circuitState: 'closed' | 'open' | 'half-open'
  failures: number
  openedAt: number
  cooldownMs: number
  lastSuccessAt: number
  lastError: string | null
  lastErrorAt: number
  availableCount: number
  needsAttentionCount: number
  errors: ConnectionHealthItem[]
  activeTask: ActiveLLMTask | null
  metabolismWorkerDegradedReason: string | null
}

let activeTask: ActiveLLMTask | null = null
const activeTaskMirror = new MetabolismWorkerActiveTaskMirror()

export function readLLMHealthSnapshot(db: Database.Database): LLMHealthSnapshot {
  const connections = db.prepare(`
    SELECT id, name, provider_type, status, status_reason, archived
    FROM model_connections
    WHERE archived = 0
  `).all() as Array<{
    id: string
    name: string
    provider_type: string
    status: string
    status_reason: string | null
    archived: number
  }>
  const connectionById = new Map(connections.map(row => [row.id, row]))
  const health = listConnectionHealth(db)
  const errors: ConnectionHealthItem[] = []
  const healthConnections = new Set<string>()

  for (const item of health) {
    if (!item.connectionId) continue
    const connection = connectionById.get(item.connectionId)
    if (!connection) continue
    healthConnections.add(item.connectionId)
    if (!item.lastErrorKind || !item.lastErrorMessage) continue
    errors.push({
      connectionId: item.connectionId,
      connectionName: connection.name,
      providerType: item.providerType,
      kind: item.lastErrorKind,
      message: item.lastErrorMessage,
      needsUserAction: item.needsUserAction,
      occurredAt: item.lastErrorAt ?? 0,
      retryAt: item.retryAt,
      circuitState: item.circuitState,
      openedAt: item.openedAt,
      cooldownMs: item.cooldownMs,
    })
  }

  const unavailableStatuses = new Set([
    'not_installed',
    'not_authenticated',
    'wrong_auth_method',
    'unsupported_version',
    'offline',
    'ambiguous',
  ])
  for (const connection of connections) {
    if (
      unavailableStatuses.has(connection.status)
      && !healthConnections.has(connection.id)
    ) {
      errors.push({
        connectionId: connection.id,
        connectionName: connection.name,
        providerType: connection.provider_type,
        kind: connection.status,
        message: connection.status_reason ?? connection.status,
        needsUserAction: connection.status !== 'offline',
        occurredAt: 0,
        retryAt: null,
        circuitState: 'open',
        openedAt: null,
        cooldownMs: 0,
      })
    }
  }

  errors.sort((a, b) => {
    if (a.needsUserAction !== b.needsUserAction) return a.needsUserAction ? -1 : 1
    return b.occurredAt - a.occurredAt
  })
  // “可用”与模型选择采用同一口径：只有至少一个模型通过真实测试，
  // 连接才会进入 online/degraded。环境检查成功但尚未测试的 untested
  // 不能被统计为可用，否则状态卡会和 verified-only 下拉菜单互相矛盾。
  const callableStatuses = new Set(['online', 'degraded'])
  const availableCount = connections.filter(row => callableStatuses.has(row.status)).length
  const lastSuccessAt = health.reduce(
    (max, item) => Math.max(max, item.lastSuccessAt ?? 0),
    0,
  )
  const worst = health
    .filter(item => item.circuitState !== 'closed')
    .sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0))[0]

  return {
    circuitState: worst?.circuitState ?? 'closed',
    failures: worst?.failureCount ?? 0,
    openedAt: worst?.openedAt ?? 0,
    cooldownMs: worst?.cooldownMs ?? 5 * 60_000,
    lastSuccessAt,
    lastError: errors[0]?.message ?? null,
    lastErrorAt: errors[0]?.occurredAt ?? 0,
    availableCount,
    needsAttentionCount: errors.length,
    errors,
    activeTask,
    metabolismWorkerDegradedReason: getMetabolismWorkerDegradedReason(),
  }
}

export function broadcastLLMHealth(db: Database.Database): void {
  let snapshot: LLMHealthSnapshot
  try { snapshot = readLLMHealthSnapshot(db) }
  catch { return }
  for (const win of BrowserWindow?.getAllWindows?.() ?? []) {
    try {
      if (!win.isDestroyed()) win.webContents.send('llm-health-changed', snapshot)
    } catch {
      // Window destruction races are expected during shutdown.
    }
  }
}

export function applyMetabolismWorkerStatusMessage(
  db: Database.Database,
  message: MetabolismWorkerToMainMessage,
): void {
  if (message.kind === 'active_llm_task_started' || message.kind === 'active_llm_task_cleared') {
    activeTaskMirror.applyWorkerMessage(message)
    activeTask = activeTaskMirror.projectActiveLLMTask()
    broadcastLLMHealth(db)
  } else if (message.kind === 'health_changed') {
    broadcastLLMHealth(db)
  }
}

export function clearMetabolismWorkerGenerationStatus(
  db: Database.Database,
  lifecycleGeneration: number,
): void {
  activeTaskMirror.clearWorkerGeneration(lifecycleGeneration)
  activeTask = activeTaskMirror.projectActiveLLMTask()
  broadcastLLMHealth(db)
}

export function registerLLMHealthHandlers(db: Database.Database): void {
  ipcMain.handle('llm:health', () => readLLMHealthSnapshot(db))

  ipcMain.handle('llm:reset-and-retry', async (_event, connectionId?: unknown) => {
    if (typeof connectionId !== 'string' || !/^mc_[a-f0-9]{8}$/.test(connectionId)) {
      throw new Error('必须指定有效的模型连接')
    }
    try {
      resetConnectionHealth(db, connectionId)
      clearClientCache()
      await restartMetabolismWorkerAndTriggerImmediate()
    } catch (err) {
      log.error(`llm:reset-and-retry 失败: ${(err as Error).message}`)
      throw err
    }
    return readLLMHealthSnapshot(db)
  })

  setConnectionHealthChangeListener(() => broadcastLLMHealth(db))
  setActiveLLMTaskListener(task => {
    activeTaskMirror.updateMain(task)
    activeTask = activeTaskMirror.projectActiveLLMTask()
    broadcastLLMHealth(db)
  })
}
