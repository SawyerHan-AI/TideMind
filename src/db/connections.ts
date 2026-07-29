import type Database from 'better-sqlite3';
import { now } from '../utils/time.js';
import { randomBytes } from 'node:crypto';
import type { LLMProviderType } from '../llm/provider-types.js';

export const MODEL_CONNECTION_STATUSES = [
  'unconfigured',
  'checking',
  'not_installed',
  'not_authenticated',
  'wrong_auth_method',
  'unsupported_version',
  'untested',
  'testing',
  'online',
  'degraded',
  'offline',
  'ambiguous',
] as const;
export type ModelConnectionStatus = (typeof MODEL_CONNECTION_STATUSES)[number];

export interface ModelConnection {
  id: string;
  name: string;
  provider_type: LLMProviderType;
  credentials: string;         // JSON string
  status: ModelConnectionStatus;
  available_models: string | null;  // JSON array string
  last_checked: string | null;
  status_reason: string | null;
  cli_path: string | null;
  cli_version: string | null;
  auth_method: string | null;
  auth_fingerprint: string | null;
  environment_checked_at: string | null;
  candidate_models: string | null;
  validation_fingerprint: string | null;
  model_validation_json: string | null;
  last_tested_at: string | null;
  last_test_summary: string | null;
  archived: number;
  created: string;
}

/** 解析后的凭据类型 */
export type AnthropicCredentials = { api_key: string };
export type VertexCredentials = { project_id: string; region: string };
export type GeminiCredentials = { api_key: string };
export type OllamaCredentials = { url: string };
export type OpenAICompatibleCredentials = { api_key?: string; base_url: string };
export type AccountCliCredentials = Record<string, never>;
export type ConnectionCredentials =
  | AnthropicCredentials
  | VertexCredentials
  | GeminiCredentials
  | OllamaCredentials
  | OpenAICompatibleCredentials
  | AccountCliCredentials;

function generateConnectionId(): string {
  return 'mc_' + randomBytes(4).toString('hex');
}

export function createConnection(
  db: Database.Database,
  params: { name: string; provider_type: LLMProviderType; credentials?: ConnectionCredentials },
): ModelConnection {
  const id = generateConnectionId();
  const created = now();
  const isAccountCli = params.provider_type === 'claude-cli' || params.provider_type === 'codex-cli';
  const creds = JSON.stringify(isAccountCli ? {} : (params.credentials ?? {}));
  db.prepare(
    'INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)',
  ).run(id, params.name, params.provider_type, creds, created);
  return {
    id, name: params.name, provider_type: params.provider_type,
    credentials: creds, status: 'unconfigured',
    available_models: null, last_checked: null,
    status_reason: null, cli_path: null, cli_version: null, auth_method: null,
    auth_fingerprint: null, environment_checked_at: null, candidate_models: null,
    validation_fingerprint: null, model_validation_json: null,
    last_tested_at: null, last_test_summary: null,
    archived: 0, created,
  };
}

export function getConnection(db: Database.Database, id: string): ModelConnection | undefined {
  return db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as ModelConnection | undefined;
}

export function listConnections(db: Database.Database, includeArchived = false): ModelConnection[] {
  if (includeArchived) {
    return db.prepare('SELECT * FROM model_connections ORDER BY created DESC').all() as ModelConnection[];
  }
  return db.prepare('SELECT * FROM model_connections WHERE archived = 0 ORDER BY created DESC').all() as ModelConnection[];
}

