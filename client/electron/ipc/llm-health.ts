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
import { getConfig } from '../../../src/config'
import { buildConnectionModelsView } from '../../../src/llm/model-catalog-view'
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

export interface RouteFaultItem {
  tier: 'light' | 'standard' | 'heavy'
  connectionId: string
  connectionName: string
  modelId: string
  reason: string
  retryAt: string | null
  observedAt: string | null
  message: string | null
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
  /**
   * In-use route faults (design §7.2): a specific tier's model is currently refused by
   * the unified admission. Kept separate from connection-environment errors; recovering
   * one route never clears another route's fault.
   */
  routeFaults: RouteFaultItem[]
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

  const routeFaults: RouteFaultItem[] = []
  const routeFaultReasons = new Set([
    'model_rejected', 'model_mismatch', 'backoff', 'scope_unknown', 'invalid_model_id',
  ])
  let config: ReturnType<typeof getConfig> | null = null
  try { config = getConfig() } catch { config = null }
  if (config) {
    for (const connection of connections) {
      if (connection.provider_type !== 'claude-cli' && connection.provider_type !== 'codex-cli') continue
      const view = buildConnectionModelsView(db, connection, config)
      for (const route of view.inUse) {
        if (route.admission.allowed || !routeFaultReasons.has(route.admission.reason)) continue
        routeFaults.push({
          tier: route.tier,
          connectionId: connection.id,
          connectionName: connection.name,
          modelId: route.modelId,
          reason: route.admission.reason,
          retryAt: route.admission.retryAt ?? null,
          observedAt: route.observation?.updatedAt ?? null,
          message: route.observation?.errorMessage ?? null,
        })
      }
    }
  }

  errors.sort((a, b) => {
    if (a.needsUserAction !== b.needsUserAction) return a.needsUserAction ? -1 : 1
    return b.occurredAt - a.occurredAt
  })
  // 与统一调用准入同一口径：CLI 连接环境已验证（untested/online）即可承担首次
  // 业务调用；某个模型的故障记在 routeFaults，不把整条连接算作不可用。
  const availableCount = connections.filter(row => (
    row.provider_type === 'claude-cli' || row.provider_type === 'codex-cli'
      ? row.status === 'online' || row.status === 'untested'
      : row.status === 'online' || row.status === 'degraded'
  )).length
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
    needsAttentionCount: errors.length + routeFaults.length,
    errors,
    routeFaults,
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
