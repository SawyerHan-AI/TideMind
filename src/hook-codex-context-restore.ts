import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const CONTEXT_RESTORE_PREFIX = 'codex_context_restore:v1:';
export const CONTEXT_RESTORE_MAX_BYTES = 2 * 1024;
export const CONTEXT_RESTORE_CLAIM_MS = 30_000;
export const CONTEXT_RESTORE_RECORD_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTEXT_RESTORE_CLEANUP_LIMIT = 100;

export interface ContextRestoreScope {
  /** The caller supplies the real, canonical data directory; no directory IO here. */
  canonicalDataDir: string;
  agentId: string;
  generation: string;
  sessionId: string;
}

export interface ContextRestoreClaim {
  revision: number;
  claimId: string;
  turnIdHash: string;
  expiresAt: number;
}

export interface ContextRestoreState {
  pendingRevision: number;
  deliveredRevision: number;
  claim?: ContextRestoreClaim;
  deliveredTurnIdHash?: string;
  updatedAt: number;
  expiresAt: number;
}

interface StoredRecord {
  raw: string | null;
  state: ContextRestoreState | null;
}

const HASH = /^[a-f0-9]{64}$/;
const BASE_FIELDS = ['pendingRevision', 'deliveredRevision', 'updatedAt', 'expiresAt'];
const CLAIM_FIELDS = ['revision', 'claimId', 'turnIdHash', 'expiresAt'];

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validClaim(value: unknown): value is ContextRestoreClaim {
  return object(value) && Object.keys(value).length === CLAIM_FIELDS.length
    && CLAIM_FIELDS.every(key => Object.hasOwn(value, key))
    && integer(value.revision, 1) && nonempty(value.claimId)
    && Buffer.byteLength(value.claimId, 'utf8') <= 128
    && typeof value.turnIdHash === 'string' && HASH.test(value.turnIdHash)
    && integer(value.expiresAt, 1);
}

