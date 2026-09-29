import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getClientDb } from '../db.js'
import { probeAnthropic, probeVertex, probeGemini, probeOllama, probeOpenAICompatible } from './health.js'
import { validateConnectionId, validateProviderType, validateFormCredentials, assertPathWithinRoot } from './_validate.js'
import { mainT } from '../i18n.js'
import { clearClientCache } from '../../../src/llm/client.js'
import { resetCircuitBreaker } from '../../../src/metabolism/scheduler.js'
import {
  LLM_PROVIDER_CATALOG,
} from '../../../src/llm/provider-types.js'
import {
  checkCliEnvironment,
  cliUserActionCommand,
  CliLLMError,
  runCliLLM,
  type CliEnvironmentCheck,
  type CliProviderType,
} from '../../../src/llm/cli/index.js'
import {
  updateCliConnectionEnvironment,
  type ModelConnectionStatus,
} from '../../../src/db/connections.js'
import { deleteModelDiscoveryRows, reconcileAuthBinding } from '../../../src/db/model-discovery.js'
import { refreshCliModelCatalog } from '../../../src/llm/cli/model-catalog.js'
import { FOLLOW_DEFAULT_MODEL, isValidManualModelId } from '../../../src/llm/cli/catalogs.js'
import { buildConnectionModelsView, routesUsingConnection } from '../../../src/llm/model-catalog-view.js'
import { getConfig } from '../../../src/config.js'
import { getCatalogSnapshot } from '../../../src/db/model-discovery.js'
import { CATALOG_FRESHNESS } from '../../../src/llm/cli/model-catalog.js'
import { createLogger } from '../../../src/utils/logger.js'

const catalogLog = createLogger('model-catalog')
let catalogFreshnessTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Background catalog freshness (design §6): only connections that an in-use route
 * references, roughly every 6 hours with jitter, metadata only. Runs only while the
 * app is running; never wakes an exited app and never tries models. Skips any
 * connection with a user check/test in progress and never changes its status.
 */
function scheduleCatalogFreshness(dataDir: string): void {
  if (catalogFreshnessTimer) return
  const tick = async () => {
    try {
      const db = getClientDb()
      const config = getConfig()
      const rows = db.prepare(`
        SELECT id, provider_type FROM model_connections
        WHERE archived = 0 AND provider_type IN ('claude-cli', 'codex-cli')
          AND status IN ('online', 'untested')
      `).all() as Array<{ id: string; provider_type: CliProviderType }>
      for (const row of rows) {
        if (cliOperations.has(row.id)) continue
        if (routesUsingConnection(config, row.id).length === 0) continue
        const snapshot = getCatalogSnapshot(db, row.id)
        const age = snapshot ? Date.now() - Date.parse(snapshot.fetchedAt) : Infinity
        if (Number.isFinite(age) && age >= 0 && age < CATALOG_FRESHNESS.backgroundEveryMs) continue
        const operation = beginCliOperation(row.id, 'environment')
        try {
          const environment = await checkCliEnvironment({
            providerType: row.provider_type,
            allowLoginShell: false,
            dataDir,
            signal: operation.controller.signal,
          })
          await refreshCliModelCatalog(db, {
            connectionId: row.id,
            dataDir,
            environment,
            signal: operation.controller.signal,
          })
        } catch (error) {
          catalogLog.warn(`background catalog refresh skipped for ${row.id}: ${(error as Error).message}`)
        } finally {
          finishCliOperation(row.id, operation)
        }
      }
    } catch (error) {
      catalogLog.warn(`background catalog freshness failed: ${(error as Error).message}`)
    } finally {
      const jitter = Math.floor(Math.random() * 20 * 60_000)
      catalogFreshnessTimer = setTimeout(() => { void tick() }, 60 * 60_000 + jitter)
      catalogFreshnessTimer.unref?.()
    }
  }
  catalogFreshnessTimer = setTimeout(() => { void tick() }, 5 * 60_000 + Math.floor(Math.random() * 10 * 60_000))
  catalogFreshnessTimer.unref?.()
}
import { broadcastLLMHealth } from './llm-health.js'
import { notifyMetabolismWorkerRuntimeMutation } from '../workers/metabolism-worker-runtime-mutations.js'

function generateConnectionId(): string {
  return 'mc_' + randomBytes(4).toString('hex')
}

function now(): string {
  return new Date().toISOString()
}

/**
 * HIGH 2 (audit-10, 2026-05-21): 8KB credentials JSON 上限抽常量。
 * 之前 create path 有 8192 cap 但 update path 漏检 → 攻击/buggy renderer 可
 * 先 create 1KB 再 update 到 100MB,SQLite 落盘膨胀 + 后续同步推送 OOM。
 * 抽常量保证 create / update 两路一致。
 */
