import type Database from 'better-sqlite3';
import { now } from '../utils/time.js';
import { randomBytes } from 'node:crypto';

export interface ModelConnection {
  id: string;
  name: string;
  provider_type: string;       // 'anthropic' | 'vertex' | 'gemini' | 'ollama'
  credentials: string;         // JSON string
  status: string;              // 'online' | 'offline' | 'unconfigured'
  available_models: string | null;  // JSON array string
  last_checked: string | null;
  archived: number;
  created: string;
}

/** 解析后的凭据类型 */
export type AnthropicCredentials = { api_key: string };
export type VertexCredentials = { project_id: string; region: string };
export type GeminiCredentials = { api_key: string };
export type OllamaCredentials = { url: string };
export type ConnectionCredentials = AnthropicCredentials | VertexCredentials | GeminiCredentials | OllamaCredentials;

function generateConnectionId(): string {
  return 'mc_' + randomBytes(4).toString('hex');
}

export function createConnection(
  db: Database.Database,
  params: { name: string; provider_type: string; credentials?: ConnectionCredentials },
): ModelConnection {
  const id = generateConnectionId();
  const created = now();
  const creds = JSON.stringify(params.credentials ?? {});
  db.prepare(
    'INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)',
  ).run(id, params.name, params.provider_type, creds, created);
  return {
    id, name: params.name, provider_type: params.provider_type,
    credentials: creds, status: 'unconfigured',
    available_models: null, last_checked: null,
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
  if (params.credentials !== undefined) { sets.push('credentials = ?'); values.push(JSON.stringify(params.credentials)); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE model_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function updateConnectionStatus(
  db: Database.Database,
  id: string,
  status: string,
  availableModels: string[] | null,
): void {
  db.prepare(
    'UPDATE model_connections SET status = ?, available_models = ?, last_checked = ? WHERE id = ?',
  ).run(status, availableModels ? JSON.stringify(availableModels) : null, now(), id);
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
