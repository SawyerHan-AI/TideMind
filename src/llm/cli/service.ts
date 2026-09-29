import type Database from 'better-sqlite3';
import { getMetabolismWorkerConnectionSnapshot, getMetabolismWorkerRuntimeContext } from '../../metabolism/worker-runtime-context.js';
import { createLogger } from '../../utils/logger.js';
import { getLLMInvocationContext } from '../invocation-context.js';
import { CliChildProcessRunner } from './child-process-runner.js';
import { cliProcessRegistry } from './runtime-process-registry.js';
import { ClaudeCliAdapter } from './claude.js';
import { CodexCliAdapter } from './codex.js';
import { CliLLMError, isDefinitiveProviderRejection } from './errors.js';
import {
  assertCliCapacityFence,
  withCliCapacityLease,
} from './capacity-lease.js';
import {
  finishCliInvocation,
  finishCliInvocationFenced,
  markCliPromptCommitted,
  startCliInvocation,
} from './invocation-state.js';
import { checkCliEnvironment, type CliEnvironmentCheck } from './readiness.js';
import { pinnedModelMatches } from './catalogs.js';
import {
  authBindingMatches,
  getCatalogSnapshot,
  getModelObservation,
  reconcileAuthBinding,
  recordModelObservation,
  type ObservationOutcome,
} from '../../db/model-discovery.js';
import {
  BACKOFF_MS,
  CONNECTION_LEVEL_ERROR_KINDS,
  TEMPORARY_ERROR_KINDS,
  evaluateModelAdmission,
  type AdmissionBlockReason,
} from '../model-admission.js';
import type {
  CliInvocationPurpose,
  CliLLMRequest,
  CliLLMResult,
} from './types.js';

const registry = cliProcessRegistry;
const runner = new CliChildProcessRunner(registry);
const log = createLogger('llm-cli');

type ConnectionRow = {
  id: string;
  provider_type: string;
  archived: number;
  status: string;
};

const ENVIRONMENT_HEALABLE = new Set([
  'unconfigured',
  'not_installed',
  'not_authenticated',
  'wrong_auth_method',
  'unsupported_version',
  'offline',
  'degraded',
]);

/**
 * Persist the freshly verified environment. Unlike the previous implementation this
 * never clears model history: a CLI or auth change only moves observations to a new
 * epoch (reconcileAuthBinding). An environment status that the check just disproved
 * is healed to 'untested'; 'ambiguous' is kept until explicitly resolved.
 */
function saveEnvironment(
  db: Database.Database,
  connectionId: string,
  environment: CliEnvironmentCheck,
): void {
  db.prepare(`
    UPDATE model_connections
    SET cli_path = ?,
        cli_version = ?,
        auth_method = ?,
        auth_fingerprint = ?,
        validation_fingerprint = ?,
        environment_checked_at = ?,
        last_checked = ?,
        status = CASE WHEN status IN (${[...ENVIRONMENT_HEALABLE].map(() => '?').join(', ')})
                      THEN 'untested' ELSE status END,
        status_reason = CASE WHEN status IN (${[...ENVIRONMENT_HEALABLE].map(() => '?').join(', ')})
                             THEN NULL ELSE status_reason END
    WHERE id = ? AND archived = 0
  `).run(
    environment.resolved.path,
    environment.resolved.version,
    environment.auth.method,
    environment.authFingerprint,
    environment.cliGeneration,
    environment.checkedAt,
    environment.checkedAt,
    ...ENVIRONMENT_HEALABLE,
    ...ENVIRONMENT_HEALABLE,
    connectionId,
  );
}