export function updateConnection(
  db: Database.Database,
  id: string,
  params: Partial<{ name: string; credentials: ConnectionCredentials }>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name); }
  if (params.credentials !== undefined) {
    const connection = getConnection(db, id);
    const credentials = connection?.provider_type === 'claude-cli'
      || connection?.provider_type === 'codex-cli'
      ? {}
      : params.credentials;
    sets.push('credentials = ?');
    values.push(JSON.stringify(credentials));
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE model_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function updateConnectionStatus(
  db: Database.Database,
  id: string,
  status: ModelConnectionStatus,
  availableModels: string[] | null,
  statusReason: string | null = null,
): void {
  db.prepare(
    'UPDATE model_connections SET status = ?, status_reason = ?, available_models = ?, last_checked = ? WHERE id = ?',
  ).run(status, statusReason, availableModels ? JSON.stringify(availableModels) : null, now(), id);
}

/** CLI 可执行文件、版本或认证指纹变化后，旧模型验证结果必须整体失效。 */
export function invalidateConnectionValidation(
  db: Database.Database,
  id: string,
  statusReason: string,
): void {
  db.prepare(`
    UPDATE model_connections
    SET status = 'untested',
        status_reason = ?,
        available_models = NULL,
        validation_fingerprint = NULL,
        model_validation_json = NULL,
        last_tested_at = NULL,
        last_test_summary = NULL
    WHERE id = ?
  `).run(statusReason, id);
}

export interface CliConnectionEnvironmentUpdate {
  status: ModelConnectionStatus;
  statusReason: string | null;
  cliPath: string | null;
  cliVersion: string | null;
  authMethod: string | null;
  authFingerprint: string | null;
  candidateModels: string[];
  environmentCheckedAt: string;
}

/**
 * 保存 CLI 环境探测；影响 validation fingerprint 的环境变化与验证失效同事务提交。
 */
export function updateCliConnectionEnvironment(
  db: Database.Database,
  id: string,
  update: CliConnectionEnvironmentUpdate,
): { validationInvalidated: boolean } {
  const tx = db.transaction(() => {
    const previous = db.prepare(`
      SELECT cli_path, cli_version, auth_method, auth_fingerprint, candidate_models
      FROM model_connections WHERE id = ?
    `).get(id) as Pick<
      ModelConnection,
      'cli_path' | 'cli_version' | 'auth_method' | 'auth_fingerprint' | 'candidate_models'
    > | undefined;
    if (!previous) throw new Error(`Model connection not found: ${id}`);

    const candidateModels = JSON.stringify(update.candidateModels);
    const validationInvalidated =
      previous.cli_path !== update.cliPath
      || previous.cli_version !== update.cliVersion
      || previous.auth_method !== update.authMethod
      || previous.auth_fingerprint !== update.authFingerprint
      || previous.candidate_models !== candidateModels;

    db.prepare(`
      UPDATE model_connections
      SET status = ?,
          status_reason = ?,
          cli_path = ?,
          cli_version = ?,
          auth_method = ?,
          auth_fingerprint = ?,
          environment_checked_at = ?,
          candidate_models = ?,
          available_models = CASE WHEN ? THEN NULL ELSE available_models END,
          validation_fingerprint = CASE WHEN ? THEN NULL ELSE validation_fingerprint END,
          model_validation_json = CASE WHEN ? THEN NULL ELSE model_validation_json END,
          last_tested_at = CASE WHEN ? THEN NULL ELSE last_tested_at END,
          last_test_summary = CASE WHEN ? THEN NULL ELSE last_test_summary END
      WHERE id = ?
    `).run(
      update.status,
      update.statusReason,
      update.cliPath,
      update.cliVersion,
      update.authMethod,
      update.authFingerprint,
      update.environmentCheckedAt,
      candidateModels,
      validationInvalidated ? 1 : 0,
      validationInvalidated ? 1 : 0,
      validationInvalidated ? 1 : 0,
      validationInvalidated ? 1 : 0,
      validationInvalidated ? 1 : 0,
      id,
    );
    return { validationInvalidated };
  });
  return tx();
}

export function archiveConnection(db: Database.Database, id: string): void {
  db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(id);
}

export function unarchiveConnection(db: Database.Database, id: string): void {
  db.prepare('UPDATE model_connections SET archived = 0 WHERE id = ?').run(id);
}

export function deleteConnection(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM model_connections WHERE id = ?').run(id);
}