function decode(raw: string): ContextRestoreState | null {
  if (Buffer.byteLength(raw, 'utf8') > CONTEXT_RESTORE_MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !BASE_FIELDS.every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => ![...BASE_FIELDS, 'claim', 'deliveredTurnIdHash'].includes(key))
      || !integer(value.pendingRevision, 1) || !integer(value.deliveredRevision)
      || value.deliveredRevision > value.pendingRevision
      || !integer(value.updatedAt) || !integer(value.expiresAt, 1)
      || value.expiresAt <= value.updatedAt
      || value.expiresAt - value.updatedAt > CONTEXT_RESTORE_RECORD_MS) return null;
    if (Object.hasOwn(value, 'deliveredTurnIdHash') && (
      value.deliveredRevision === 0 || typeof value.deliveredTurnIdHash !== 'string'
      || !HASH.test(value.deliveredTurnIdHash)
    )) return null;
    if (Object.hasOwn(value, 'claim') && (
      !validClaim(value.claim) || value.claim.revision !== value.pendingRevision
      || value.claim.revision <= value.deliveredRevision || value.claim.expiresAt > value.expiresAt
      || value.claim.expiresAt - value.updatedAt > CONTEXT_RESTORE_CLAIM_MS
    )) return null;
    return value as unknown as ContextRestoreState;
  } catch {
    return null;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function contextRestoreKey(scope: ContextRestoreScope): string {
  const parts = [scope.canonicalDataDir, scope.agentId, scope.generation, scope.sessionId];
  if (!parts.every(nonempty)) throw new TypeError('context restore scope requires complete identifiers');
  // Never strip characters or truncate identifiers: the complete tuple is the scope.
  return CONTEXT_RESTORE_PREFIX + digest(parts);
}

/**
 * Metadata-only control state. The caller owns DB lifetime, bridge checks and
 * output. Every transaction ends before this synchronous API returns; no claim
 * is an output ACK, and a crash after stdout but before markEmitted can resend.
 */
export function createContextRestoreStore(
  db: Database.Database,
  options: { now?: () => number; randomClaimId?: () => string } = {},
) {
  const clock = options.now ?? Date.now;
  const claimId = options.randomClaimId ?? randomUUID;
  const now = (): number => {
    const at = clock();
    if (!integer(at) || !Number.isSafeInteger(at + CONTEXT_RESTORE_RECORD_MS)) {
      throw new RangeError('invalid context restore time');
    }
    return at;
  };
  const read = (key: string, at: number): StoredRecord => {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
    const parsed = row ? decode(row.value) : null;
    return { raw: row?.value ?? null, state: parsed && parsed.expiresAt > at ? parsed : null };
  };
  const write = (key: string, previous: string | null, state: ContextRestoreState): boolean => {
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw, 'utf8') > CONTEXT_RESTORE_MAX_BYTES || !decode(raw)) {
      throw new RangeError('invalid or oversized context restore state');
    }
    return previous === null
      ? db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, raw).changes === 1
      : db.prepare('UPDATE metadata SET value = ? WHERE key = ? AND value = ?').run(raw, key, previous).changes === 1;
  };
  const refresh = (state: ContextRestoreState, at: number): ContextRestoreState => ({
    ...state, updatedAt: at, expiresAt: at + CONTEXT_RESTORE_RECORD_MS,
  });
  const ownsClaim = (state: ContextRestoreState | null, claim: ContextRestoreClaim): state is ContextRestoreState => (
    validClaim(claim) && state?.claim?.claimId === claim.claimId
    && state.claim.revision === claim.revision && state.claim.turnIdHash === claim.turnIdHash
    && state.claim.expiresAt === claim.expiresAt
  );
  const mayEmit = (state: ContextRestoreState | null, claim: ContextRestoreClaim, at: number): state is ContextRestoreState => (
    ownsClaim(state, claim) && claim.expiresAt > at
    && state.pendingRevision === claim.revision && state.deliveredRevision < claim.revision
  );
  const cleanupExpired = (at: number): void => {
    // Exact prefix comparison (LIKE would interpret its underscores as wildcards).
    // Invalid JSON has no trustworthy expiry; do not delete it or other metadata.
    db.prepare(`DELETE FROM metadata WHERE key IN (
      SELECT key FROM metadata
      WHERE substr(key, 1, ?) = ? AND length(CAST(value AS BLOB)) <= ?
        AND CASE WHEN json_valid(value)
          THEN json_type(value, '$.expiresAt') = 'integer' AND json_extract(value, '$.expiresAt') <= ?
          ELSE 0 END
      ORDER BY key LIMIT ?
    )`).run(CONTEXT_RESTORE_PREFIX.length, CONTEXT_RESTORE_PREFIX, CONTEXT_RESTORE_MAX_BYTES,
      at, CONTEXT_RESTORE_CLEANUP_LIMIT);
  };

  return {
    /** Exact-scope export view; validated and expiry-filtered, never a metadata scan. */
    readState(scope: ContextRestoreScope): ContextRestoreState | null {
      return read(contextRestoreKey(scope), now()).state;
    },

    readPending(scope: ContextRestoreScope): ContextRestoreState | null {
      const state = read(contextRestoreKey(scope), now()).state;
      return state && state.pendingRevision > state.deliveredRevision ? state : null;
    },

    markPending(scope: ContextRestoreScope): number {
      const key = contextRestoreKey(scope);
      return db.transaction(() => {
        const at = now();
        cleanupExpired(at);
        const previous = read(key, at);
        const revision = (previous.state?.pendingRevision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new RangeError('context restore revision exhausted');
        const next = refresh({
          pendingRevision: revision, deliveredRevision: previous.state?.deliveredRevision ?? 0,
          ...(previous.state?.deliveredTurnIdHash ? { deliveredTurnIdHash: previous.state.deliveredTurnIdHash } : {}),
          updatedAt: at, expiresAt: at + CONTEXT_RESTORE_RECORD_MS,
        }, at);
        if (!write(key, previous.raw, next)) throw new Error('context restore mark changed concurrently');
        return revision;
      }).immediate();
    },

    claimPending(scope: ContextRestoreScope, turnId: string): ContextRestoreClaim | null {
      if (!nonempty(turnId)) throw new TypeError('context restore turn identifier is required');
      const key = contextRestoreKey(scope);
      return db.transaction(() => {
        const at = now();
        const previous = read(key, at);
        const state = previous.state;
        if (!state || state.pendingRevision <= state.deliveredRevision || (state.claim && state.claim.expiresAt > at)) return null;
        const claim: ContextRestoreClaim = {
          revision: state.pendingRevision, claimId: claimId(), turnIdHash: digest(turnId),
          expiresAt: at + CONTEXT_RESTORE_CLAIM_MS,
        };
        if (!validClaim(claim)) throw new TypeError('invalid context restore claim identifier');
        return write(key, previous.raw, refresh({ ...state, claim }, at)) ? claim : null;
      }).immediate();
    },

    canEmit(scope: ContextRestoreScope, claim: ContextRestoreClaim): boolean {
      const at = now();
      return mayEmit(read(contextRestoreKey(scope), at).state, claim, at);
    },

    markEmitted(scope: ContextRestoreScope, claim: ContextRestoreClaim): boolean {
      const key = contextRestoreKey(scope);
      return db.transaction(() => {
        const at = now();
        const previous = read(key, at);
        if (!mayEmit(previous.state, claim, at)) return false;
        const next = refresh({ ...previous.state, deliveredRevision: claim.revision, deliveredTurnIdHash: claim.turnIdHash }, at);
        delete next.claim;
        return write(key, previous.raw, next);
      }).immediate();
    },

    releaseClaim(scope: ContextRestoreScope, claim: ContextRestoreClaim): boolean {
      const key = contextRestoreKey(scope);
      return db.transaction(() => {
        const at = now();
        const previous = read(key, at);
        if (!ownsClaim(previous.state, claim)) return false;
        const next = refresh(previous.state, at);
        delete next.claim;
        return write(key, previous.raw, next);
      }).immediate();
    },

    satisfyFromSessionStart(scope: ContextRestoreScope, observedRevision: number): boolean {
      if (!integer(observedRevision, 1)) return false;
      const key = contextRestoreKey(scope);
      return db.transaction(() => {
        const at = now();
        const previous = read(key, at);
        const state = previous.state;
        if (!state || observedRevision > state.pendingRevision || state.deliveredRevision >= observedRevision) return false;
        const next = refresh({ ...state, deliveredRevision: observedRevision }, at);
        delete next.deliveredTurnIdHash;
        if (next.claim?.revision === observedRevision) delete next.claim;
        return write(key, previous.raw, next);
      }).immediate();
    },
  };
}