const MAX_CREDENTIALS_BYTES = 8192

type ModelConnectionDbRow = Record<string, unknown> & {
  provider_type: string
  credentials: string | null
}

type CliOperation = {
  token: string
  kind: 'environment' | 'test'
  controller: AbortController
}
const cliOperations = new Map<string, CliOperation>()

/** Explicit test targets from the renderer: at most 10 bounded model ids. */
function parseTestTargets(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null
  const models = (raw as { models?: unknown }).models
  if (models === undefined) return null
  if (!Array.isArray(models) || models.length === 0 || models.length > 10) {
    throw new Error('测试目标无效')
  }
  const unique = [...new Set(models)]
  for (const model of unique) {
    if (typeof model !== 'string' || !isValidManualModelId(model)) throw new Error('测试目标无效')
  }
  return unique as string[]
}

function isCliProvider(value: string): value is CliProviderType {
  return value === 'claude-cli' || value === 'codex-cli'
}

function sourceTypeFor(providerType: string): string {
  return LLM_PROVIDER_CATALOG.find(provider => provider.id === providerType)?.sourceType
    ?? 'cloud_service'
}

function beginCliOperation(connectionId: string, kind: CliOperation['kind']): CliOperation {
  if (cliOperations.has(connectionId)) {
    throw new Error('该连接正在检查或测试，请等待当前操作完成')
  }
  const operation = {
    token: randomBytes(16).toString('hex'),
    kind,
    controller: new AbortController(),
  }
  cliOperations.set(connectionId, operation)
  return operation
}

function operationIsCurrent(connectionId: string, operation: CliOperation): boolean {
  return cliOperations.get(connectionId)?.token === operation.token
}

function finishCliOperation(connectionId: string, operation: CliOperation): void {
  if (operationIsCurrent(connectionId, operation)) cliOperations.delete(connectionId)
}

function cancelCliOperation(connectionId: string, reason: string): boolean {
  const operation = cliOperations.get(connectionId)
  if (!operation) return false
  operation.controller.abort(new Error(reason))
  // Keep the operation token until its handler reaches finally. Removing it
  // here makes the handler treat a user cancellation like archive/delete and
  // can leave the durable status stuck at "checking" or "testing".
  return true
}

function broadcastTestProgress(progress: {
  connectionId: string
  currentModel: string
  completed: number
  total: number
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('connections:test-progress', progress)
    } catch {
      // Window may disappear while a long test is running.
    }
  }
}

function cliStatusForError(error: CliLLMError): string {
  if (
    error.kind === 'not_installed'
    || error.kind === 'not_authenticated'
    || error.kind === 'wrong_auth_method'
    || error.kind === 'unsupported_version'
  ) return error.kind
  return 'offline'
}

/**
 * 安全解析 credentials 字段:DB 里写入的 JSON 字符串可能因升级/手动改库
 * 损坏。直接 `JSON.parse` 会抛错让 IPC handler 崩溃,前端拿到 unhandled
 * rejection 没有有用错误。这里返回空对象作降级,调用方按"未配凭证"路径处理。
 */
