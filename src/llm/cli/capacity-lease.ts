import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CliLLMError } from './errors.js';

const DEFAULT_LEASE_MS = 30_000;

export interface CliCapacityLease {
  accountScope: string;
  ownerId: string;
  ownerPid: number;
  fencingToken: number;
  connectionId: string;
  invocationId: string;
  expiresAt: number;
}

type LeaseRow = {
  owner_id: string;
  owner_pid: number;
  fencing_token: number;
  lease_expires_at: number;
  connection_id: string;
  invocation_id: string;
  invocation_outcome: string | null;
};

function capacityError(message: string, cause?: unknown): CliLLMError {
  return new CliLLMError('capacity', message, {
    retryable: true,
    cause,
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a provider/account-scoped lease with a monotonically increasing
 * fencing token. Any SQLite uncertainty fails closed.
 */
export function acquireCliCapacityLease(
  db: Database.Database,
  params: {
    accountScope: string;
    connectionId: string;
    invocationId: string;
    ownerId?: string;
    ownerPid?: number;
    leaseMs?: number;
    nowMs?: number;
  },
): CliCapacityLease {
  const nowMs = params.nowMs ?? Date.now();
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  const ownerId = params.ownerId ?? `${process.pid}:${randomUUID()}`;
  const ownerPid = params.ownerPid ?? process.pid;
  try {
    return db.transaction(() => {
      const current = db.prepare(`
        SELECT l.*, i.outcome AS invocation_outcome
        FROM cli_capacity_leases l
        LEFT JOIN cli_invocations i ON i.id = l.invocation_id
        WHERE l.account_scope = ?
      `).get(params.accountScope) as LeaseRow | undefined;
      if (current && current.lease_expires_at > nowMs) {
        throw capacityError('本机订阅账号正在执行另一个调用，请稍后重试');
      }
      // TTL alone cannot fence a stopped/stalled process: it may resume after
      // takeover and write the already committed prompt. A live local owner is
      // therefore never taken over; crash recovery requires the PID to be gone.
      if (
        current
        && current.invocation_outcome === 'running'
        && isProcessAlive(current.owner_pid)
      ) {
        throw capacityError('本机订阅账号的上一个调用进程仍在运行，已停止接管');
      }
      const fencingToken = (current?.fencing_token ?? 0) + 1;
      const expiresAt = nowMs + leaseMs;
      const result = db.prepare(`
        INSERT INTO cli_capacity_leases (
          account_scope, owner_id, owner_pid, fencing_token,
          lease_expires_at, heartbeat_at, connection_id, invocation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_scope) DO UPDATE SET
          owner_id = excluded.owner_id,
          owner_pid = excluded.owner_pid,
          fencing_token = excluded.fencing_token,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at,
          connection_id = excluded.connection_id,
          invocation_id = excluded.invocation_id
        WHERE cli_capacity_leases.lease_expires_at <= ?
      `).run(
        params.accountScope,
        ownerId,
        ownerPid,
        fencingToken,
        expiresAt,
        nowMs,
        params.connectionId,
        params.invocationId,
        nowMs,
      );
      if (result.changes !== 1) {
        throw capacityError('无法确认本机订阅账号调用租约，已停止调用');
      }
      return {
        accountScope: params.accountScope,
        ownerId,
        ownerPid,
        fencingToken,
        connectionId: params.connectionId,
        invocationId: params.invocationId,
        expiresAt,
      };
    }).immediate();
  } catch (error) {
    if (error instanceof CliLLMError) throw error;
    throw capacityError('无法安全获取本机订阅账号调用租约', error);
  }
}

export function renewCliCapacityLease(
  db: Database.Database,
  lease: CliCapacityLease,
  leaseMs = DEFAULT_LEASE_MS,
  nowMs = Date.now(),
): CliCapacityLease {
  try {
    const expiresAt = nowMs + leaseMs;
    const result = db.prepare(`
      UPDATE cli_capacity_leases
      SET lease_expires_at = ?, heartbeat_at = ?
      WHERE account_scope = ?
        AND owner_id = ?
        AND owner_pid = ?
        AND fencing_token = ?
        AND invocation_id = ?
        AND lease_expires_at > ?
    `).run(
      expiresAt,
      nowMs,
      lease.accountScope,
      lease.ownerId,
      lease.ownerPid,
      lease.fencingToken,
      lease.invocationId,
      nowMs,
    );
    if (result.changes !== 1) {
      throw capacityError('本机订阅账号调用租约已失效');
    }
    return { ...lease, expiresAt };
  } catch (error) {
    if (error instanceof CliLLMError) throw error;
    throw capacityError('无法安全续租本机订阅账号调用', error);
  }
}

export function assertCliCapacityFence(
  db: Database.Database,
  lease: CliCapacityLease,
  nowMs = Date.now(),
): void {
  try {
    const row = db.prepare(`
      SELECT owner_id, owner_pid, fencing_token, invocation_id, lease_expires_at
      FROM cli_capacity_leases
      WHERE account_scope = ?
    `).get(lease.accountScope) as {
      owner_id: string;
      owner_pid: number;
      fencing_token: number;
      invocation_id: string;
      lease_expires_at: number;
    } | undefined;
    if (
      !row
      || row.owner_id !== lease.ownerId
      || row.owner_pid !== lease.ownerPid
      || row.fencing_token !== lease.fencingToken
      || row.invocation_id !== lease.invocationId
      || row.lease_expires_at <= nowMs
    ) {
      throw capacityError('本机订阅账号调用租约 fencing 校验失败');
    }
  } catch (error) {
    if (error instanceof CliLLMError) throw error;
    throw capacityError('无法确认本机订阅账号调用租约状态', error);
  }
}

export function releaseCliCapacityLease(
  db: Database.Database,
  lease: CliCapacityLease,
): boolean {
  try {
    const result = db.prepare(`
      DELETE FROM cli_capacity_leases
      WHERE account_scope = ?
        AND owner_id = ?
        AND owner_pid = ?
        AND fencing_token = ?
        AND invocation_id = ?
    `).run(
      lease.accountScope,
      lease.ownerId,
      lease.ownerPid,
      lease.fencingToken,
      lease.invocationId,
    );
    return result.changes === 1;
  } catch (error) {
    throw capacityError('无法安全释放本机订阅账号调用租约', error);
  }
}

export async function withCliCapacityLease<T>(
  db: Database.Database,
  params: {
    accountScope: string;
    connectionId: string;
    invocationId: string;
    signal?: AbortSignal;
    leaseMs?: number;
  },
  run: (lease: CliCapacityLease, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  let lease = acquireCliCapacityLease(db, { ...params, leaseMs });
  const leaseAbort = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, leaseAbort.signal])
    : leaseAbort.signal;
  const heartbeat = setInterval(() => {
    try {
      lease = renewCliCapacityLease(db, lease, leaseMs);
    } catch (error) {
      leaseAbort.abort(error);
    }
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  try {
    return await run(lease, signal);
  } finally {
    clearInterval(heartbeat);
    // A stale owner must never delete a successor's lease. CAS delete returning
    // false is expected after fencing loss. Cleanup uncertainty must not
    // overwrite a provider result or an adapter error: the fenced row expires
    // on its own and blocks new calls until then.
    try {
      releaseCliCapacityLease(db, lease);
    } catch {
      // Deliberately retained until TTL/reconciliation.
    }
  }
}