function admissionError(reason: AdmissionBlockReason, modelId: string, retryAt?: string): CliLLMError {
  switch (reason) {
    case 'scope_unknown':
      return new CliLLMError(
        'scope_unknown',
        '无法确认 CLI 当前登录的账号范围，后台调用已暂停；可在设置中对指定模型做一次测试',
        { needsUserAction: true, admissionReason: reason },
      );
    case 'model_mismatch':
      return new CliLLMError(
        'model_mismatch',
        `固定模型 ${modelId} 上次返回了非预期的实际模型，后台已停用该选择；请在设置中复测该模型`,
        { needsUserAction: true, admissionReason: reason },
      );
    case 'model_rejected':
      return new CliLLMError(
        'model_unavailable',
        `当前账号无法使用模型 ${modelId}（已被明确拒绝）；可在设置中复测或更换模型`,
        { needsUserAction: true, admissionReason: reason },
      );
    case 'backoff':
      return new CliLLMError(
        'transient',
        `模型 ${modelId} 最近暂时失败，冷却中`,
        { retryable: true, retryAt: retryAt ? Date.parse(retryAt) : undefined, admissionReason: reason },
      );
    case 'invalid_model_id':
      return new CliLLMError('model_unavailable', `模型 ID ${modelId.slice(0, 80)} 无效`, {
        needsUserAction: true,
        admissionReason: reason,
      });
    case 'connection_busy':
      return new CliLLMError('capacity', '模型连接正在检查或测试', { retryable: true, admissionReason: reason });
    case 'ambiguous_outcome':
      return new CliLLMError('ambiguous_outcome', '上次调用结果不明，后台调用已暂停', {
        needsUserAction: true,
        admissionReason: reason,
      });
    case 'connection_unavailable':
    default:
      return new CliLLMError('unsupported_version', '模型连接环境不可用，请在设置中检查环境', {
        needsUserAction: true,
        admissionReason: reason,
      });
  }
}

function observationForError(
  error: CliLLMError,
  now: number,
): { outcome: ObservationOutcome; backoffUntil: string | null } | null {
  if (error.kind === 'aborted' || error.kind === 'capacity') return null;
  if (error.kind === 'ambiguous_outcome') return { outcome: 'ambiguous', backoffUntil: null };
  if (error.kind === 'model_unavailable') return { outcome: 'model_rejected', backoffUntil: null };
  if (CONNECTION_LEVEL_ERROR_KINDS.has(error.kind)) {
    return { outcome: 'connection_failure', backoffUntil: null };
  }
  if (TEMPORARY_ERROR_KINDS.has(error.kind)) {
    const ms = error.kind === 'quota' ? BACKOFF_MS.quota : BACKOFF_MS.temporary;
    const retryAt = error.options.retryAt && error.options.retryAt > now ? error.options.retryAt : now + ms;
    return { outcome: 'temporary_failure', backoffUntil: new Date(retryAt).toISOString() };
  }
  // Generic exit 1 and other unrecognized failures: never read as "model retired".
  return {
    outcome: 'unclassified_failure',
    backoffUntil: new Date(now + BACKOFF_MS.unclassified).toISOString(),
  };
}

