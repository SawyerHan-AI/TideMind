import type Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { getMetabolismWorkerConnectionSnapshot, getMetabolismWorkerRuntimeContext } from '../metabolism/worker-runtime-context.js';
import { getAuthBinding, getModelObservation } from '../db/model-discovery.js';
import { evaluateModelAdmission, isCliProvider, type AdmissionDecision } from './model-admission.js';
import {
  getLLMProviderDefinition,
  isLLMProviderType,
  type LLMProviderType,
  type ProviderBillingMode,
  type ProviderSourceType,
} from './provider-types.js';

export type LLMTier = 'light' | 'standard' | 'heavy';

export type ModelConnectionStatus =
  | 'unconfigured'
  | 'checking'
  | 'not_installed'
  | 'not_authenticated'
  | 'wrong_auth_method'
  | 'unsupported_version'
  | 'untested'
  | 'testing'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'ambiguous';

export type RouteErrorKind =
  | 'connection_missing'
  | 'connection_archived'
  | 'provider_mismatch'
  | 'connection_busy'
  | 'connection_unavailable'
  | 'model_unavailable'
  | 'model_mismatch'
  | 'model_backoff'
  | 'scope_unknown'
  | 'ambiguous_outcome';

export class LLMRouteError extends Error {
  constructor(
    public readonly kind: RouteErrorKind,
    message: string,
    public readonly connectionId: string | null,
  ) {
    super(message);
    this.name = 'LLMRouteError';
  }
}

export interface ResolvedLLMRoute {
  tier: LLMTier;
  connectionId: string | null;
  connectionName: string | null;
  scopeId: string;
  providerType: LLMProviderType;
  sourceType: ProviderSourceType;
  billingMode: ProviderBillingMode;
  modelAlias: string;
  status: ModelConnectionStatus | 'legacy';
  statusReason: string | null;
  /**
   * Unified admission for a background call (design §5.4). null for legacy routes.
   * Computed from the live auth binding and the model's observation under the current
   * scope/epoch; the CLI service re-evaluates it under the capacity lease.
   */
  admission: AdmissionDecision | null;
}

type ConnectionRow = {
  id: string;
  name: string;
  provider_type: string;
  status: string | null;
  status_reason: string | null;
  archived: number;
};

function tierConfig(tier: LLMTier): {
  connectionId: string | undefined;
  providerType: LLMProviderType;
  explicitProviderType: LLMProviderType | undefined;
  modelAlias: string;
} {
  const config = getConfig();
  const connectionId = tier === 'heavy'
    ? config.llm.heavy_connection
    : tier === 'light'
      ? config.llm.light_connection
      : config.llm.standard_connection;
  const explicitProviderType = tier === 'heavy'
    ? config.llm.heavy_provider
    : tier === 'light'
      ? config.llm.light_provider
      : config.llm.standard_provider;
  const modelAlias = tier === 'heavy'
    ? config.llm.heavy_model
    : tier === 'light'
      ? config.llm.light_model
      : config.llm.standard_model;
  return {
    connectionId,
    providerType: explicitProviderType ?? config.llm.provider,
    explicitProviderType,
    modelAlias,
  };
}

/**
 * Resolve a route without silently falling back from an explicit connection.
 *
 * An explicit connection is a durable user choice. Missing, archived or
 * provider-mismatched rows must remain visible failures instead of unexpectedly
 * spending against a legacy API provider.
 */
