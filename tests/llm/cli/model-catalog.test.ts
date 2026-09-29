import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { ensureSchema } from '../../../src/db/schema.js';
import {
  getAuthBinding,
  getCatalogSnapshot,
  reconcileAuthBinding,
} from '../../../src/db/model-discovery.js';
import { refreshCliModelCatalog } from '../../../src/llm/cli/model-catalog.js';
import { codexIdentityFromAccount } from '../../../src/llm/cli/auth-probe.js';
import { CLAUDE_FAMILY_ALIASES } from '../../../src/llm/cli/catalogs.js';
import { CliLLMError } from '../../../src/llm/cli/errors.js';
import type {
  CodexAccountSnapshot,
  CodexMetadataResult,
  readCodexMetadata,
} from '../../../src/llm/cli/codex-app-server.js';
import type { CliEnvironmentCheck } from '../../../src/llm/cli/readiness.js';
import type { CliAuthIdentity, CliCatalogModel, CliProviderType } from '../../../src/llm/cli/types.js';

const CONNECTION = 'mc_ca7a1001';

const ACCOUNT_A: CodexAccountSnapshot = {
  kind: 'chatgpt', accountId: 'acct-xinghai', email: 'fixture@xinghai.example', planType: 'pro',
};
const ACCOUNT_B: CodexAccountSnapshot = {
  kind: 'chatgpt', accountId: 'acct-datapilot', email: 'fixture@datapilot.example', planType: 'plus',
};

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function model(id: string, isDefault = false): CliCatalogModel {
  return {
    id,
    invocationId: id,
    displayName: id,
    kind: 'model',
    isDefault,
    hidden: false,
    upgrade: null,
    retirementAt: null,
    reasoningEfforts: [],
  };
}

function environment(providerType: CliProviderType, auth: CliAuthIdentity, generation = 'gen-1'): CliEnvironmentCheck {
  return {
    providerType,
    status: 'untested',
    resolved: {
      kind: providerType === 'codex-cli' ? 'codex' : 'claude',
      path: `/opt/fixture/bin/${providerType === 'codex-cli' ? 'codex' : 'claude'}`,
      version: providerType === 'codex-cli' ? '0.156.1' : '2.1.280',
      controlledPath: '/usr/bin:/bin',
      source: 'known_path',
      identity: { device: 1, inode: 1, size: 1, ctimeMs: 1, sha256: 'fixture' },
    },
    auth,
    authStoreSignal: null,
    authFingerprint: 'auth-fixture',
    cliGeneration: generation,
    validationFingerprint: generation,
    capabilityFingerprint: 'capability-fixture',
    capabilityStatus: 'verified',
    checkedAt: '2026-09-25T00:00:00.000Z',
  };
}

function claudeAuth(): CliAuthIdentity {
  return {
    providerType: 'claude-cli',
    method: 'claude.ai',
    accountIdentifier: null,
    accountScope: 'claude-cli:org-hash',
    scopeState: 'known',
    scopeKey: 'claude-cli:org-hash',
    scopeLabel: 'max',
  };
}

function metadata(result: Partial<CodexMetadataResult>): typeof readCodexMetadata {
  return vi.fn(async () => ({ account: ACCOUNT_A, accountAfter: ACCOUNT_A, models: [], ...result }));
}

