import type Database from 'better-sqlite3';
import {
  getAuthBinding,
  getCatalogSnapshot,
  recordCatalogRefreshFailure,
  reconcileAuthBinding,
  saveCatalogSnapshot,
  type CatalogSnapshot,
} from '../../db/model-discovery.js';
import { codexIdentityFromAccount } from './auth-probe.js';
import { claudeAliasCatalog } from './catalogs.js';
import { readCodexMetadata } from './codex-app-server.js';
import { CliLLMError } from './errors.js';
import type { CliEnvironmentCheck } from './readiness.js';

/**
 * Model catalog refresh (design §5, §6). Metadata only: never sends a generation
 * prompt and never tries models one by one.
 *
 * - Codex: the selected CLI's app-server model/list, fully paginated. The account is
 *   read before and after listing; the snapshot is committed only if both reads match
 *   the scope/epoch bound at the start (late responses from another account are dropped).
 * - Claude Code: official family aliases as suggestions (SDK route gated by B5).
 */

export const CATALOG_FRESHNESS = Object.freeze({
  /** Settings open: show cache, refresh asynchronously if older than this. */
  staleAfterMs: 15 * 60_000,
  /** Background freshness for in-use connections. */
  backgroundEveryMs: 6 * 60 * 60_000,
  /** Beyond this the UI marks the catalog as notably out of date. */
  warnAfterMs: 24 * 60 * 60_000,
});

export interface CatalogRefreshResult {
  status: 'refreshed' | 'unsupported' | 'failed' | 'discarded';
  snapshot: CatalogSnapshot | null;
  errorKind?: string;
}

export async function refreshCliModelCatalog(
  db: Database.Database,
  params: {
    connectionId: string;
    dataDir: string;
    environment: CliEnvironmentCheck;
    signal?: AbortSignal;
    readMetadata?: typeof readCodexMetadata;
  },
): Promise<CatalogRefreshResult> {
  const { environment } = params;
  const { binding } = reconcileAuthBinding(db, {
    connectionId: params.connectionId,
    auth: environment.auth,
    cliGeneration: environment.cliGeneration,
    authStoreSignal: environment.authStoreSignal,
  });

  if (environment.providerType === 'claude-cli') {
    const saved = saveCatalogSnapshot(db, {
      connectionId: params.connectionId,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: environment.cliGeneration,
      source: 'claude_aliases',
      items: claudeAliasCatalog(),
    });
    return {
      status: saved ? 'refreshed' : 'discarded',
      snapshot: getCatalogSnapshot(db, params.connectionId),
    };
  }

  try {
    const metadata = await (params.readMetadata ?? readCodexMetadata)({
      resolved: environment.resolved,
      dataDir: params.dataDir,
      includeModels: true,
      signal: params.signal,
    });
    if (metadata.models === null) {
      // "method not found" on a CLI generation that previously listed models is an
      // anomaly, not proof the catalog is gone: never replace a complete snapshot of
      // the same generation with an empty one (design §5.2).
      const previous = getCatalogSnapshot(db, params.connectionId);
      if (
        previous
        && previous.source === 'codex_app_server'
        && previous.cliGeneration === environment.cliGeneration
      ) {
        recordCatalogRefreshFailure(db, params.connectionId, 'protocol', 'model/list unexpectedly unavailable');
        return { status: 'failed', snapshot: getCatalogSnapshot(db, params.connectionId), errorKind: 'protocol' };
      }
      const saved = saveCatalogSnapshot(db, {
        connectionId: params.connectionId,
        scopeKey: binding.scopeKey,
        authEpoch: binding.authEpoch,
        cliGeneration: environment.cliGeneration,
        source: 'unsupported',
        items: [],
      });
      return {
        status: saved ? 'unsupported' : 'discarded',
        snapshot: getCatalogSnapshot(db, params.connectionId),
      };
    }
    // The catalog must belong to the bound account both before and after listing.
    for (const account of [metadata.account, metadata.accountAfter]) {
      if (!account) continue;
      const observed = codexIdentityFromAccount(account);
      if (observed.scopeKey !== binding.scopeKey) {
        throw new CliLLMError('not_authenticated', 'Codex account changed during model refresh', {
          needsUserAction: false,
        });
      }
    }
    const current = getAuthBinding(db, params.connectionId);
    if (!current || current.authEpoch !== binding.authEpoch || current.scopeKey !== binding.scopeKey) {
      return { status: 'discarded', snapshot: getCatalogSnapshot(db, params.connectionId) };
    }
    const saved = saveCatalogSnapshot(db, {
      connectionId: params.connectionId,
      scopeKey: binding.scopeKey,
      authEpoch: binding.authEpoch,
      cliGeneration: environment.cliGeneration,
      source: 'codex_app_server',
      items: metadata.models,
    });
    return {
      status: saved ? 'refreshed' : 'discarded',
      snapshot: getCatalogSnapshot(db, params.connectionId),
    };
  } catch (error) {
    const kind = error instanceof CliLLMError ? error.kind : 'transient';
    const message = error instanceof Error ? error.message : String(error);
    // A failed refresh never produces a "successful empty catalog" and never replaces
    // the last complete snapshot; it is recorded as an attempt only.
    recordCatalogRefreshFailure(db, params.connectionId, kind, message);
    return { status: 'failed', snapshot: getCatalogSnapshot(db, params.connectionId), errorKind: kind };
  }
}