function safeParseCredentials(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function registerConnectionHandlers(dataDir: string): void {
  scheduleCatalogFreshness(dataDir)
  ipcMain.handle('connections:provider-catalog', () =>
    LLM_PROVIDER_CATALOG.map(provider => ({
      id: provider.id,
      labelKey: provider.labelKey,
      sourceType: provider.sourceType,
      billingMode: provider.billingMode,
      transport: provider.transport,
      supportsLlm: provider.supportsLLM,
      supportsEmbedding: provider.supportsEmbedding,
    })),
  )

  ipcMain.handle('connections:list', (_e, includeArchived?: boolean) => {
    const db = getClientDb()
    const rows = includeArchived
      ? db.prepare('SELECT * FROM model_connections ORDER BY archived ASC, created DESC').all() as ModelConnectionDbRow[]
      : db.prepare('SELECT * FROM model_connections WHERE archived = 0 ORDER BY created DESC').all() as ModelConnectionDbRow[]
    return rows.map(r => ({
      ...r,
      credentials: undefined,
      hasCredentials: isCliProvider(r.provider_type) ? false : !!r.credentials,
      source_type: sourceTypeFor(r.provider_type),
    }))
  })

  ipcMain.handle('connections:get', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const row = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(validId) as ModelConnectionDbRow | undefined
    if (!row) return null
    return {
      ...row,
      credentials: undefined,
      hasCredentials: isCliProvider(row.provider_type) ? false : !!row.credentials,
      source_type: sourceTypeFor(row.provider_type),
    }
  })

  // 按需取出明文 credentials —— 仅在详情面板需要把已存凭证回填表单时调用,
  // 不进 connections:list(避免列表刷新时把所有连接的密钥扇出到 renderer 内存)。
  // 安全模型:credentials 反正明文存在用户本地 SQLite,UI 上隐藏不是真隔离,
  // 让用户看到自己配过什么 > 强制蒙黑。
  ipcMain.handle('connections:get-credentials', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const row = db.prepare('SELECT credentials FROM model_connections WHERE id = ?').get(validId) as { credentials: string } | undefined
    if (!row) return {}
    return safeParseCredentials(row.credentials)
  })

  ipcMain.handle('connections:create', (_e, params: { name: string; provider_type: string; credentials?: Record<string, unknown> }) => {
    // renderer 输入需校验:provider_type 走白名单防止 DB 里被写入垃圾值,
    // name 限长避免 timeline_events.title 失控膨胀
    const providerType = validateProviderType(params.provider_type)
    const name = typeof params.name === 'string' ? params.name.slice(0, 200).trim() : ''
    if (!name) throw new Error('Invalid connection name')

    const db = getClientDb()
    const id = generateConnectionId()
    const created = now()
    const creds = JSON.stringify(
      isCliProvider(providerType) ? {} : params.credentials ?? {},
    )
    // F8 (audit-9): credentials JSON 上限 8KB,API key / project_id 类参数远不到这个量。
    // 没有上限的话恶意 / 出 bug 的 renderer 能把 100MB 字符串塞进 SQLite,后续 SELECT/
    // 同步推送都被拖累(也会让 cloud-server 的 reconcile size limit 失效)。
    if (creds.length > MAX_CREDENTIALS_BYTES) {
      throw new Error(`credentials too large (> ${MAX_CREDENTIALS_BYTES} bytes JSON)`)
    }
    db.prepare(
      'INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, providerType, creds, created)
    notifyMetabolismWorkerRuntimeMutation('connection')
    broadcastLLMHealth(db)

    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        `创建了模型连接: ${name}`,
        JSON.stringify({ section: 'model_connection', action: 'create', connection_name: name, connection_id: id }),
      )
    } catch { /* timeline logging is best-effort */ }

    return {
      id, name, provider_type: providerType,
      credentials: creds, status: 'unconfigured',
      available_models: null, last_checked: null,
      source_type: sourceTypeFor(providerType),
      archived: 0, created,
    }
  })

  ipcMain.handle('connections:update', (_e, id: unknown, params: { name?: string; credentials?: Record<string, unknown> }) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (params.name !== undefined) {
      const trimmed = typeof params.name === 'string' ? params.name.slice(0, 200).trim() : ''
      if (!trimmed) throw new Error('Invalid connection name')
      sets.push('name = ?'); values.push(trimmed)
    }
    if (params.credentials !== undefined) {
      const existing = db.prepare(
        'SELECT provider_type FROM model_connections WHERE id = ?',
      ).get(validId) as { provider_type: string } | undefined
      const creds = JSON.stringify(
        existing && isCliProvider(existing.provider_type) ? {} : params.credentials,
      )
      // HIGH 2 (audit-10): 跟 create 一致的 8KB cap;之前 update 漏检让 renderer
      // 能先 create 小 payload 再 update 到任意大小绕过 create 的限制。
      if (creds.length > MAX_CREDENTIALS_BYTES) {
        throw new Error(`credentials too large (> ${MAX_CREDENTIALS_BYTES} bytes JSON)`)
      }
      sets.push('credentials = ?')
      values.push(creds)
    }
    if (sets.length === 0) return
    values.push(validId)
    db.prepare(`UPDATE model_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    notifyMetabolismWorkerRuntimeMutation(params.credentials === undefined ? 'connection' : 'credential')
    // 2026-05-21: 凭据变更后主动清 LLM client cache + 重置熔断器。
    // 用户改 connection 等同于"我在主动修复 LLM 问题",不应该让旧的熔断状态继续挡。
    // 注意只在 credentials 变更时清,纯改 name 不动 LLM 调用路径。
    if (params.credentials !== undefined) {
      try {
        clearClientCache()
        resetCircuitBreaker(db)
      } catch {
        // 自愈逻辑失败不能让 connection update 整体失败
      }
    }
  })

  ipcMain.handle('connections:archive', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    cancelCliOperation(validId, '连接已归档')
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(validId)
    notifyMetabolismWorkerRuntimeMutation('connection')
    broadcastLLMHealth(db)
  })

  ipcMain.handle('connections:unarchive', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 0 WHERE id = ?').run(validId)
    notifyMetabolismWorkerRuntimeMutation('connection')
    broadcastLLMHealth(db)
  })

  ipcMain.handle('connections:delete', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    cancelCliOperation(validId, '连接已删除')
    const db = getClientDb()
    db.transaction(() => {
      db.prepare('DELETE FROM model_connections WHERE id = ?').run(validId)
      deleteModelDiscoveryRows(db, validId)
    })()
    notifyMetabolismWorkerRuntimeMutation('connection')
    broadcastLLMHealth(db)
  })

  const runEnvironmentCheck = async (connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    const db = getClientDb()
    const connection = db.prepare(`
      SELECT id, provider_type, status, status_reason, archived
      FROM model_connections WHERE id = ?
    `).get(validId) as {
      id: string
      provider_type: string
      status: ModelConnectionStatus
      status_reason: string | null
      archived: number
    } | undefined
    if (!connection || connection.archived) throw new Error('模型连接不存在或已归档')
    if (!isCliProvider(connection.provider_type)) {
      throw new Error('只有本地订阅连接需要检查 CLI 环境')
    }
    const operation = beginCliOperation(validId, 'environment')
    db.prepare(`
      UPDATE model_connections
      SET status = 'checking', status_reason = NULL
      WHERE id = ? AND archived = 0
    `).run(validId)
    try {
      const environment = await checkCliEnvironment({
        providerType: connection.provider_type,
        allowLoginShell: true,
        dataDir,
        signal: operation.controller.signal,
      })
      if (!operationIsCurrent(validId, operation) || operation.controller.signal.aborted) {
        throw new CliLLMError('aborted', '环境检查已取消')
      }
      // Environment status only; model evidence is per model and never cleared here.
      const preservedStatus = (
        connection.status === 'online'
        || connection.status === 'ambiguous'
      ) ? connection.status : 'untested'
      updateCliConnectionEnvironment(db, validId, {
        status: preservedStatus,
        statusReason: null,
        cliPath: environment.resolved.path,
        cliVersion: environment.resolved.version,
        authMethod: environment.auth.method,
        authFingerprint: environment.authFingerprint,
        cliGeneration: environment.cliGeneration,
        environmentCheckedAt: environment.checkedAt,
      })
      // Metadata-only catalog refresh bound to the same CLI and account scope.
      const refresh = await refreshCliModelCatalog(db, {
        connectionId: validId,
        dataDir,
        environment,
        signal: operation.controller.signal,
      })
      return {
        status: preservedStatus,
        cliPath: environment.resolved.path,
        cliVersion: environment.resolved.version,
        authMethod: environment.auth.method,
        capabilityStatus: environment.capabilityStatus,
        scopeState: environment.auth.scopeState,
        scopeLabel: environment.auth.scopeLabel,
        catalog: {
          status: refresh.status,
          source: refresh.snapshot?.source ?? null,
          count: refresh.snapshot?.items.length ?? 0,
          fetchedAt: refresh.snapshot?.fetchedAt ?? null,
          errorKind: refresh.errorKind ?? null,
        },
        checkedAt: environment.checkedAt,
      }
    } catch (error) {
      const cliError = error instanceof CliLLMError
        ? error
        : new CliLLMError('transient', (error as Error).message, { cause: error })
      if (operationIsCurrent(validId, operation)) {
        // An environment failure never clears an unresolved ambiguous invocation.
        const keepPrevious = cliError.kind === 'aborted' || connection.status === 'ambiguous'
        const status = keepPrevious
          ? connection.status
          : cliStatusForError(cliError)
        const reason = keepPrevious
          ? connection.status_reason
          : cliError.message.slice(0, 500)
        db.prepare(`
          UPDATE model_connections
          SET status = ?, status_reason = ?, last_checked = ?
          WHERE id = ? AND archived = 0
        `).run(status, reason, now(), validId)
      }
      return {
        status: cliError.kind === 'aborted' || connection.status === 'ambiguous'
          ? connection.status
          : cliStatusForError(cliError),
        error: {
          kind: cliError.kind,
          message: cliError.message,
          copyCommand: cliUserActionCommand(connection.provider_type, cliError.kind),
        },
      }
    } finally {
      broadcastLLMHealth(db)
      finishCliOperation(validId, operation)
    }
  }

  ipcMain.handle('connections:check-environment', (_e, connectionId: unknown) =>
    runEnvironmentCheck(connectionId))

  // “刷新模型列表”：与检查环境同一受控流程（重新确认 CLI 与账号后只读列目录）。
  ipcMain.handle('connections:refresh-models', (_e, connectionId: unknown) =>
    runEnvironmentCheck(connectionId))

  ipcMain.handle('connections:models', (_e, connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    const db = getClientDb()
    const connection = db.prepare(`
      SELECT id, provider_type, status FROM model_connections WHERE id = ?
    `).get(validId) as { id: string; provider_type: string; status: string | null } | undefined
    if (!connection) throw new Error('模型连接不存在')
    return buildConnectionModelsView(db, connection, getConfig())
  })

  ipcMain.handle('connections:cancel-test', (_e, connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    return { cancelled: cancelCliOperation(validId, '用户取消测试') }
  })

  // 统一测试连接入口
  ipcMain.handle('connections:test', async (_e, connectionId: unknown, formOverride?: unknown, testOptions?: unknown) => {
    const validId = validateConnectionId(connectionId)
    // 修复(2026-05-21):允许 renderer 把当前编辑中的 form 值作为 override 传进来。
    // 解决"新建 connection → 输入 base_url 但没保存就测试 → 报 Base URL not configured"
    // 的反直觉 UX。详见 _validate.ts::validateFormCredentials。
    const overrides = validateFormCredentials(formOverride)
    const db = getClientDb()
    const conn = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(validId) as {
      id: string
      provider_type: string
      credentials: string
      status: ModelConnectionStatus
      status_reason: string | null
      available_models: string | null
      validation_fingerprint: string | null
      model_validation_json: string | null
      last_tested_at: string | null
      last_test_summary: string | null
      archived: number
    } | undefined
    if (!conn) return { online: false, models: [], error: mainT('conn.notFound') }

    if (isCliProvider(conn.provider_type)) {
      if (conn.archived) {
        return { online: false, models: [], error: '模型连接已归档' }
      }
      // 测试目标必须明确（design §6/§7.2）：不再遍历候选全测。未指定时，只有一个在用
      // 模型则测它；没有在用路由测 CLI 默认；多个在用模型要求 UI 让用户选择目标。
      const requested = parseTestTargets(testOptions)
      let targets: string[]
      if (requested) {
        targets = requested
      } else {
        const inUse = [...new Set(routesUsingConnection(getConfig(), validId).map(route => route.modelId))]
        if (inUse.length > 1) {
          return {
            online: false,
            models: [],
            error: '该连接被多个模型路由使用，请选择要测试的模型',
            errorKind: 'test_target_required',
            inUseModels: inUse,
          }
        }
        targets = inUse.length === 1 ? inUse : [FOLLOW_DEFAULT_MODEL]
      }
      const operation = beginCliOperation(validId, 'test')
      db.prepare(`
        UPDATE model_connections
        SET status = 'testing', status_reason = NULL
        WHERE id = ? AND archived = 0
      `).run(validId)
      const startedAt = Date.now()
      let environment: CliEnvironmentCheck | null = null
      const previous = { status: conn.status, statusReason: conn.status_reason }
      const results: Array<{
        model: string
        success: boolean
        actualModel?: string | null
        mismatch?: boolean
        error?: string
        errorKind?: string
      }> = []
      const restorePrevious = () => {
        db.prepare(`
          UPDATE model_connections
          SET status = ?, status_reason = ?, last_checked = ?
          WHERE id = ? AND archived = 0 AND status = 'testing'
        `).run(previous.status, previous.statusReason, now(), validId)
      }
      try {
        environment = await checkCliEnvironment({
          providerType: conn.provider_type,
          allowLoginShell: true,
          dataDir,
          signal: operation.controller.signal,
        })
        if (!operationIsCurrent(validId, operation)) {
          throw new CliLLMError('aborted', '测试已取消')
        }
        updateCliConnectionEnvironment(db, validId, {
          status: 'testing',
          statusReason: null,
          cliPath: environment.resolved.path,
          cliVersion: environment.resolved.version,
          authMethod: environment.auth.method,
          authFingerprint: environment.authFingerprint,
          cliGeneration: environment.cliGeneration,
          environmentCheckedAt: environment.checkedAt,
        })
        for (const model of targets) {
          if (!operationIsCurrent(validId, operation) || operation.controller.signal.aborted) break
          broadcastTestProgress({
            connectionId: validId,
            currentModel: model,
            completed: results.length,
            total: targets.length,
          })
          try {
            // runCliLLM records the per-model observation under the current scope/epoch.
            const result = await runCliLLM(
              db,
              dataDir,
              {
                connectionId: validId,
                providerType: conn.provider_type,
                modelAlias: model,
                system: 'This is a connection test. Do not use tools or access files.',
                prompt: 'Reply with exactly: TIDEMIND_CONNECTION_OK',
                maxOutputTokens: 32,
                timeoutMs: 120_000,
                operationName: 'connection-test',
                signal: operation.controller.signal,
                purpose: 'connection_test',
              },
              {
                purpose: 'connection_test',
                environment,
              },
            )
            if (result.text.trim() !== 'TIDEMIND_CONNECTION_OK') {
              throw new CliLLMError(
                'protocol',
                '模型未返回连接测试标记，不能判定为可用',
              )
            }
            const view = buildConnectionModelsView(db, { id: validId, provider_type: conn.provider_type, status: 'testing' }, getConfig())
            const observed = view.observations.find(item => item.modelId === model)
            results.push({
              model,
              success: observed?.lastOutcome !== 'mismatch',
              actualModel: result.actualModel,
              mismatch: observed?.lastOutcome === 'mismatch',
            })
          } catch (error) {
            const cliError = error instanceof CliLLMError
              ? error
              : new CliLLMError('transient', (error as Error).message, { cause: error })
            if (cliError.kind === 'aborted') break
            results.push({
              model,
              success: false,
              error: cliError.message.slice(0, 500),
              errorKind: cliError.kind,
            })
          }
          broadcastTestProgress({
            connectionId: validId,
            currentModel: model,
            completed: results.length,
            total: targets.length,
          })
        }

        const cancelled = !operationIsCurrent(validId, operation)
          || operation.controller.signal.aborted
        let attributionUnconfirmed = false
        if (!cancelled) {
          // Re-read the environment: if the CLI generation or account scope changed
          // during the test, the binding moves to a new epoch and the recorded
          // observations stay in history (attribution unconfirmed).
          const finalEnvironment = await checkCliEnvironment({
            providerType: conn.provider_type,
            allowLoginShell: true,
            dataDir,
            signal: operation.controller.signal,
          })
          const reconciled = reconcileAuthBinding(db, {
            connectionId: validId,
            auth: finalEnvironment.auth,
            cliGeneration: finalEnvironment.cliGeneration,
            authStoreSignal: finalEnvironment.authStoreSignal,
          })
          attributionUnconfirmed = reconciled.epochChanged
        }
        const current = db.prepare(
          'SELECT archived FROM model_connections WHERE id = ?',
        ).get(validId) as { archived: number } | undefined
        if (!current || current.archived) {
          return {
            online: false,
            models: [],
            successCount: 0,
            totalCount: targets.length,
            cancelled: true,
            results,
          }
        }
        if (cancelled) {
          restorePrevious()
          return {
            online: false,
            models: [],
            successCount: results.filter(item => item.success).length,
            totalCount: targets.length,
            cancelled: true,
            results,
          }
        }

        const successfulModels = attributionUnconfirmed
          ? []
          : results.filter(item => item.success).map(item => item.model)
        const connectionFailure = results.find(item => (
          item.errorKind === 'not_authenticated'
          || item.errorKind === 'wrong_auth_method'
          || item.errorKind === 'unsupported_version'
          || item.errorKind === 'not_installed'
        ))
        // A new test proves this model works now; it cannot establish whether an
        // earlier committed request ran or authorize replay of its queued digest.
        const hasUnresolvedInvocation = Boolean(db.prepare(`
          SELECT 1 FROM cli_invocations
          WHERE connection_id = ? AND outcome = 'ambiguous' AND resolution IS NULL
          LIMIT 1
        `).get(validId))
        const status: string = hasUnresolvedInvocation
          ? 'ambiguous'
          : successfulModels.length > 0
            ? 'online'
          : previous.status === 'ambiguous'
            ? 'ambiguous'
          : attributionUnconfirmed
            ? 'untested'
            : connectionFailure
              ? cliStatusForError(new CliLLMError(connectionFailure.errorKind as never, ''))
              : previous.status === 'online'
                ? 'online'
                : 'untested'
        const summary = {
          operationId: operation.token,
          success: successfulModels.length,
          total: targets.length,
          targets,
          scopeState: environment.auth.scopeState,
          attributionUnconfirmed,
          durationMs: Date.now() - startedAt,
          cancelled: false,
        }
        db.transaction(() => {
          db.prepare(`
            UPDATE model_connections
            SET status = ?,
                status_reason = ?,
                last_tested_at = ?,
                last_test_summary = ?,
                last_checked = ?
            WHERE id = ? AND archived = 0
          `).run(
            status,
            attributionUnconfirmed
              ? 'CLI 或登录账号在测试期间发生变化，本次结果归属未确认'
              : connectionFailure?.error ?? (status === 'ambiguous' ? previous.statusReason : null),
            now(),
            JSON.stringify(summary),
            now(),
            validId,
          )
        })()
        return {
          online: successfulModels.length > 0,
          models: successfulModels,
          successCount: successfulModels.length,
          totalCount: targets.length,
          cancelled: false,
          scopeState: environment.auth.scopeState,
          attributionUnconfirmed,
          results,
        }
      } catch (error) {
        const cliError = error instanceof CliLLMError
          ? error
          : new CliLLMError('transient', (error as Error).message, { cause: error })
        if (operationIsCurrent(validId, operation)) {
          if (cliError.kind === 'aborted' || previous.status === 'ambiguous') {
            restorePrevious()
          } else {
            db.prepare(`
              UPDATE model_connections
              SET status = ?, status_reason = ?, last_checked = ?
              WHERE id = ? AND archived = 0
            `).run(
              cliStatusForError(cliError),
              cliError.message.slice(0, 500),
              now(),
              validId,
            )
          }
        }
        return {
          online: false,
          models: results.filter(item => item.success).map(item => item.model),
          error: cliError.message,
          errorKind: cliError.kind,
          successCount: results.filter(item => item.success).length,
          totalCount: targets.length,
          cancelled: cliError.kind === 'aborted',
          results,
        }
      } finally {
        broadcastLLMHealth(db)
        finishCliOperation(validId, operation)
      }
    }

    // credentials 解析失败时降级为空对象,避免 IPC 崩溃
    const dbCreds = safeParseCredentials(conn.credentials)
    // Merge: form 非空字段优先,DB 已存字段作为 fallback。
    // 关键:probe 后只更 status / available_models,不写 credentials,所以
    // "编辑老 connection 时 SecretInput 安全不回填 → form 是空 → merge 优先用 DB"
    // 这条路径仍然保护已存的 API Key 不被空表单覆盖。
    const creds: Record<string, unknown> = { ...dbCreds }
    let hasOverride = false
    for (const [k, v] of Object.entries(overrides)) {
      if (v.length > 0) {
        creds[k] = v
        hasOverride = true
      }
    }
    let result: { online: boolean; models: string[]; error?: string; region?: string }

    switch (conn.provider_type) {
      case 'anthropic':
        result = await probeAnthropic(typeof creds.api_key === 'string' ? creds.api_key : '')
        break
      case 'vertex': {
        const credPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
        // 也检查旧的全局凭证文件作为回退
        const fallbackCredPath = path.join(dataDir, 'vertex-credentials.json')
        const actualCredPath = fs.existsSync(credPath) ? credPath : fallbackCredPath
        result = await probeVertex(
          typeof creds.project_id === 'string' ? creds.project_id : '',
          typeof creds.region === 'string' ? creds.region : 'us-central1',
          actualCredPath,
        )
        break
      }
      case 'gemini':
        result = await probeGemini(typeof creds.api_key === 'string' ? creds.api_key : '')
        break
      case 'ollama': {
        // F11 (audit-9): URL scheme 校验,挡 file:// / ftp:// / gopher:// 等绕路。
        // Ollama 是用户的本地服务,默认 localhost,这里允许任意 http(s) 地址
        // (LAN 部署 / 公司内网都是真实场景),只拒非 http(s) 协议。
        const rawUrl = typeof creds.url === 'string' ? creds.url : 'http://localhost:11434'
        try {
          const parsed = new URL(rawUrl)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            result = { online: false, models: [], error: mainT('conn.ollamaSchemeInvalid') }
            break
          }
        } catch (e) {
          result = { online: false, models: [], error: `${mainT('conn.ollamaUrlInvalid')}: ${(e as Error).message}` }
          break
        }
        result = await probeOllama(rawUrl)
        break
      }
      case 'openai-compatible': {
        // F11 (audit-9): OpenAI 兼容端点应是公网或受信内网,挡 file:// 等非 http(s)。
        // 私网 IP 不强制拒(用户可能自建 OpenAI 兼容服务),但留 TODO。
        const baseUrl = typeof creds.base_url === 'string' ? creds.base_url : ''
        if (baseUrl) {
          try {
            const parsed = new URL(baseUrl)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              result = { online: false, models: [], error: mainT('conn.baseUrlSchemeInvalid') }
              break
            }
          } catch (e) {
            result = { online: false, models: [], error: `${mainT('conn.baseUrlInvalid')}: ${(e as Error).message}` }
            break
          }
        }
        result = await probeOpenAICompatible(
          baseUrl,
          typeof creds.api_key === 'string' ? creds.api_key : undefined,
        )
        break
      }
      default:
        result = { online: false, models: [], error: `${mainT('conn.unknownProvider')}: ${conn.provider_type}` }
    }

    // 更新状态到数据库
    // Audit-3 F11 修复:仅在成功(online + 有 models)时才回写 available_models。
    // 之前测试失败会把 available_models 设回 null,丢掉用户上次成功时拿到的型号列表 —
    // UI 上"模型下拉"瞬间变空,但其实凭证可能只是瞬时不可用。保留上次的 list 让 UI 仍可用。
    //
    // Audit A.M2 (2026-05-21):有 form override 时**不写 DB status / available_models**,
    // 只把 probe 结果 return 给 UI 当前次显示。原因:formOverride 用的是表单未保存
    // 的值,跟 DB credentials 不一致;此时 probe 成功不代表"DB 里这条 connection
    // 可用"。如果写 DB,用户看到绿点 + 模型 chip 以为已配好,选了它一调 LLM 就报
    // "credentials missing" — 误导。必须先点"保存"让 credentials 入 DB,然后再次
    // 点"测试"用 DB credentials probe(此时 hasOverride=false),才能让 status 入 DB。
    if (!hasOverride) {
      const status = result.online ? 'online' : 'offline'
      const cols = ['status = ?', 'status_reason = ?', 'last_checked = ?']
      const params: unknown[] = [
        status,
        result.online ? null : (result.error ?? 'Unknown connection error').slice(0, 500),
        now(),
      ]
      if (result.online && result.models.length > 0) {
        cols.push('available_models = ?')
        params.push(JSON.stringify(result.models))
      }
      db.prepare(
        `UPDATE model_connections SET ${cols.join(', ')} WHERE id = ?`,
      ).run(...params, validId)
      broadcastLLMHealth(db)
    }

    return result
  })

  // Vertex 凭证文件上传（按 connection_id 存储）
  ipcMain.handle('connections:pick-vertex-file', async (_e, connectionId: unknown) => {
    // 历史漏洞:connectionId 来自 renderer 完全未校验,直接拼到
    // `vertex-credentials-${connectionId}.json` → 攻击者可传
    // `../../../../etc/foo` 把任意位置覆盖成 SA JSON。同时 fs.copyFileSync 的
    // 默认权限是 0644,SA 私钥落盘默认可读,保留窗口期(改为
    // writeFileSync({mode: 0o600}) 一次性创建权限受限文件)。
    const validId = validateConnectionId(connectionId)
    try {
      const result = await dialog.showOpenDialog({
        title: mainT('dialog.pickServiceAccount'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const sourcePath = result.filePaths[0]
      const content = fs.readFileSync(sourcePath, 'utf-8')

      let parsed: Record<string, unknown>
      try {
        const value: unknown = JSON.parse(content)
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { success: false, error: mainT('cred.notJson') }
        }
        parsed = value as Record<string, unknown>
      } catch {
        return { success: false, error: mainT('cred.notJson') }
      }

      if (parsed.type !== 'service_account') {
        return { success: false, error: mainT('cred.notServiceAccount') }
      }

      // 复制到数据目录(按 validId 命名)。validId 已正则白名单卡住,
      // assertPathWithinRoot 是纵深兜底——确认拼接结果落在 dataDir 内。
      const destPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
      assertPathWithinRoot(destPath, dataDir)
      // 用 mode: 0o600 一次性创建受限权限文件,避免 copyFileSync + chmodSync
      // 之间默认 0644 可读窗口。content 已读到内存,直接写。
      // 加固:writeFileSync 的 mode 仅在创建新文件时应用,先 unlink 确保
      // 已存在的旧 0644 文件升级后真变成 0600。
      try { fs.unlinkSync(destPath) } catch { /* 不存在或无权限 */ }
      fs.writeFileSync(destPath, content, { mode: 0o600 })

      // 同时更新 connection 的 credentials（project_id）
      const db = getClientDb()
      const conn = db.prepare('SELECT credentials FROM model_connections WHERE id = ?').get(validId) as { credentials: string } | undefined
      if (conn) {
        const creds = safeParseCredentials(conn.credentials)
        if (typeof parsed.project_id === 'string') creds.project_id = parsed.project_id
        db.prepare('UPDATE model_connections SET credentials = ? WHERE id = ?').run(JSON.stringify(creds), validId)
        notifyMetabolismWorkerRuntimeMutation('credential')
        // 2026-05-21 (audit A.H2 / C.H3): 上传新 SA 文件后,即使 project_id 不变,
        // 文件内容已经换了(私钥/客户端 email 不同),GoogleAuth 内部 cachedCredential
        // 还会沿用旧 JWT。必须 clearClientCache() 让 SDK 重建,resetCircuitBreaker
        // 让上次因旧凭证失败积累的熔断状态清掉(用户上传新 SA 通常就是为了修这个)。
        try {
          clearClientCache()
          resetCircuitBreaker(db)
        } catch {
          // 自愈失败不能阻挡 SA 上传整体成功
        }
      }

      try {
        db.prepare(`
          INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
          VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
        `).run(
          '上传了 Vertex AI 凭证',
          JSON.stringify({ section: 'model_connection', action: 'upload_vertex_cred', connection_id: validId }),
        )
      } catch {
        // Timeline telemetry must not make a successful credential upload fail.
      }

      return {
        success: true,
        projectId: parsed.project_id ?? '',
      }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // Vertex 凭证状态检查
  ipcMain.handle('connections:vertex-cred-status', (_e, connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    // 优先检查按 connectionId 命名的凭证文件
    const credPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
    const fallbackPath = path.join(dataDir, 'vertex-credentials.json')
    const actualPath = fs.existsSync(credPath) ? credPath : fallbackPath

    if (!fs.existsSync(actualPath)) {
      return { configured: false }
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(actualPath, 'utf-8'))
      return { configured: true, projectId: parsed.project_id ?? '' }
    } catch {
      return { configured: false }
    }
  })
}
