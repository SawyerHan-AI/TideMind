import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import { getLLMInvocationContext } from '../invocation-context.js';
import { CliChildProcessRunner, CliProcessRegistry } from './child-process-runner.js';
import { ClaudeCliAdapter } from './claude.js';
import { CodexCliAdapter } from './codex.js';
import { CliLLMError } from './errors.js';
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
import type {
  CliInvocationPurpose,
  CliLLMRequest,
  CliLLMResult,
} from './types.js';

const registry = new CliProcessRegistry();
const runner = new CliChildProcessRunner(registry);
const log = createLogger('llm-cli');

type ConnectionRow = {
  id: string;
  provider_type: string;
  archived: number;
  status: string;
  candidate_models: string | null;
  available_models: string | null;
  validation_fingerprint: string | null;
  model_validation_json: string | null;
};

function parseArray(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseValidation(
  raw: string | null,
): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function saveEnvironment(
  db: Database.Database,
  connection: ConnectionRow,
  environment: CliEnvironmentCheck,
): void {
  db.transaction(() => {
    const fingerprintChanged = (
      connection.validation_fingerprint !== null
      && connection.validation_fingerprint !== environment.validationFingerprint
    );
    const columns = [
      'cli_path = ?',
      'cli_version = ?',
      'auth_method = ?',
      'auth_fingerprint = ?',
      'environment_checked_at = ?',
      'candidate_models = ?',
      'last_checked = ?',
    ];
    const params: unknown[] = [
      environment.resolved.path,
      environment.resolved.version,
      environment.auth.method,
      environment.authFingerprint,
      environment.checkedAt,
      JSON.stringify(environment.candidateModels),
      environment.checkedAt,
    ];
    if (fingerprintChanged) {
      columns.push(
        "status = 'untested'",
        'status_reason = NULL',
        'available_models = NULL',
        'validation_fingerprint = NULL',
        'model_validation_json = NULL',
        'last_tested_at = NULL',
        'last_test_summary = NULL',
      );
    } else if (connection.status === 'unconfigured') {
      columns.push("status = 'untested'", 'status_reason = NULL');
    }
    params.push(connection.id);
    db.prepare(
      `UPDATE model_connections SET ${columns.join(', ')} WHERE id = ? AND archived = 0`,
    ).run(...params);
  })();
}

function updateAliasAfterBackgroundResult(
  db: Database.Database,
  connectionId: string,
  modelAlias: string,
  result: CliLLMResult | null,
  error: CliLLMError | null,
): void {
  const row = db.prepare(`
    SELECT status, candidate_models, available_models, model_validation_json
    FROM model_connections WHERE id = ?
  `).get(connectionId) as {
    status: string;
    candidate_models: string | null;
    available_models: string | null;
    model_validation_json: string | null;
  } | undefined;
  if (!row) return;
  const candidates = parseArray(row.candidate_models);
  const available = new Set(parseArray(row.available_models));
  const validations = parseValidation(row.model_validation_json);
  if (result) {
    available.add(modelAlias);
    validations[modelAlias] = {
      success: true,
      actualModel: result.actualModel,
      checkedAt: new Date().toISOString(),
    };
  } else if (error?.kind === 'model_unavailable') {
    available.delete(modelAlias);
    validations[modelAlias] = {
      success: false,
      errorKind: error.kind,
      error: error.message.slice(0, 500),
      checkedAt: new Date().toISOString(),
    };
  } else {
    return;
  }

  const covered = candidates.length > 0
    && candidates.every(candidate => validations[candidate] !== undefined);
  let status = row.status;
  if (row.status !== 'ambiguous' && error?.kind === 'model_unavailable') {
    if (available.size > 0) status = 'degraded';
    else if (covered) status = 'offline';
    else status = 'untested';
  } else if (row.status === 'untested') {
    // A single background success verifies the alias, not the full catalog.
    status = 'untested';
  }
  db.prepare(`
    UPDATE model_connections
    SET status = ?,
        status_reason = ?,
        available_models = ?,
        model_validation_json = ?
    WHERE id = ? AND archived = 0
  `).run(
    status,
    error?.kind === 'model_unavailable' ? error.message.slice(0, 500) : null,
    JSON.stringify([...available]),
    JSON.stringify(validations),
    connectionId,
  );
}

export async function runCliLLM(
  db: Database.Database,
  dataDir: string,
  request: CliLLMRequest,
  options: {
    purpose?: CliInvocationPurpose;
    allowLoginShell?: boolean;
    environment?: CliEnvironmentCheck;
    _testHooks?: {
      afterProviderCompleted?: () => void;
      beforeOutcomePersistence?: () => void;
    };
  } = {},
): Promise<CliLLMResult> {
  const row = db.prepare(`
    SELECT id, provider_type, archived, status, candidate_models,
           available_models, validation_fingerprint, model_validation_json
    FROM model_connections WHERE id = ?
  `).get(request.connectionId) as ConnectionRow | undefined;
  if (!row || row.archived) {
    throw new CliLLMError('protocol', '模型连接不存在或已归档', {
      needsUserAction: true,
    });
  }
  if (row.provider_type !== request.providerType) {
    throw new CliLLMError('protocol', '模型连接 provider 不匹配', {
      needsUserAction: true,
    });
  }

  const environment = options.environment ?? await checkCliEnvironment({
    providerType: request.providerType,
    allowLoginShell: options.allowLoginShell ?? false,
    signal: request.signal,
  });
  const purpose = options.purpose ?? request.purpose ?? 'background';
  if (purpose === 'background') {
    if (row.validation_fingerprint !== environment.validationFingerprint) {
      saveEnvironment(db, row, environment);
      throw new CliLLMError(
        'unsupported_version',
        'CLI 路径、版本或登录状态已变化，请重新测试连接',
        { needsUserAction: true },
      );
    }
    if (!parseArray(row.available_models).includes(request.modelAlias)) {
      throw new CliLLMError(
        'model_unavailable',
        `模型 ${request.modelAlias} 尚未在当前 CLI 环境中验证成功`,
        { needsUserAction: true },
      );
    }
  }
  saveEnvironment(db, row, environment);
  if (!environment.candidateModels.includes(request.modelAlias)) {
    throw new CliLLMError('model_unavailable', `模型 ${request.modelAlias} 不在当前 CLI 候选目录`);
  }

  const context = getLLMInvocationContext();
  const invocation = startCliInvocation(db, {
    connectionId: request.connectionId,
    providerType: request.providerType,
    accountScope: environment.auth.accountScope,
    taskId: context?.workItemId ?? context?.taskId ?? null,
    operationName: request.operationName ?? context?.operation ?? null,
    modelAlias: request.modelAlias,
  });
  let promptCommitted = false;
  let providerCompleted = false;

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
          beforePromptCommit: () => assertCliCapacityFence(db, lease),
          onPromptCommitted: () => {
            markCliPromptCommitted(db, invocation.id, lease);
            promptCommitted = true;
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
              manifest: environment.codexGate?.manifest
                ?? (() => { throw new CliLLMError('unsupported_version', 'Codex capability manifest missing'); })(),
            });
        const result = await adapter.run({
          ...request,
          purpose,
          signal,
        });
        providerCompleted = true;
        options._testHooks?.afterProviderCompleted?.();
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
        db.transaction(() => {
          assertCliCapacityFence(db, lease);
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
          if (purpose === 'background') {
            updateAliasAfterBackgroundResult(
              db,
              request.connectionId,
              request.modelAlias,
              result,
              null,
            );
          }
        }).immediate();
        return result;
      },
    );
    return result;
  } catch (error) {
    let cliError = error instanceof CliLLMError
      ? error
      : new CliLLMError('transient', (error as Error).message, { cause: error });
    if (
      purpose === 'background'
      && (providerCompleted || promptCommitted)
      && cliError.kind !== 'ambiguous_outcome'
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
        : 'definite_failure';
    try {
      options._testHooks?.beforeOutcomePersistence?.();
      db.transaction(() => {
        finishCliInvocation(db, {
          invocationId: invocation.id,
          outcome,
          errorKind: cliError.kind,
        });
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
        } else if (purpose === 'background') {
          updateAliasAfterBackgroundResult(
            db,
            request.connectionId,
            request.modelAlias,
            null,
            cliError,
          );
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