describe('refreshCliModelCatalog', () => {
  it('Claude Code: official family aliases as suggestions (claude_aliases), never a full account catalog', async () => {
    const db = freshDb();
    const readMetadata = vi.fn();
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/unused',
      environment: environment('claude-cli', claudeAuth()),
      readMetadata: readMetadata as never,
    });
    expect(readMetadata).not.toHaveBeenCalled();
    expect(result.status).toBe('refreshed');
    expect(result.snapshot).toMatchObject({ source: 'claude_aliases', defaultModelId: null });
    expect(result.snapshot?.items.map((item) => item.id)).toEqual([...CLAUDE_FAMILY_ALIASES]);
    for (const item of result.snapshot!.items) {
      expect(item).toMatchObject({ kind: 'alias', isDefault: false });
    }
    // The refresh establishes the auth binding for the connection.
    expect(getAuthBinding(db, CONNECTION)).toMatchObject({ scopeKey: 'claude-cli:org-hash', authEpoch: 1 });
  });

  it('Codex: stores the complete paginated catalog bound to the scope/epoch', async () => {
    const db = freshDb();
    const auth = codexIdentityFromAccount(ACCOUNT_A);
    const readMetadata = metadata({ models: [model('gpt-5.3-codex', true), model('gpt-5.2')] });
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', auth),
      readMetadata,
    });
    expect(readMetadata).toHaveBeenCalledWith(expect.objectContaining({ includeModels: true, dataDir: '/tmp/fixture-data' }));
    expect(result.status).toBe('refreshed');
    expect(result.snapshot).toMatchObject({
      source: 'codex_app_server',
      scopeKey: auth.scopeKey,
      authEpoch: 1,
      cliGeneration: 'gen-1',
      defaultModelId: 'gpt-5.3-codex',
    });
  });

  it('Codex: an account change between the before/after reads → failed, previous snapshot kept', async () => {
    const db = freshDb();
    const auth = codexIdentityFromAccount(ACCOUNT_A);
    await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', auth),
      readMetadata: metadata({ models: [model('gpt-5.3-codex', true)] }),
    });
    const before = getCatalogSnapshot(db, CONNECTION)!;

    const switched = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', auth),
      readMetadata: metadata({ accountAfter: ACCOUNT_B, models: [model('other-account-model')] }),
    });
    expect(switched.status).toBe('failed');
    expect(switched.errorKind).toBe('not_authenticated');
    expect(switched.snapshot).toMatchObject({
      revision: before.revision,
      items: before.items,
      lastAttemptErrorKind: 'not_authenticated',
    });

    // Mismatch already on the first read (environment auth vs. metadata session).
    const firstRead = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', auth),
      readMetadata: metadata({ account: ACCOUNT_B, accountAfter: ACCOUNT_B, models: [model('x')] }),
    });
    expect(firstRead.status).toBe('failed');
    expect(getCatalogSnapshot(db, CONNECTION)?.items.map((item) => item.id)).toEqual(['gpt-5.3-codex']);
  });

  it('Codex: models = null (model/list unsupported) → unsupported source, not a successful empty catalog', async () => {
    const db = freshDb();
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', codexIdentityFromAccount(ACCOUNT_A)),
      readMetadata: metadata({ models: null, accountAfter: null }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.snapshot).toMatchObject({ source: 'unsupported', items: [] });
  });

  it.each([
    ['timeout', new CliLLMError('timeout', 'Codex metadata refresh timed out')],
    ['protocol', new CliLLMError('protocol', 'Codex model/list cursor loop detected')],
    ['transient', new Error('socket hang up')],
  ])('Codex: a %s failure on first refresh returns failed without creating a snapshot', async (kind, error) => {
    const db = freshDb();
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', codexIdentityFromAccount(ACCOUNT_A)),
      readMetadata: vi.fn(async () => { throw error; }),
    });
    expect(result).toEqual({ status: 'failed', snapshot: null, errorKind: kind });
    expect(getCatalogSnapshot(db, CONNECTION)).toBeNull();
  });

  it('Codex: a failure after a complete snapshot never replaces it', async () => {
    const db = freshDb();
    const env = environment('codex-cli', codexIdentityFromAccount(ACCOUNT_A));
    await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: env,
      readMetadata: metadata({ models: [model('gpt-5.3-codex', true), model('gpt-5.2')] }),
    });
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: env,
      readMetadata: vi.fn(async () => { throw new CliLLMError('rate_limit', 'HTTP 429'); }),
    });
    expect(result.status).toBe('failed');
    expect(result.snapshot).toMatchObject({
      revision: 1,
      items: [expect.objectContaining({ id: 'gpt-5.3-codex' }), expect.objectContaining({ id: 'gpt-5.2' })],
      lastAttemptErrorKind: 'rate_limit',
    });
  });

  it('Codex: a late response after the epoch moved during the read is discarded', async () => {
    const db = freshDb();
    const auth = codexIdentityFromAccount(ACCOUNT_A);
    const readMetadata: typeof readCodexMetadata = vi.fn(async () => {
      // CLI upgraded while the metadata session was running.
      reconcileAuthBinding(db, { connectionId: CONNECTION, auth, cliGeneration: 'gen-2', authStoreSignal: null });
      return { account: ACCOUNT_A, accountAfter: ACCOUNT_A, models: [model('late-model')] };
    });
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: environment('codex-cli', auth, 'gen-1'),
      readMetadata,
    });
    expect(result.status).toBe('discarded');
    expect(getCatalogSnapshot(db, CONNECTION)).toBeNull();
  });

  it('Codex: model/list unexpectedly unavailable on the same generation never replaces a complete snapshot (design §5.2)', async () => {
    const db = freshDb();
    const env = environment('codex-cli', codexIdentityFromAccount(ACCOUNT_A));
    await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: env,
      readMetadata: metadata({ models: [model('gpt-5.3-codex', true), model('gpt-5.2')] }),
    });
    const result = await refreshCliModelCatalog(db, {
      connectionId: CONNECTION,
      dataDir: '/tmp/fixture-data',
      environment: env,
      readMetadata: metadata({ models: null }),
    });
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('protocol');
    expect(getCatalogSnapshot(db, CONNECTION)).toMatchObject({
      source: 'codex_app_server',
      revision: 1,
      items: [expect.objectContaining({ id: 'gpt-5.3-codex' }), expect.objectContaining({ id: 'gpt-5.2' })],
      lastAttemptErrorKind: 'protocol',
    });
  });
});
