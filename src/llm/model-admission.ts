import { isValidManualModelId, selectionModeFor, type ModelSelectionMode } from './cli/catalogs.js';
import type { ModelObservation } from '../db/model-discovery.js';

/**
 * Unified model-call admission (design §5.4, B2).
 *
 * One pure function decides whether a (connection, model) pair may be invoked for a
 * given purpose. Settings UI, route resolution, the CLI service (again under the
 * capacity lease) and the metabolism Worker all call it; there is no second
 * `available_models` allowlist.
 *
 * A model the user explicitly placed on a route may make its first normal business
 * call without a prior manual test: that call produces the first observation. Being
 * listed in a catalog is *not* an authorization; unselected models are never tried.
 */

export type AdmissionPurpose = 'background' | 'connection_test';

export type AdmissionBlockReason =
  | 'connection_busy'
  | 'connection_unavailable'
  | 'ambiguous_outcome'
  | 'scope_unknown'
  | 'invalid_model_id'
  | 'model_rejected'
  | 'model_mismatch'
  | 'backoff';

export interface AdmissionInput {
  purpose: AdmissionPurpose;
  providerType: string;
  /** model_connections.status (environment level), or 'legacy' for config-only routes. */
  connectionStatus: string;
  /** Current auth binding scope state; null for API connections / legacy routes. */
  scopeState: 'known' | 'unknown' | null;
  modelId: string;
  /** Observation for exactly the current scope + epoch, if any. */
  observation: ModelObservation | null;
  now?: number;
}

export type AdmissionDecision =
  | {
      allowed: true;
      selectionMode: ModelSelectionMode;
      /** No successful observation yet under the current scope/epoch. */
      firstCall: boolean;
    }
  | {
      allowed: false;
      selectionMode: ModelSelectionMode;
      reason: AdmissionBlockReason;
      retryAt?: string;
    };

const CLI_PROVIDERS = new Set(['claude-cli', 'codex-cli']);

const ENVIRONMENT_FAILURES = new Set([
  'not_installed',
  'not_authenticated',
  'wrong_auth_method',
  'unsupported_version',
  'offline',
  'unconfigured',
]);

export function isCliProvider(providerType: string): boolean {
  return CLI_PROVIDERS.has(providerType);
}

export function evaluateModelAdmission(input: AdmissionInput): AdmissionDecision {
  const selectionMode = selectionModeFor(input.providerType, input.modelId);
  const block = (reason: AdmissionBlockReason, retryAt?: string): AdmissionDecision => ({
    allowed: false,
    selectionMode,
    reason,
    ...(retryAt ? { retryAt } : {}),
  });

  if (input.connectionStatus === 'legacy') {
    return { allowed: true, selectionMode, firstCall: false };
  }

  if (!isCliProvider(input.providerType)) {
    // API connections: the provider decides per request; only a connection-level
    // offline state blocks (unchanged behavior).
    if (input.connectionStatus === 'offline') return block('connection_unavailable');
    return { allowed: true, selectionMode, firstCall: false };
  }

  if (!isValidManualModelId(input.modelId)) return block('invalid_model_id');

  const test = input.purpose === 'connection_test';
  if (!test) {
    // An explicit test re-checks the environment itself and is the documented recovery
    // path for ambiguous / environment failures; background work is not.
    if (input.connectionStatus === 'checking' || input.connectionStatus === 'testing') {
      return block('connection_busy');
    }
    if (input.connectionStatus === 'ambiguous') return block('ambiguous_outcome');
    if (ENVIRONMENT_FAILURES.has(input.connectionStatus)) return block('connection_unavailable');
    // Unattended inference requires an identifiable account scope (design §6.1).
    // `null` means "not bound yet" (e.g. first call after upgrade): the CLI service
    // binds the scope and re-evaluates this admission before committing the prompt.
    if (input.scopeState === 'unknown') return block('scope_unknown');
  }

  const observation = input.observation;
  if (!test && observation) {
    if (observation.lastOutcome === 'mismatch') return block('model_mismatch');
    if (observation.lastOutcome === 'model_rejected') return block('model_rejected');
    if (observation.backoffUntil) {
      const until = Date.parse(observation.backoffUntil);
      if (Number.isFinite(until) && until > (input.now ?? Date.now())) {
        return block('backoff', observation.backoffUntil);
      }
    }
  }

  return {
    allowed: true,
    selectionMode,
    firstCall: !observation?.lastSuccessAt,
  };
}

/** Error kinds that describe the connection environment rather than one model. */
export const CONNECTION_LEVEL_ERROR_KINDS = new Set([
  'not_installed',
  'not_authenticated',
  'wrong_auth_method',
  'unsupported_version',
  'protocol',
]);

/** Error kinds that are transient and only warrant a cooldown. */
export const TEMPORARY_ERROR_KINDS = new Set([
  'quota',
  'rate_limit',
  'capacity',
  'timeout',
  'transient',
]);

export const BACKOFF_MS = Object.freeze({
  temporary: 5 * 60_000,
  quota: 30 * 60_000,
  unclassified: 10 * 60_000,
});