export async function runCliLLM(
  db: Database.Database,
  dataDir: string,
  request: CliLLMRequest,
  options: {
    purpose?: CliInvocationPurpose;
    allowLoginShell?: boolean;
    environment?: CliEnvironmentCheck;
    /** Re-check the selected route immediately before stdin submission. */
    validateRoute?: () => void;
    _testHooks?: {
      afterProviderCompleted?: () => void;
      beforeOutcomePersistence?: () => void;
      beforePromptCommit?: () => void;
      recheckEnvironment?: () => Promise<CliEnvironmentCheck>;
    };
  } = {},
): Promise<CliLLMResult> {
  const row = db.prepare(`
    SELECT id, provider_type, archived, status
    FROM model_connections WHERE id = ?
  `).get(request.connectionId) as ConnectionRow | undefined;
  const workerContext = getMetabolismWorkerRuntimeContext();
  const workerConnection = workerContext ? getMetabolismWorkerConnectionSnapshot(request.connectionId) : null;
  if ((!row && !workerConnection) || (workerContext && !workerConnection) || (row ? row.archived !== 0 : workerConnection!.archived)) {
    throw new CliLLMError('protocol', '模型连接不存在或已归档', {
      needsUserAction: true,
    });
  }
  if ((row?.provider_type ?? workerConnection!.providerType) !== request.providerType) {
    throw new CliLLMError('protocol', '模型连接 provider 不匹配', {
      needsUserAction: true,
    });
  }

  const purpose = options.purpose ?? request.purpose ?? 'background';
  const environment = options.environment ?? await checkCliEnvironment({
    providerType: request.providerType,
    allowLoginShell: options.allowLoginShell ?? false,
    dataDir,
    signal: request.signal,
  });
  saveEnvironment(db, request.connectionId, environment);
  const { binding } = reconcileAuthBinding(db, {
    connectionId: request.connectionId,
    auth: environment.auth,
    cliGeneration: environment.cliGeneration,
    authStoreSignal: environment.authStoreSignal,
  });

  const liveStatus = (db.prepare('SELECT status FROM model_connections WHERE id = ?')
    .get(request.connectionId) as { status: string } | undefined)?.status
    ?? row?.status
    ?? workerConnection?.status
    ?? 'unconfigured';
  const modelId = request.modelAlias;
  const admissionFor = () => evaluateModelAdmission({
    purpose,
    providerType: request.providerType,
    connectionStatus: purpose === 'background'
      ? ((db.prepare('SELECT status FROM model_connections WHERE id = ?')
        .get(request.connectionId) as { status: string } | undefined)?.status ?? liveStatus)
      : liveStatus,
    scopeState: binding.scopeState,
    modelId,
    observation: getModelObservation(db, request.connectionId, binding.scopeKey, binding.authEpoch, modelId),
  });
  const admission = admissionFor();
  if (!admission.allowed) throw admissionError(admission.reason, modelId, admission.retryAt);
  const selectionMode = admission.selectionMode;

  // The catalog may map a selection key to a different CLI argument; manual ids and
  // aliases pass through unchanged. Either way the value is one independent argv item.
  const catalog = getCatalogSnapshot(db, request.connectionId);
  const catalogItem = catalog?.scopeKey === binding.scopeKey
    && catalog.authEpoch === binding.authEpoch
    && catalog.cliGeneration === environment.cliGeneration
    ? catalog.items.find((item) => item.id === modelId) ?? null
    : null;
  const invocationModel = catalogItem?.invocationId ?? modelId;

  const context = getLLMInvocationContext();
  const invocation = startCliInvocation(db, {
    connectionId: request.connectionId,
    providerType: request.providerType,
    accountScope: environment.auth.accountScope,
    taskId: context?.workItemId ?? context?.taskId ?? null,
    operationName: request.operationName ?? context?.operation ?? null,
    modelAlias: modelId,
  });
  let promptCommitted = false;
  let providerCompleted = false;

  const recordObservation = (
    outcome: ObservationOutcome,
    extra: { errorKind?: string; errorMessage?: string; actualModel?: string | null; backoffUntil?: string | null } = {},
  ): void => {
    // Only record evidence while the binding still carries the scope/epoch the call was
    // admitted under; otherwise the result's account attribution is unconfirmed.
    if (!authBindingMatches(db, request.connectionId, binding.scopeKey, binding.authEpoch)) return;
    recordModelObservation(db, {
      connectionId: request.connectionId,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      modelId,
      selectionMode,
      outcome,
      source: purpose === 'background' ? 'business' : 'test',
      errorKind: extra.errorKind ?? null,
      errorMessage: extra.errorMessage ?? null,
      actualModel: extra.actualModel ?? null,
      backoffUntil: extra.backoffUntil ?? null,
    });
  };

  const assertCurrentRoute = (): void => {
    const liveConnection = db.prepare('SELECT archived, provider_type FROM model_connections WHERE id = ?')
      .get(request.connectionId) as { archived: number; provider_type: string } | undefined;
    if (!liveConnection || liveConnection.archived !== 0 || liveConnection.provider_type !== request.providerType) {
      throw new CliLLMError('aborted', '模型连接已删除、归档或改变，本次未提交');
    }
    if (workerContext) {
      const revision = db.prepare("SELECT value FROM metadata WHERE key = 'metabolism_worker_runtime_revision'")
        .get() as { value: string } | undefined;
      if (revision?.value !== String(workerContext.runtimeRevision)) {
        throw new CliLLMError('aborted', 'Worker 模型路由快照已失效，本次未提交');
      }
    }
    options.validateRoute?.();
  };

  const recheckBinding = async (): Promise<void> => {
    const fresh = await (options._testHooks?.recheckEnvironment?.() ?? checkCliEnvironment({
      providerType: request.providerType,
      allowLoginShell: options.allowLoginShell ?? false,
      dataDir,
      signal: request.signal,
      freshAuth: true,
    }));
    // A fresh official observation is required even when the auth-store stat is stable.
    // Never restore an old response into a newer binding.
    if (fresh.auth.scopeKey !== binding.scopeKey
      || fresh.auth.scopeState !== binding.scopeState
      || fresh.cliGeneration !== environment.cliGeneration
      || fresh.auth.method !== environment.auth.method) {
      reconcileAuthBinding(db, {
        connectionId: request.connectionId,
        auth: fresh.auth,
        cliGeneration: fresh.cliGeneration,
        authStoreSignal: fresh.authStoreSignal,
      });
      throw new CliLLMError('not_authenticated', 'CLI 或账号范围发生变化，调用归属无法确认', {
        needsUserAction: true,
      });
    }
    if (!authBindingMatches(db, request.connectionId, binding.scopeKey, binding.authEpoch)) {
      throw new CliLLMError('not_authenticated', 'CLI 认证绑定已失效', { needsUserAction: true });
    }
  };

  try {
    const result = await withCliCapacityLease(
      db,
      {
        accountScope: environment.auth.accountScope,
        connectionId: request.connectionId,
        invocationId: invocation.id,
        signal: request.signal,
      },
      async (lease, signal) => {
        const hooks = {
          beforePromptCommit: async () => {
            assertCliCapacityFence(db, lease);
            options._testHooks?.beforePromptCommit?.();
            await recheckBinding();
            assertCliCapacityFence(db, lease);
            assertCurrentRoute();
            // Final re-check under the lease, immediately before the prompt is
            // committed: auth scope/epoch unchanged and admission still granted
            // (a concurrent test, ambiguity or rejection may have landed meanwhile).
            if (!authBindingMatches(db, request.connectionId, binding.scopeKey, binding.authEpoch)) {
              throw new CliLLMError('not_authenticated', 'CLI 登录范围在提交前发生变化，本次未提交', {
                needsUserAction: false,
              });
            }
            const final = admissionFor();
            if (!final.allowed) throw admissionError(final.reason, modelId, final.retryAt);
          },
          onPromptCommitted: () => {
            db.transaction(() => {
              assertCurrentRoute();
              markCliPromptCommitted(db, invocation.id, lease);
              promptCommitted = true;
            }).immediate();
          },
        };
        const common = {
          resolved: environment.resolved,
          dataDir,
          runner,
          preflight: () => assertCliCapacityFence(db, lease),
          hooks,
          invocationId: () => invocation.id,
        };
        const adapter = request.providerType === 'claude-cli'
          ? new ClaudeCliAdapter(common)
          : new CodexCliAdapter({
              ...common,
              toolCatalogJson: environment.codexToolCatalogJson
                ?? (() => { throw new CliLLMError('unsupported_version', 'Codex tool isolation catalog missing'); })(),
              contract: environment.codexContract
                ?? (() => { throw new CliLLMError('unsupported_version', 'Codex execution contract missing'); })(),
            });
        const result = await adapter.run({
          ...request,
          modelAlias: invocationModel,
          purpose,
          signal,
        });
        providerCompleted = true;
        options._testHooks?.afterProviderCompleted?.();
        await recheckBinding();
        try {
          assertCliCapacityFence(db, lease);
        } catch (error) {
          if (purpose === 'background') {
            throw new CliLLMError(
              'ambiguous_outcome',
              'CLI result cannot be committed after capacity fencing was lost',
              { needsUserAction: true, promptCommitted: true, cause: error },
            );
          }
          throw error;
        }
        const mismatch = selectionMode === 'pinned_id'
          && result.actualModel !== null
          && !pinnedModelMatches(invocationModel, result.actualModel);
        db.transaction(() => {
          assertCliCapacityFence(db, lease);
          if (!authBindingMatches(db, request.connectionId, binding.scopeKey, binding.authEpoch)) {
            throw new CliLLMError('ambiguous_outcome', 'CLI result binding changed before persistence', {
              needsUserAction: true, promptCommitted: true,
            });
          }
          if (!finishCliInvocationFenced(db, {
            invocationId: invocation.id,
            outcome: 'success',
            actualModel: result.actualModel,
          }, lease)) {
            throw new CliLLMError(
              'ambiguous_outcome',
              'CLI result cannot be committed with the current capacity fence',
              { needsUserAction: true, promptCommitted: true },
            );
          }
          if (mismatch) {
            recordObservation('mismatch', {
              errorKind: 'model_mismatch',
              errorMessage: `requested ${invocationModel}, actual ${result.actualModel}`,
              actualModel: result.actualModel,
            });
          } else {
            const previous = getModelObservation(
              db,
              request.connectionId,
              binding.scopeKey,
              binding.authEpoch,
              modelId,
            );
            // An explicit test clears a pinned mismatch only when the actual model is
            // known and matches; unknown actual keeps the mismatch (design §5.4).
            const keepsMismatch = previous?.lastOutcome === 'mismatch'
              && selectionMode === 'pinned_id'
              && result.actualModel === null;
            if (!keepsMismatch) {
              recordObservation('success', { actualModel: result.actualModel });
            }
          }
        }).immediate();
        if (mismatch && purpose === 'background') {
          // The call happened and is accounted for, but a pinned model was silently
          // substituted: the result is not adopted and the task is not replayed.
          throw new CliLLMError(
            'model_mismatch',
            `固定模型 ${invocationModel} 实际返回 ${result.actualModel}，结果未被采用`,
            { needsUserAction: true },
          );
        }
        return result;
      },
    );
    if (purpose === 'background' && liveStatus === 'untested') {
      db.prepare(`
        UPDATE model_connections SET status = 'online', status_reason = NULL
        WHERE id = ? AND archived = 0 AND status = 'untested'
      `).run(request.connectionId);
    }
    return result;
  } catch (error) {
    let cliError = error instanceof CliLLMError
      ? error
      : new CliLLMError('transient', (error as Error).message, { cause: error });
    if (
      purpose === 'background'
      && (providerCompleted || promptCommitted)
      && cliError.kind !== 'ambiguous_outcome'
      && cliError.kind !== 'model_mismatch'
      && !(isDefinitiveProviderRejection(cliError) && !providerCompleted)
    ) {
      cliError = new CliLLMError(
        'ambiguous_outcome',
        'CLI result could not be durably finalized after prompt submission',
        {
          needsUserAction: true,
          promptCommitted: true,
          cause: error,
        },
      );
    }
    const outcome = cliError.kind === 'ambiguous_outcome'
      ? 'ambiguous'
      : cliError.kind === 'aborted'
        ? 'aborted'
        : cliError.kind === 'model_mismatch'
          ? null
          : 'definite_failure';
    try {
      options._testHooks?.beforeOutcomePersistence?.();
      db.transaction(() => {
        if (outcome) {
          finishCliInvocation(db, {
            invocationId: invocation.id,
            outcome,
            errorKind: cliError.kind,
          });
        }
        if (cliError.kind === 'ambiguous_outcome') {
          db.prepare(`
            UPDATE model_connections
            SET status = 'ambiguous',
                status_reason = '上次调用结果不明，后台调用已暂停'
            WHERE id = ? AND archived = 0
          `).run(request.connectionId);
          if (context?.workItemId) {
            db.prepare(`
              UPDATE pending_digests
              SET status = 'ambiguous',
                  ambiguous_invocation_id = ?,
                  error_message = ?,
                  processing_started_at = NULL
              WHERE id = ? AND status IN ('pending', 'processing')
            `).run(invocation.id, cliError.message.slice(0, 500), context.workItemId);
          }
        }
        // Admission refusals made before submission are not new observations.
        if (!cliError.options.admissionReason && cliError.kind !== 'model_mismatch') {
          const observed = observationForError(cliError, Date.now());
          if (observed) {
            recordObservation(observed.outcome, {
              errorKind: cliError.kind,
              errorMessage: cliError.message,
              backoffUntil: observed.backoffUntil,
            });
          }
        }
      }).immediate();
    } catch (persistenceError) {
      // Preserve the primary provider classification. In particular, an
      // ambiguous outcome must reach the scheduler even if SQLite is
      // temporarily unable to persist the pause; startup reconciliation can
      // repair a committed running invocation later.
      log.error(`CLI outcome persistence failed: ${(persistenceError as Error).message}`);
    }
    Object.assign(cliError, { invocationId: invocation.id });
    throw cliError;
  }
}

export async function shutdownCliRuntime(): Promise<void> {
  await registry.shutdown();
}

export function getCliRuntimeActiveCount(): number {
  return registry.activeCount;
}
