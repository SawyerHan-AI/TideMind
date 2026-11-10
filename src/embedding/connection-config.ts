import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../types.js';
import { getMetabolismWorkerConnectionSnapshot, getMetabolismWorkerRuntimeContext } from '../metabolism/worker-runtime-context.js';
type Row = { provider_type: string; credentials: string; archived: number };
function signal(row: Row): string {
  let parsed: Record<string,unknown>;
  try { parsed = JSON.parse(row.credentials) as Record<string,unknown>; }
  catch { throw new Error('Invalid embedding connection credentials'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.values(parsed).some(value=>typeof value!=='string')) throw new Error('Invalid embedding connection credentials');
  return createHash('sha256').update(JSON.stringify([row.provider_type,row.archived,Object.keys(parsed).sort().map(key=>[key,parsed[key]])])).digest('hex');
}
/** Private frozen credentials never enter portable profiles or the cloud cache. */
export function captureEmbeddingConnection(db: Database.Database, input: AppConfig): { config: AppConfig; binding: string | null } {
  const config = structuredClone(input);
  const id = config.embedding.connection;
  if (!id) return {config,binding:null};
  if (!/^mc_[a-f0-9]{8}$/.test(id)) throw new Error('Invalid embedding connection ID');
  const worker = getMetabolismWorkerRuntimeContext();
  const frozen = worker ? getMetabolismWorkerConnectionSnapshot(id) : null;
  const row: Row | undefined = worker
    ? frozen ? {provider_type:frozen.providerType,credentials:JSON.stringify(frozen.credentials),archived:frozen.archived?1:0} : undefined
    : db.prepare('SELECT provider_type,credentials,archived FROM model_connections WHERE id=?').get(id) as Row|undefined;
  if (!row || row.archived || !['gemini','vertex','ollama'].includes(row.provider_type)) throw new Error('Embedding connection is unavailable');
  const binding = signal(row);
  const credentials = JSON.parse(row.credentials) as Record<string,string>;
  config.embedding.provider = row.provider_type as AppConfig['embedding']['provider'];
  if (row.provider_type === 'gemini') config.gemini = {...config.gemini,api_key:credentials.api_key ?? ''};
  if (row.provider_type === 'vertex') config.vertex = {...config.vertex,project_id:credentials.project_id ?? '',region:credentials.region || 'us-central1'};
  if (row.provider_type === 'ollama') config.ollama = {...config.ollama,url:credentials.url || 'http://localhost:11434'};
  return {config,binding};
}
export function embeddingConnectionCurrent(db: Database.Database, id: string|undefined, binding: string|null): boolean {
  if (!db.open) return false;
  if (!id) return binding === null;
  const row = db.prepare('SELECT provider_type,credentials,archived FROM model_connections WHERE id=?').get(id) as Row|undefined;
  if (!row || row.archived) return false;
  try { return signal(row) === binding; } catch { return false; }
}