export function resolveLLMRoute(
  tier: LLMTier,
  db: Database.Database | null,
): ResolvedLLMRoute {
  const selected = tierConfig(tier);

  if (!selected.connectionId) {
    const definition = getLLMProviderDefinition(selected.providerType);
    return {
      tier,
      connectionId: null,
      connectionName: null,
      scopeId: `legacy:${selected.providerType}`,
      providerType: selected.providerType,
      sourceType: definition.sourceType,
      billingMode: definition.billingMode,
      modelAlias: selected.modelAlias,
      status: 'legacy',
      statusReason: null,
      admission: null,
    };
  }

  if (!db) {
    throw new LLMRouteError(
      'connection_missing',
      '模型连接数据库尚未初始化',
      selected.connectionId,
    );
  }

  const row = db.prepare(`
    SELECT id, name, provider_type, status, status_reason, archived
    FROM model_connections
    WHERE id = ?
  `).get(selected.connectionId) as ConnectionRow | undefined;
  const workerContext = getMetabolismWorkerRuntimeContext();
  const workerConnection = workerContext
    ? getMetabolismWorkerConnectionSnapshot(selected.connectionId)
    : null;

  if ((!row && !workerConnection) || (workerContext && !workerConnection)) {
    throw new LLMRouteError(
      'connection_missing',
      `模型连接 ${selected.connectionId} 不存在`,
      selected.connectionId,
    );
  }
  const effectiveRow: ConnectionRow = row ?? {
    id: workerConnection!.id,
    name: workerConnection!.name,
    provider_type: workerConnection!.providerType,
    status: workerConnection!.status,
    status_reason: workerConnection!.statusReason,
    archived: workerConnection!.archived ? 1 : 0,
  };
  const archived = row ? row.archived !== 0 : workerConnection!.archived;
  const providerType = row?.provider_type ?? workerConnection!.providerType;
  if (archived) {
    throw new LLMRouteError(
      'connection_archived',
      `模型连接 ${effectiveRow.name} 已归档`,
      effectiveRow.id,
    );
  }
  if (!isLLMProviderType(providerType)) {
    throw new LLMRouteError(
      'provider_mismatch',
      `模型连接 ${effectiveRow.name} 的 provider 无效`,
      effectiveRow.id,
    );
  }
  if (
    selected.explicitProviderType !== undefined
    && selected.explicitProviderType !== providerType
  ) {
    throw new LLMRouteError(
      'provider_mismatch',
      `模型连接 ${effectiveRow.name} 与已保存 provider 不一致`,
      effectiveRow.id,
    );
  }

  const definition = getLLMProviderDefinition(providerType);
  const status = (effectiveRow.status ?? 'unconfigured') as ModelConnectionStatus;
  const binding = isCliProvider(providerType) ? getAuthBinding(db, effectiveRow.id) : null;
  const admission = evaluateModelAdmission({
    purpose: 'background',
    providerType,
    connectionStatus: status,
    scopeState: binding?.scopeState ?? null,
    modelId: selected.modelAlias,
    observation: binding
      ? getModelObservation(db, effectiveRow.id, binding.scopeKey, binding.authEpoch, selected.modelAlias)
      : null,
  });
  return {
    tier,
    connectionId: effectiveRow.id,
    connectionName: effectiveRow.name,
    scopeId: effectiveRow.id,
    providerType,
    sourceType: definition.sourceType,
    billingMode: definition.billingMode,
    modelAlias: selected.modelAlias,
    status,
    statusReason: effectiveRow.status_reason,
    admission,
  };
}

export function assertRouteCallable(route: ResolvedLLMRoute): void {
  if (route.status === 'legacy' || !route.admission || route.admission.allowed) return;
  const name = route.connectionName ?? route.connectionId;
  const reason = route.admission.reason;
  switch (reason) {
    case 'connection_busy':
      throw new LLMRouteError('connection_busy', `模型连接 ${name} 正在检查或测试`, route.connectionId);
    case 'ambiguous_outcome':
      throw new LLMRouteError(
        'ambiguous_outcome',
        route.statusReason ?? '上次调用结果不明，完成检查环境和测试连接后才能恢复',
        route.connectionId,
      );
    case 'connection_unavailable':
      throw new LLMRouteError(
        'connection_unavailable',
        route.statusReason ?? `模型连接 ${name} 不可用`,
        route.connectionId,
      );
    case 'scope_unknown':
      throw new LLMRouteError(
        'scope_unknown',
        `无法确认模型连接 ${name} 当前登录的账号范围，后台调用已暂停`,
        route.connectionId,
      );
    case 'model_mismatch':
      throw new LLMRouteError(
        'model_mismatch',
        `固定模型 ${route.modelAlias} 上次返回了非预期的实际模型，请在设置中复测`,
        route.connectionId,
      );
    case 'backoff':
      throw new LLMRouteError(
        'model_backoff',
        `模型 ${route.modelAlias} 最近暂时失败，冷却至 ${route.admission.retryAt ?? ''}`,
        route.connectionId,
      );
    case 'model_rejected':
    case 'invalid_model_id':
    default:
      throw new LLMRouteError(
        'model_unavailable',
        `模型 ${route.modelAlias} 在连接 ${name} 中不可用`,
        route.connectionId,
      );
  }
}
