import type Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { getMetabolismWorkerConnectionSnapshot, getMetabolismWorkerRuntimeContext } from '../metabolism/worker-runtime-context.js';
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
  candidateModels: string[];
  availableModels: string[];
  validationFingerprint: string | null;
  authFingerprint: string | null;
}

type ConnectionRow = {
  id: string;
  name: string;
  provider_type: string;
  status: string | null;
  status_reason: string | null;
  archived: number;
  candidate_models: string | null;
  available_models: string | null;
  validation_fingerprint: string | null;
  auth_fingerprint: string | null;
};

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

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
      candidateModels: [],
      availableModels: [],
      validationFingerprint: null,
      authFingerprint: null,
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
    SELECT id, name, provider_type, status, status_reason, archived,
           candidate_models, available_models, validation_fingerprint,
           auth_fingerprint
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
    candidate_models: workerConnection!.candidateModels,
    available_models: workerConnection!.availableModels,
    validation_fingerprint: workerConnection!.validationFingerprint,
    auth_fingerprint: workerConnection!.authFingerprint,
  };
  const archived = workerConnection ? workerConnection.archived : effectiveRow.archived !== 0;
  const providerType = workerConnection?.providerType ?? effectiveRow.provider_type;
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
  return {
    tier,
    connectionId: effectiveRow.id,
    connectionName: effectiveRow.name,
    scopeId: effectiveRow.id,
    providerType,
    sourceType: definition.sourceType,
    billingMode: definition.billingMode,
    modelAlias: selected.modelAlias,
    status: (effectiveRow.status ?? 'unconfigured') as ModelConnectionStatus,
    statusReason: effectiveRow.status_reason,
    candidateModels: parseStringArray(effectiveRow.candidate_models),
    availableModels: parseStringArray(effectiveRow.available_models),
    validationFingerprint: effectiveRow.validation_fingerprint,
    authFingerprint: effectiveRow.auth_fingerprint,
  };
}

export function assertRouteCallable(route: ResolvedLLMRoute): void {
  if (route.status === 'legacy') return;

  const isCli = route.providerType === 'claude-cli' || route.providerType === 'codex-cli';
  if (!isCli) {
    if (route.status === 'offline') {
      throw new LLMRouteError(
        'connection_unavailable',
        route.statusReason ?? `模型连接 ${route.connectionName ?? route.connectionId} 不可用`,
        route.connectionId,
      );
    }
    return;
  }

  if (route.status === 'checking' || route.status === 'testing') {
    throw new LLMRouteError(
      'connection_busy',
      `模型连接 ${route.connectionName ?? route.connectionId} 正在检查或测试`,
      route.connectionId,
    );
  }
  if (route.status === 'ambiguous') {
    throw new LLMRouteError(
      'ambiguous_outcome',
      route.statusReason ?? '上次调用结果不明，完成检查环境和测试连接后才能恢复',
      route.connectionId,
    );
  }
  if (
    route.status === 'not_installed'
    || route.status === 'not_authenticated'
    || route.status === 'wrong_auth_method'
    || route.status === 'unsupported_version'
    || route.status === 'offline'
    || route.status === 'unconfigured'
  ) {
    throw new LLMRouteError(
      'connection_unavailable',
      route.statusReason ?? `模型连接 ${route.connectionName ?? route.connectionId} 不可用`,
      route.connectionId,
    );
  }

  // 候选目录只定义“测试哪些模型”，不能作为后台可调用授权。只有完整连接
  // 测试中真实成功并写入 available_models 的 alias 才允许被任务路由使用。
  if (!route.availableModels.includes(route.modelAlias)) {
    throw new LLMRouteError(
      'model_unavailable',
      `模型 ${route.modelAlias} 在连接 ${route.connectionName ?? route.connectionId} 中不可用`,
      route.connectionId,
    );
  }
}
