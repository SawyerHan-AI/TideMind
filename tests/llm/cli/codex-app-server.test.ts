import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_METADATA_LIMITS,
  parseCodexAccount,
  parseCodexModelPage,
  readCodexMetadata,
} from '../../../src/llm/cli/codex-app-server.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import type { ResolvedCli } from '../../../src/llm/cli/types.js';

const fakeServer = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-codex-app-server.mjs', import.meta.url)),
);

function rawModel(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName: id.toUpperCase(),
    description: 'fixture model',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
    ...extra,
  };
}

const CHATGPT_ACCOUNT = {
  account: { type: 'chatgpt', email: 'Fixture@DataPilot.example', planType: 'pro' },
  requiresOpenaiAuth: true,
  workspaceRouting: { chatgptAccountId: 'acct-datapilot-1' },
};

describe('parseCodexAccount', () => {
  it('extracts non-secret ChatGPT account metadata', () => {
    expect(parseCodexAccount(CHATGPT_ACCOUNT)).toEqual({
      kind: 'chatgpt',
      accountId: 'acct-datapilot-1',
      email: 'fixture@datapilot.example',
      planType: 'pro',
    });
    expect(parseCodexAccount({
      account: { type: 'chatgpt', email: 'a@b.example' },
      requiresOpenaiAuth: true,
    })).toEqual({ kind: 'chatgpt', accountId: null, email: 'a@b.example', planType: null });
  });

  it('classifies logged-out, api key and other providers', () => {
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true }))
      .toEqual({ kind: 'none', requiresOpenaiAuth: true });
    expect(parseCodexAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: false }))
      .toEqual({ kind: 'api_key' });
    expect(parseCodexAccount({ account: { type: 'amazonBedrock' } }))
      .toEqual({ kind: 'other', type: 'amazonBedrock' });
    expect(parseCodexAccount({ account: {} })).toEqual({ kind: 'other', type: 'unknown' });
  });

  it('strips control characters and bounds untrusted strings; rejects non-object results', () => {
    const parsed = parseCodexAccount({
      account: { type: 'chatgpt', email: 'x\u0000y@z.example', planType: 'p'.repeat(200) },
      workspaceRouting: { chatgptAccountId: `acct\n${'9'.repeat(400)}` },
    });
    expect(parsed).toMatchObject({ kind: 'chatgpt', email: 'x y@z.example' });
    if (parsed.kind !== 'chatgpt') throw new Error('unreachable');
    expect(parsed.planType).toHaveLength(64);
    expect(parsed.accountId).toHaveLength(256);
    expect(parsed.accountId).not.toContain('\n');
    for (const bad of [null, 'string', [], 42]) {
      expect(() => parseCodexAccount(bad)).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    }
  });
});

