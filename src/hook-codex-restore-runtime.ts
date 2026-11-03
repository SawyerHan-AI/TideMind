
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './config.js';
import { evaluateBridgeAdmission } from './agent-bridge-guard.js';
import { createContextRestoreStore, type ContextRestoreScope } from './hook-codex-context-restore.js';

export const CODEX_HOOK_INPUT_LIMIT = 1024 * 1024;
export const CODEX_HOOK_INPUT_TIMEOUT_MS = 2000;

/** Bounded input only; never persists prompt, transcript path or malformed bytes. */
export async function readCodexHookPayload(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  timeoutMs = CODEX_HOOK_INPUT_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  if (input.isTTY) return null;
  return new Promise(resolve => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > CODEX_HOOK_INPUT_LIMIT) return finish(null);
      chunks.push(data);
    };
    const onEnd = () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown> : null);
      } catch { finish(null); }
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

export function codexRestoreInput(payload: Record<string, unknown> | null, event: 'PostCompact' | 'UserPromptSubmit' | 'SessionStart'):
  { sessionId: string; turnId: string; trigger?: 'manual' | 'auto' } | null {
  if (payload?.hook_event_name !== event || typeof payload.session_id !== 'string' || !payload.session_id.trim()) return null;
  if (event !== 'SessionStart' && (typeof payload.turn_id !== 'string' || !payload.turn_id.trim())) return null;
  return { sessionId: payload.session_id, turnId: typeof payload.turn_id === 'string' ? payload.turn_id : '',
    ...(event === 'PostCompact' && (payload.trigger === 'manual' || payload.trigger === 'auto') ? { trigger: payload.trigger } : {}),
  };
}

/** Existing database only. This dedicated hook connection never runs migrations. */
export function openCodexRestoreRuntime(agentId: string, generation: string, sessionId: string): {
  db: Database.Database; scope: ContextRestoreScope; store: ReturnType<typeof createContextRestoreStore>; admitted: () => boolean; close: () => void;
} {
  if (!agentId.trim() || !generation.trim() || !sessionId.trim()) throw new Error('codex_restore_identifiers_missing');
  const canonicalDataDir = fs.realpathSync(getDataDir());
  const db = new Database(path.join(canonicalDataDir, 'graph', 'brain.sqlite'), { fileMustExist: true, timeout: 100 });
  const scope: ContextRestoreScope = { canonicalDataDir, agentId, generation, sessionId };
  const admitted = () => evaluateBridgeAdmission(db, { agentId, activityGenerationToken: generation, componentKey: 'lifecycle' }).allowed;
  return { db, scope, store: createContextRestoreStore(db), admitted, close: () => db.close() };
}
