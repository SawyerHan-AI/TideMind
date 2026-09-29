import type Database from 'better-sqlite3';
import {
  getAuthBinding,
  getCatalogSnapshot,
  getModelObservation,
  listModelObservations,
  type AuthBinding,
  type CatalogSnapshot,
  type ModelObservation,
} from '../db/model-discovery.js';
import { CATALOG_FRESHNESS } from './cli/model-catalog.js';
import { selectionModeFor, type ModelSelectionMode } from './cli/catalogs.js';
import { evaluateModelAdmission, type AdmissionDecision } from './model-admission.js';
import type { LLMTier } from './route.js';

/**
 * Read model for "模型对接 / 模型选择": catalog, auth binding, observations and the
 * routes currently using the connection. All values are facts with their own times;
 * nothing here authorizes a call (the admission field is the same function the
 * background uses, shown for consistency).
 */

export interface InUseRoute {
  tier: LLMTier;
  modelId: string;
  selectionMode: ModelSelectionMode;
  admission: AdmissionDecision;
  observation: ModelObservation | null;
}

export interface ConnectionModelsView {
  connectionId: string;
  providerType: string;
  binding: Pick<AuthBinding, 'scopeState' | 'authEpoch' | 'observedAt' | 'epochStartedAt' | 'epochReason'> | null;
  catalog: CatalogSnapshot | null;
  catalogAgeMs: number | null;
  catalogStale: boolean;
  catalogOutdated: boolean;
  /** Observations under the current scope/epoch. */
  observations: ModelObservation[];
  /** Earlier epochs / scopes, newest first (history only). */
  history: ModelObservation[];
  inUse: InUseRoute[];
}

export interface RouteConfigLike {
  llm: {
    light_connection?: string;
    standard_connection?: string;
    heavy_connection?: string;
    light_model: string;
    standard_model: string;
    heavy_model: string;
  };
}

export function routesUsingConnection(
  config: RouteConfigLike,
  connectionId: string,
): Array<{ tier: LLMTier; modelId: string }> {
  const tiers: Array<[LLMTier, string | undefined, string]> = [
    ['light', config.llm.light_connection, config.llm.light_model],
    ['standard', config.llm.standard_connection, config.llm.standard_model],
    ['heavy', config.llm.heavy_connection, config.llm.heavy_model],
  ];
  return tiers
    .filter(([, connection]) => connection === connectionId)
    .map(([tier, , modelId]) => ({ tier, modelId }));
}

export function buildConnectionModelsView(
  db: Database.Database,
  connection: { id: string; provider_type: string; status: string | null },
  config: RouteConfigLike,
  now = Date.now(),
): ConnectionModelsView {
  const binding = getAuthBinding(db, connection.id);
  const catalog = getCatalogSnapshot(db, connection.id);
  const all = listModelObservations(db, connection.id);
  const current = binding
    ? all.filter((o) => o.scopeKey === binding.scopeKey && o.authEpoch === binding.authEpoch)
    : [];
  const history = all.filter((o) => !current.includes(o));
  const fetched = catalog ? Date.parse(catalog.fetchedAt) : NaN;
  const age = Number.isFinite(fetched) ? now - fetched : null;
  const inUse = routesUsingConnection(config, connection.id).map(({ tier, modelId }) => {
    const observation = binding
      ? getModelObservation(db, connection.id, binding.scopeKey, binding.authEpoch, modelId)
      : null;
    return {
      tier,
      modelId,
      selectionMode: selectionModeFor(connection.provider_type, modelId),
      observation,
      admission: evaluateModelAdmission({
        purpose: 'background',
        providerType: connection.provider_type,
        connectionStatus: connection.status ?? 'unconfigured',
        scopeState: binding?.scopeState ?? null,
        modelId,
        observation,
        now,
      }),
    };
  });
  return {
    connectionId: connection.id,
    providerType: connection.provider_type,
    binding: binding
      ? {
          scopeState: binding.scopeState,
          authEpoch: binding.authEpoch,
          observedAt: binding.observedAt,
          epochStartedAt: binding.epochStartedAt,
          epochReason: binding.epochReason,
        }
      : null,
    catalog,
    catalogAgeMs: age !== null && age >= 0 ? age : null,
    catalogStale: age === null || age < 0 || age > CATALOG_FRESHNESS.staleAfterMs,
    catalogOutdated: age !== null && age > CATALOG_FRESHNESS.warnAfterMs,
    observations: current,
    history: history.slice(0, 100),
    inUse,
  };
}