describe('parseCodexModelPage', () => {
  it('maps a valid page (id as key, model as invocation id, efforts filtered)', () => {
    const page = parseCodexModelPage({
      data: [
        rawModel('gpt-5.3-codex', { isDefault: true, upgradeInfo: { retirementAt: 1_900_000_000 } }),
        rawModel('gpt-5.2', {
          model: 'gpt-5.2-2026-01-01',
          hidden: true,
          upgrade: 'gpt-5.3-codex',
          supportedReasoningEfforts: ['high', 'BAD VALUE', { reasoningEffort: 'x'.repeat(40) }],
          displayName: '  GPT\u0007 5.2  ',
        }),
      ],
      nextCursor: 'cursor-2',
    });
    expect(page.nextCursor).toBe('cursor-2');
    expect(page.models).toEqual([
      {
        id: 'gpt-5.3-codex',
        invocationId: 'gpt-5.3-codex',
        displayName: 'GPT-5.3-CODEX',
        kind: 'model',
        isDefault: true,
        hidden: false,
        upgrade: null,
        retirementAt: 1_900_000_000,
        reasoningEfforts: ['low', 'medium'],
      },
      {
        id: 'gpt-5.2',
        invocationId: 'gpt-5.2-2026-01-01',
        displayName: 'GPT  5.2',
        kind: 'model',
        isDefault: false,
        hidden: true,
        upgrade: 'gpt-5.3-codex',
        retirementAt: null,
        reasoningEfforts: ['high'],
      },
    ]);
    expect(parseCodexModelPage({ data: [], nextCursor: '' }).nextCursor).toBeNull();
    expect(parseCodexModelPage({ data: [] }).nextCursor).toBeNull();
  });

  it.each([
    ['-m', 'argv-like id'],
    ['gpt 5', 'space'],
    ['gpt-5;rm -rf /', 'shell metacharacter'],
    ['', 'empty'],
    ['x'.repeat(129), 'too long'],
    ['gpt-5\n', 'newline'],
  ])('rejects unsafe model identifier %j (%s)', (id) => {
    expect(() => parseCodexModelPage({ data: [rawModel('ok', { id })] }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseCodexModelPage({ data: [rawModel('ok', { model: id })] }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });

  it('drops an unsafe upgrade hint instead of trusting it', () => {
    const page = parseCodexModelPage({ data: [rawModel('gpt-5', { upgrade: '--dangerous flag' })] });
    expect(page.models[0].upgrade).toBeNull();
  });

  it('rejects items missing required flags, invalid pages and oversized/non-string cursors', () => {
    for (const missing of ['isDefault', 'hidden']) {
      const item = rawModel('gpt-5');
      delete item[missing];
      expect(() => parseCodexModelPage({ data: [item] }), missing)
        .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    }
    expect(() => parseCodexModelPage({ data: [rawModel('gpt-5', { isDefault: 'true' })] }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseCodexModelPage({ data: [null] })).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseCodexModelPage({ models: [] })).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseCodexModelPage(null)).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => parseCodexModelPage({ data: [], nextCursor: 'c'.repeat(4097) }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(parseCodexModelPage({ data: [], nextCursor: 'c'.repeat(4096) }).nextCursor).toHaveLength(4096);
    expect(() => parseCodexModelPage({ data: [], nextCursor: 7 }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });
});

// ---------------------------------------------------------------------------
// End-to-end metadata session against a fake app-server executable.
// ---------------------------------------------------------------------------

type FakeConfig = Record<string, unknown>;
// CODEX_METADATA_LIMITS is frozen with literal types, so Partial<typeof …> only accepts the
// default values; widen explicitly for the test seam (reported as a LOW typing issue).
const limits = (value: Partial<Record<keyof typeof CODEX_METADATA_LIMITS, number>>) =>
  value as unknown as NonNullable<Parameters<typeof readCodexMetadata>[0]['limits']>;
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fakeCodex(config: FakeConfig): Promise<{
  dataDir: string;
  resolved: ResolvedCli;
  log: () => Array<Record<string, unknown>>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tidemind-codex-app-server-'));
  cleanup.push(dataDir);
  const executable = join(dataDir, 'codex');
  copyFileSync(fakeServer, executable);
  chmodSync(executable, 0o700);
  const path = realpathSync(executable);
  writeFileSync(`${path}.json`, JSON.stringify(config));
  return {
    dataDir,
    resolved: {
      kind: 'codex',
      path,
      version: '0.156.1',
      controlledPath: `${dirname(process.execPath)}:${dataDir}:/usr/bin:/bin`,
      source: 'known_path',
      identity: await captureCliIdentity(path),
    },
    log: () => (existsSync(`${path}.log`)
      ? readFileSync(`${path}.log`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : []),
  };
}

function receivedRequests(entries: Array<Record<string, unknown>>) {
  return entries
    .map((entry) => entry.received as Record<string, unknown> | undefined)
    .filter((message): message is Record<string, unknown> => !!message && typeof message.method === 'string');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pids: number[], timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.every((pid) => !isAlive(pid));
}

describe('readCodexMetadata against a fake app-server', () => {
  it('paginates completely, reads the account before/after, and only uses the three allowed methods', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      serverRequest: true,
      pages: [
        { cursor: null, data: [rawModel('gpt-5.3-codex', { isDefault: true }), rawModel('gpt-5.2')], nextCursor: 'p2' },
        { cursor: 'p2', data: [rawModel('gpt-5-mini')], nextCursor: 'p3' },
        { cursor: 'p3', data: [rawModel('gpt-6-datapilot-preview')], nextCursor: null },
      ],
    });
    const result = await readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      sourceEnv: { HOME: fake.dataDir, OPENAI_API_KEY: 'must-not-leak' },
    });
    expect(result.account).toEqual({
      kind: 'chatgpt',
      accountId: 'acct-datapilot-1',
      email: 'fixture@datapilot.example',
      planType: 'pro',
    });
    expect(result.accountAfter).toEqual(result.account);
    expect(result.models?.map((m) => m.id)).toEqual([
      'gpt-5.3-codex', 'gpt-5.2', 'gpt-5-mini', 'gpt-6-datapilot-preview',
    ]);

    const entries = fake.log();
    const startup = entries[0] as { argv: string[]; cwd: string; envKeys: string[] };
    expect(startup.argv.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(startup.argv).toEqual(expect.arrayContaining([
      '-c', 'mcp_servers={}', '-c', 'hooks={}', '-c', 'notify=[]', '-c', 'plugins={}',
      '-c', 'apps={}', '-c', 'marketplaces={}', '-c', 'web_search="disabled"',
    ]));
    expect(startup.cwd).toContain(join('runtime', 'llm-cli', 'inv_meta_'));
    expect(startup.envKeys).not.toContain('OPENAI_API_KEY');

    const requests = receivedRequests(entries);
    expect(new Set(requests.map((r) => r.method))).toEqual(
      new Set(['initialize', 'initialized', 'account/read', 'model/list']),
    );
    const accountReads = requests.filter((r) => r.method === 'account/read');
    expect(accountReads).toHaveLength(2);
    for (const read of accountReads) expect(read.params).toEqual({ refreshToken: false });
    expect(requests.filter((r) => r.method === 'model/list').map((r) => r.params)).toEqual([
      { cursor: null, limit: CODEX_METADATA_LIMITS.pageSize, includeHidden: false },
      { cursor: 'p2', limit: CODEX_METADATA_LIMITS.pageSize, includeHidden: false },
      { cursor: 'p3', limit: CODEX_METADATA_LIMITS.pageSize, includeHidden: false },
    ]);
    // `initialized` is a notification (no id); nothing else is ever sent.
    expect(requests.find((r) => r.method === 'initialized')?.id).toBeUndefined();
    // A server-initiated request is refused, never granted.
    const refusal = entries
      .map((entry) => entry.received as Record<string, unknown> | undefined)
      .find((message) => message?.id === 'srv-1');
    expect(refusal).toMatchObject({ error: { code: -32601 } });
    // The private runtime directory is removed afterwards.
    expect(readdirSync(join(fake.dataDir, 'runtime', 'llm-cli')).filter((n) => n.startsWith('inv_meta_')))
      .toEqual([]);
  }, 30_000);

  it('account-only sessions never call model/list', async () => {
    const fake = await fakeCodex({ account: CHATGPT_ACCOUNT, pages: [] });
    const result = await readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: false });
    expect(result).toEqual({ account: expect.objectContaining({ kind: 'chatgpt' }), accountAfter: null, models: null });
    expect(receivedRequests(fake.log()).map((r) => r.method)).toEqual(['initialize', 'initialized', 'account/read']);
  }, 30_000);

  it('rejects a cursor loop', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      loopPages: true,
      pages: [
        { data: [rawModel('a')], nextCursor: 'same' },
        { data: [rawModel('b')], nextCursor: 'same' },
      ],
    });
    await expect(readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('cursor loop') });
  }, 30_000);

  it('rejects a duplicate model across pages', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      pages: [
        { cursor: null, data: [rawModel('gpt-5')], nextCursor: 'p2' },
        { cursor: 'p2', data: [rawModel('gpt-5')], nextCursor: null },
      ],
    });
    await expect(readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('duplicate') });
  }, 30_000);

  it('rejects when the page limit is exceeded', async () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({
      cursor: index === 0 ? null : `p${index}`,
      data: [rawModel(`m-${index}`)],
      nextCursor: `p${index + 1}`,
    }));
    const fake = await fakeCodex({ account: CHATGPT_ACCOUNT, pages });
    await expect(readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      limits: limits({ maxPages: 3 }),
    })).rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('page limit') });
    expect(receivedRequests(fake.log()).filter((r) => r.method === 'model/list')).toHaveLength(3);
  }, 30_000);

  it('rejects when the item limit is exceeded', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      pages: [{ cursor: null, data: [rawModel('a'), rawModel('b'), rawModel('c')], nextCursor: null }],
    });
    await expect(readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      limits: limits({ maxModels: 2 }),
    })).rejects.toMatchObject({ kind: 'output_limit' });
  }, 30_000);

  it('rejects an invalid item anywhere in the pagination (no partial catalog)', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      pages: [
        { cursor: null, data: [rawModel('gpt-5')], nextCursor: 'p2' },
        { cursor: 'p2', data: [rawModel('bad id with spaces')], nextCursor: null },
      ],
    });
    await expect(readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol' });
  }, 30_000);

  it('model/list method-not-found (-32601) on the first page → models = null (older CLI)', async () => {
    const fake = await fakeCodex({ account: CHATGPT_ACCOUNT, methodNotFound: ['model/list'] });
    const result = await readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: true });
    expect(result.models).toBeNull();
    expect(result.account).toMatchObject({ kind: 'chatgpt' });
  }, 30_000);

  it('model/list disappearing mid-pagination is a protocol failure, not "unsupported"', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      modelListNotFoundAfterFirst: true,
      pages: [{ cursor: null, data: [rawModel('gpt-5')], nextCursor: 'p2' }],
    });
    await expect(readCodexMetadata({ resolved: fake.resolved, dataDir: fake.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('mid-pagination') });
  }, 30_000);

  it('account/read method-not-found → account null; initialize method-not-found → unsupported_version', async () => {
    const noAccount = await fakeCodex({
      methodNotFound: ['account/read'],
      pages: [{ cursor: null, data: [rawModel('gpt-5')], nextCursor: null }],
    });
    const result = await readCodexMetadata({ resolved: noAccount.resolved, dataDir: noAccount.dataDir, includeModels: true });
    expect(result).toMatchObject({ account: null, accountAfter: null, models: [expect.objectContaining({ id: 'gpt-5' })] });

    const noInit = await fakeCodex({ methodNotFound: ['initialize'] });
    await expect(readCodexMetadata({ resolved: noInit.resolved, dataDir: noInit.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'unsupported_version' });
  }, 30_000);

  it('a JSON-RPC error on model/list or malformed output fails the whole read', async () => {
    const errored = await fakeCodex({ account: CHATGPT_ACCOUNT, modelListError: 'upstream 500' });
    await expect(readCodexMetadata({ resolved: errored.resolved, dataDir: errored.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('upstream 500') });

    const malformed = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      rawModelLine: '{not json',
      pages: [{ cursor: null, data: [], nextCursor: null }],
    });
    await expect(readCodexMetadata({ resolved: malformed.resolved, dataDir: malformed.dataDir, includeModels: true }))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('malformed') });
  }, 30_000);

  it('enforces the total output byte limit', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      pages: [{
        cursor: null,
        data: Array.from({ length: 50 }, (_, i) => rawModel(`m-${i}`, { description: 'd'.repeat(2_000) })),
        nextCursor: null,
      }],
    });
    await expect(readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      limits: limits({ maxTotalBytes: 8 * 1024 }),
    })).rejects.toMatchObject({ kind: 'output_limit' });
  }, 30_000);

  it('times out within the budget and terminates the whole process group (including a SIGTERM-ignoring grandchild)', async () => {
    const fake = await fakeCodex({
      account: CHATGPT_ACCOUNT,
      hang: ['model/list'],
      grandchild: true,
      ignoreSigterm: true,
      stayAliveAfterStdinEnd: true,
      pages: [],
    });
    const started = Date.now();
    await expect(readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      // Generous under release-machine peak load (CLAUDE.md rule 10): the fake must
      // have time to spawn its grandchild before the budget expires.
      limits: limits({ budgetMs: 3_000 }),
    })).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(20_000);
    const spawnEntry = fake.log().find((entry) => typeof entry.grandchildPid === 'number') as {
      grandchildPid: number;
      pid: number;
    };
    expect(spawnEntry).toBeDefined();
    expect(await waitUntilDead([spawnEntry.pid, spawnEntry.grandchildPid])).toBe(true);
  }, 30_000);

  it('an aborted signal cancels the session', async () => {
    const fake = await fakeCodex({ account: CHATGPT_ACCOUNT, hang: ['model/list'], pages: [] });
    const controller = new AbortController();
    const pending = readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(readCodexMetadata({
      resolved: fake.resolved,
      dataDir: fake.dataDir,
      includeModels: true,
      signal: preAborted.signal,
    })).rejects.toMatchObject({ kind: 'aborted' });
  }, 30_000);

  it('refuses to run a non-codex resolved CLI', async () => {
    const fake = await fakeCodex({ account: CHATGPT_ACCOUNT });
    await expect(readCodexMetadata({
      resolved: { ...fake.resolved, kind: 'claude' },
      dataDir: fake.dataDir,
      includeModels: false,
    })).rejects.toThrow(/codex CLI/);
  });
});
