import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository.js';
import {
  AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE,
  AGENT_INTEGRATION_EVENT_MAX_PAYLOAD_BYTES,
  AGENT_INTEGRATION_EVENT_SANITIZER_VERSION,
} from '../../src/db/agent-integration-event-sanitizer.js';
import { ensureAgentIntegrationSchema } from '../../src/db/agent-integration-schema.js';
import { touchAgent } from '../../src/db/agents.js';
import { ensureSchema } from '../../src/db/schema.js';

const CREATED_AT = '2026-08-26T00:00:00.000Z';
const CANARY_TOKEN = 'tm-canary-token-0123456789';
const CANARY_ACCESS_TOKEN = 'tm-canary-access-token-abcdefgh';
const CANARY_PASSWORD = 'tm-canary-password-9876543210';
const CANARY_PATH = '/Users/privacy-canary/.cursor/mcp.json';
const CANARY_CONFIG = '[mcp_servers.tidemind]\ncommand = "tm-node"\ntoken = "do-not-store"';
const PROTOTYPE_LIKE_DIAGNOSTIC_KEYS = ['__proto__', 'prototype', 'constructor'] as const;
const TRUNCATION_KEY_CASES = [
  { name: 'exact collection limit', regularKeyCount: 31, keyPosition: 'first', rejected: false },
  { name: 'over limit inside retained window', regularKeyCount: 32, keyPosition: 'first', rejected: true },
  { name: 'over limit outside retained window', regularKeyCount: 32, keyPosition: 'last', rejected: true },
] as const;
const PATH_V7_CASES = [
  ['unicode UNC', String.raw`\\服务器\共享 目录、内部\隐私 用户\secret.json`],
  ['unicode extended UNC', String.raw`\\?\UNC\服务器\共享 目录、内部\隐私 用户\secret.json`],
  ['localhost file URL', 'file://localhost/Users/Privacy Canary/Library/Application Support/secret.json'],
  ['remote file URL', 'file://服务器/共享目录/Privacy Canary/secret.json'],
  ['WSL UNC', String.raw`\\wsl$\Ubuntu-24.04\home\Privacy Canary\secret.json`],
  ['DOS device drive', String.raw`\\.\C:\Users\Privacy Canary\secret.json`],
  [
    'volume GUID',
    String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\Users\Privacy Canary\secret.json`,
  ],
  [
    'GLOBALROOT device',
    String.raw`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\Privacy Canary\secret.json`,
  ],
  ['double-slash POSIX', '//absolute/Users/Privacy Canary/secret.json'],
] as const;
const PATH_V8_CASES = [
  [
    'POSIX punctuation',
    `/Users/Privacy, Canary/Projects; 2026/客户"引用"/[draft]+final/secret-v8.json`,
  ],
  [
    'home punctuation',
    `~/Library/Application Support/Privacy, Canary/项目; 2026/'引用'/[draft]+final/secret-v8.json`,
  ],
  [
    'Windows punctuation',
    String.raw`C:\Users\Privacy, Canary\Projects; 2026\[draft]+final\secret-v8.json`,
  ],
  [
    'UNC punctuation',
    String.raw`\\privacy-server\private+share\Privacy, Canary\Projects; 2026\[draft]+final\secret-v8.json`,
  ],
  [
    'file URL punctuation',
    'file:///Users/Privacy,%20Canary/Projects;%202026/%22quoted%22/[draft]+final/secret-v8.json',
  ],
] as const;
const PATH_V9_LEADING_PUNCTUATION = ['[', ']', '{', '}', '!', '?', ',', ';', ':', "'", '"'] as const;
const PATH_V9_CASES = PATH_V9_LEADING_PUNCTUATION.flatMap(leading => [
  [`POSIX leading ${leading}`, `/${leading}Privacy Canary/private/secret-v9.json`],
  [`home leading ${leading}`, `~/${leading}Privacy Canary/private/secret-v9.json`],
  [`Windows leading ${leading}`, `C:\\${leading}Privacy Canary\\private\\secret-v9.json`],
] as const);
interface PathPrivacyFixture {
  readonly unsafe: ReadonlyArray<{
    readonly name: string;
    readonly input: string;
    readonly forbidden: readonly string[];
  }>;
  readonly safe: ReadonlyArray<{ readonly name: string; readonly input: string }>;
}
const PATH_V13_FIXTURE = JSON.parse(fs.readFileSync(
  new URL('../fixtures/agent-integration-path-privacy-v13.json', import.meta.url),
  'utf8',
)) as PathPrivacyFixture;

function eventRow(db: Database.Database, id: string): { dedupe_key: string | null; payload_json: string } {
  return db.prepare(`
    SELECT dedupe_key, payload_json FROM agent_integration_events WHERE id = ?
  `).get(id) as { dedupe_key: string | null; payload_json: string };
}

describe('Agent Integration event persistence sanitizer', () => {
  it('redacts credentials, absolute paths and config bodies before repository persistence', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const deep = { level: 0 } as Record<string, unknown>;
      let cursor = deep;
      for (let index = 1; index < 12; index += 1) {
        const next = { level: index } as Record<string, unknown>;
        cursor.next = next;
        cursor = next;
      }
      const rawDedupeKey = `repair:${CANARY_PATH}:token=${CANARY_TOKEN}`;
      repository.recordEvent({
        id: 'privacy-event',
        kind: 'privacy_canary',
        severity: 'error',
        dedupeKey: rawDedupeKey,
        payload: {
          token: CANARY_TOKEN,
          accessToken: CANARY_ACCESS_TOKEN,
          password: CANARY_PASSWORD,
          error: { message: `failed to open ${CANARY_PATH}; token=${CANARY_TOKEN}` },
          renderedPaths: [
            `markdown \`${CANARY_PATH}\``,
            `arrow->${CANARY_PATH}`,
            `pipe|${CANARY_PATH}`,
            `angle>${CANARY_PATH}`,
            `parenthesized(${CANARY_PATH})`,
            `bang!${CANARY_PATH}`,
            `question?${CANARY_PATH}`,
            `at@${CANARY_PATH}`,
            `plus+${CANARY_PATH}`,
            `hash#${CANARY_PATH}`,
            'windows `C:\\Users\\privacy-canary\\AppData\\secret.json`',
            'public URL https://example.com/docs/agent-integration',
          ],
          diagnostics: [
            `permission denied at ${CANARY_PATH}`,
            CANARY_CONFIG,
            `file://${CANARY_PATH}`,
            `response={"accessToken":"${CANARY_ACCESS_TOKEN}"}`,
            `Authorization: Basic ${CANARY_PASSWORD}`,
          ],
          configuration: {
            mcpServers: { tidemind: { command: '/private/bin/tm-node', env: { TOKEN: CANARY_TOKEN } } },
          },
          command: `/private/bin/tm-node --token=${CANARY_TOKEN}`,
          args: ['--config', CANARY_PATH],
          prompt: `inspect ${CANARY_PATH}`,
          transcript: `operator pasted ${CANARY_PASSWORD}`,
          response: { raw: CANARY_CONFIG },
          oversized: 'x'.repeat(20_000),
          deep,
          many: Array.from({ length: AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE + 10 }, (_, index) => index),
        },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'privacy-event');
      const stored = `${row.dedupe_key ?? ''}\n${row.payload_json}`;
      expect(stored).not.toContain(CANARY_TOKEN);
      expect(stored).not.toContain(CANARY_ACCESS_TOKEN);
      expect(stored).not.toContain(CANARY_PASSWORD);
      expect(stored).not.toContain(CANARY_PATH);
      expect(stored).not.toContain('mcp_servers.tidemind');
      expect(stored).not.toContain('/private/bin/tm-node');
      expect(stored).not.toContain('C:\\Users\\privacy-canary');
      expect(stored).toContain('https://example.com/docs/agent-integration');
      expect(Buffer.byteLength(row.payload_json, 'utf8')).toBeLessThanOrEqual(
        AGENT_INTEGRATION_EVENT_MAX_PAYLOAD_BYTES,
      );
      expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
        .update('privacy_canary')
        .update('\0')
        .update(rawDedupeKey)
        .digest('hex')}`);

      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload.token).toBe('<redacted-credential>');
      expect(payload.accessToken).toBe('<redacted-credential>');
      expect(payload.password).toBe('<redacted-credential>');
      expect(payload.configuration).toBe('<redacted-config-content>');
      expect(payload.command).toBe('<redacted-config-content>');
      expect(payload.args).toBe('<redacted-config-content>');
      expect(payload.prompt).toBe('<redacted-config-content>');
      expect(payload.transcript).toBe('<redacted-config-content>');
      expect(payload.response).toBe('<redacted-config-content>');
      expect(JSON.stringify(payload.deep)).toContain('<truncated-depth>');
      expect(payload.many).toEqual(expect.arrayContaining(['<truncated-items>']));
    } finally {
      db.close();
    }
  });

  it.each(['!', '?', '@', '+', '#'])(
    'treats diagnostic punctuation %s as an absolute-path boundary',
    punctuation => {
      const db = new Database(':memory:');
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        repository.recordEvent({
          id: `punctuation-${punctuation.codePointAt(0)}`,
          kind: 'punctuation_path_boundary',
          severity: 'warning',
          dedupeKey: null,
          payload: { message: `failure${punctuation}${CANARY_PATH}` },
          createdAt: CREATED_AT,
        });
        const row = eventRow(db, `punctuation-${punctuation.codePointAt(0)}`);
        expect(row.payload_json).not.toContain(CANARY_PATH);
        expect(row.payload_json).toContain(`<local-path>`);
      } finally {
        db.close();
      }
    },
  );

  it('redacts POSIX and Windows paths after Unicode diagnostic punctuation in physical SQLite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-unicode-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const canaries = [
        `失败：${CANARY_PATH}`,
        `路径（/private/tmp/secret.json）`,
        `目标→${CANARY_PATH}`,
        `路径、${CANARY_PATH}`,
        'Windows：C:\\Users\\privacy-canary\\AppData\\secret.json',
      ];
      repository.recordEvent({
        id: 'unicode-path-boundaries',
        kind: 'unicode_path_boundary',
        severity: 'warning',
        dedupeKey: null,
        payload: {
          messages: canaries,
          publicUrls: [
            'https://example.com/docs/agent-integration',
            'https://例子.example/路径/说明',
          ],
        },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'unicode-path-boundaries');
      for (const canary of [CANARY_PATH, '/private/tmp/secret.json', 'C:\\Users\\privacy-canary']) {
        expect(row.payload_json).not.toContain(canary);
      }
      expect(row.payload_json.match(/<local-path>/gu)).toHaveLength(canaries.length);
      expect(row.payload_json).toContain('https://example.com/docs/agent-integration');
      expect(row.payload_json).toContain('https://例子.example/路径/说明');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts complete UNC, extended Windows and spaced Unicode paths without leaving sensitive suffixes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v6-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const sensitivePaths = [
        '\\\\privacy-server\\private-share\\Agent Secrets\\credential.json',
        '\\\\?\\C:\\Users\\Privacy Canary\\App Data\\secret.json',
        '\\\\?\\UNC\\extended-server\\private-share\\Unicode、Secrets\\secret.json',
        'C:\\Users\\Privacy Canary\\Application Data\\secret.json',
        '/Users/Privacy Canary/项目（内部）、备份/secret.json',
        '~/Library/Application Support/项目→内部/secret.json',
        'file:///Users/Privacy Canary/Library/Application Support/secret.json',
      ];
      repository.recordEvent({
        id: 'complete-local-path-v6',
        kind: 'complete_local_path_v6',
        severity: 'warning',
        dedupeKey: null,
        payload: {
          messages: [
            `UNC: \`${sensitivePaths[0]}\``,
            `extended: "${sensitivePaths[1]}"`,
            `extended UNC: ${sensitivePaths[2]}; status=blocked`,
            `drive: ${sensitivePaths[3]}; status=blocked`,
            `POSIX: ${sensitivePaths[4]}; status=blocked`,
            `home: 【${sensitivePaths[5]}】`,
            `file URL: "${sensitivePaths[6]}"`,
          ],
        },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'complete-local-path-v6');
      for (const sensitivePath of sensitivePaths) expect(row.payload_json).not.toContain(sensitivePath);
      for (const suffix of [
        'private-share', 'Agent Secrets', 'extended-server', 'Unicode、Secrets',
        'Privacy Canary', 'Application Data',
        '项目（内部）、备份', '项目→内部', 'Application Support', 'secret.json',
      ]) expect(row.payload_json).not.toContain(suffix);
      expect(row.payload_json.match(/<local-path>/gu)).toHaveLength(sensitivePaths.length);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(PATH_V7_CASES)(
    'redacts the complete v7 %s token in physical SQLite',
    (label, sensitivePath) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v7-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const rawDedupe = `path-v7:${label}:${sensitivePath}`;
        repository.recordEvent({
          id: `path-v7-${label.replace(/\W/gu, '-').toLowerCase()}`,
          kind: 'complete_local_path_v7',
          severity: 'warning',
          dedupeKey: rawDedupe,
          payload: { message: `location: ${sensitivePath}; status=blocked` },
          createdAt: CREATED_AT,
        });

        const row = eventRow(db, `path-v7-${label.replace(/\W/gu, '-').toLowerCase()}`);
        expect(JSON.parse(row.payload_json)).toEqual({
          message: 'location: <local-path>; status=blocked',
        });
        expect(row.payload_json).not.toContain('Privacy Canary');
        expect(row.payload_json).not.toContain('secret.json');
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('complete_local_path_v7')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(PATH_V8_CASES)(
    'redacts the complete v8 %s token instead of persisting a punctuation suffix',
    (label, sensitivePath) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v8-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const rawDedupe = `path-v8:${label}:${sensitivePath}`;
        repository.recordEvent({
          id: `path-v8-${label.replace(/\W/gu, '-').toLowerCase()}`,
          kind: 'complete_local_path_v8',
          severity: 'warning',
          dedupeKey: rawDedupe,
          payload: { message: `location: ${sensitivePath}; status=blocked` },
          createdAt: CREATED_AT,
        });

        const row = eventRow(db, `path-v8-${label.replace(/\W/gu, '-').toLowerCase()}`);
        expect(JSON.parse(row.payload_json)).toEqual({
          message: 'location: <local-path>; status=blocked',
        });
        for (const canary of [
          'Privacy', 'Canary', 'Projects', '2026', 'quoted', '引用',
          '[draft]', '+final', 'private+share', 'secret-v8.json',
        ]) expect(row.payload_json).not.toContain(canary);
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('complete_local_path_v8')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(PATH_V9_CASES)(
    'redacts the complete v9 %s token whose first segment starts with punctuation',
    (label, sensitivePath) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v9-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const rawDedupe = `path-v9:${label}:${sensitivePath}`;
        const id = `path-v9-${createHash('sha256').update(label).digest('hex').slice(0, 12)}`;
        repository.recordEvent({
          id,
          kind: 'complete_local_path_v9',
          severity: 'warning',
          dedupeKey: rawDedupe,
          payload: { message: `location: ${sensitivePath}; status=blocked` },
          createdAt: CREATED_AT,
        });

        const row = eventRow(db, id);
        expect(JSON.parse(row.payload_json)).toEqual({
          message: 'location: <local-path>; status=blocked',
        });
        expect(row.payload_json).not.toContain('Privacy Canary');
        expect(row.payload_json).not.toContain('secret-v9.json');
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('complete_local_path_v9')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('redacts v10 drive-slash, URL userinfo and paths following a URL token in physical SQLite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v10-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      repository.recordEvent({
        id: 'path-v10-url-boundaries',
        kind: 'path_v10_url_boundaries',
        severity: 'warning',
        dedupeKey: null,
        payload: {
          messages: [
            'single-slash drive: C:/Users/Privacy Canary/private/secret-v10.json',
            'drive: C://Users/Privacy Canary/private/secret-v10.json',
            'public then POSIX: https://example.com/docs then /Users/Privacy Canary/private/secret-v10.json',
            String.raw`custom then Windows: custom+scheme://example.test/docs then C:\Users\Privacy Canary\secret-v10.json`,
            'userinfo: https://alice:hunter2@example.com/private',
            'quoted before URL: "/Users/Privacy Canary/private/secret-v10.json"; URL https://example.com/after-quoted-path',
          ],
        },
        createdAt: CREATED_AT,
      });

      expect(JSON.parse(eventRow(db, 'path-v10-url-boundaries').payload_json)).toEqual({
        messages: [
          'single-slash drive: <local-path>',
          'drive: <local-path>',
          'public then POSIX: https://example.com/docs then <local-path>',
          'custom then Windows: custom+scheme://example.test/docs then <local-path>',
          'userinfo: https://<redacted-credential>@example.com/private',
          'quoted before URL: "<local-path>"; URL https://example.com/after-quoted-path',
        ],
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts v11 diagnostic path assignments immediately following protected URLs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v11-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const messages = [
        'url=https://example.com/docs;path=/Users/Privacy Canary/private/semicolon.json',
        'url=https://example.com/docs,target=/private/tmp/Privacy Canary/comma.json',
        String.raw`url=https://example.com/docs|target=C:\Users\Privacy Canary\pipe.json`,
        'url=https://example.com/docs→target=/Users/Privacy Canary/arrow.json',
        'url=custom+scheme://example.test/docs=>target=~/Privacy Canary/custom.json',
      ];
      repository.recordEvent({
        id: 'path-v11-url-diagnostics',
        kind: 'path_v11_url_diagnostics',
        severity: 'warning',
        dedupeKey: 'path-v11-url-diagnostics',
        payload: { messages },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'path-v11-url-diagnostics');
      expect(JSON.parse(row.payload_json)).toEqual({ messages: [
        'url=https://example.com/docs;path=<local-path>',
        'url=https://example.com/docs,target=<local-path>',
        'url=https://example.com/docs|target=<local-path>',
        'url=https://example.com/docs→target=<local-path>',
        'url=custom+scheme://example.test/docs=>target=<local-path>',
      ] });
      expect(row.payload_json).not.toContain('Privacy Canary');
      expect(row.payload_json).not.toMatch(/semicolon\.json|comma\.json|pipe\.json|arrow\.json|custom\.json/u);
      expect(row.dedupe_key).toMatch(/^sha256:[a-f0-9]{64}$/u);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(PATH_V13_FIXTURE.unsafe)(
    'redacts the complete v13 $name token in physical SQLite',
    ({ name, input, forbidden }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-path-v13-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const id = `path-v13-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
        const rawDedupe = `path-v13:${name}:${input}`;
        repository.recordEvent({
          id,
          kind: 'path_v13_contract',
          severity: 'warning',
          dedupeKey: rawDedupe,
          payload: { message: input },
          createdAt: CREATED_AT,
        });

        const row = eventRow(db, id);
        expect(row.payload_json).toContain('<local-path>');
        for (const canary of forbidden) expect(row.payload_json).not.toContain(canary);
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('path_v13_contract')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('persists dynamic sensitive object keys as distinct deterministic SHA-256 placeholders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-key-v14-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const dynamicKeys = [
        '/Users/Privacy Key One/private/secret.json',
        String.raw`C:\Users\Privacy Key Two\private\secret.json`,
      ];
      const rawDedupe = `dynamic-keys:${dynamicKeys.join('|')}`;
      repository.recordEvent({
        id: 'dynamic-object-keys-v14',
        kind: 'dynamic_object_keys_v14',
        severity: 'warning',
        dedupeKey: rawDedupe,
        payload: {
          diagnostics: Object.fromEntries(dynamicKeys.map((key, index) => [key, `value-${index}`])),
        },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'dynamic-object-keys-v14');
      const payload = JSON.parse(row.payload_json) as { diagnostics: Record<string, string> };
      const expectedKeys = dynamicKeys.map(key => `_redacted_key_sha256_${createHash('sha256')
        .update(key)
        .digest('hex')}`);
      expect(Object.keys(payload.diagnostics)).toEqual(expectedKeys);
      expect(Object.values(payload.diagnostics)).toEqual(['value-0', 'value-1']);
      expect(row.payload_json).not.toContain('Privacy Key One');
      expect(row.payload_json).not.toContain('Privacy Key Two');
      expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
        .update('dynamic_object_keys_v14')
        .update('\0')
        .update(rawDedupe)
        .digest('hex')}`);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(PROTOTYPE_LIKE_DIAGNOSTIC_KEYS)(
    'preserves the legal %s diagnostic key in physical SQLite without prototype mutation',
    diagnosticKey => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-key-v15-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const diagnosticValue = `retained-${diagnosticKey}`;
        const rawDedupe = `prototype-like-key:${diagnosticKey}`;
        repository.recordEvent({
          id: `prototype-like-${diagnosticKey}`,
          kind: 'prototype_like_diagnostic_v15',
          severity: 'warning',
          dedupeKey: rawDedupe,
          payload: {
            diagnostics: Object.fromEntries([[diagnosticKey, diagnosticValue]]),
          },
          createdAt: CREATED_AT,
        });

        const row = eventRow(db, `prototype-like-${diagnosticKey}`);
        const payload = JSON.parse(row.payload_json) as {
          diagnostics: Record<string, string>;
        };
        expect(Object.keys(payload.diagnostics)).toEqual([diagnosticKey]);
        expect(Object.prototype.hasOwnProperty.call(payload.diagnostics, diagnosticKey)).toBe(true);
        expect(payload.diagnostics[diagnosticKey]).toBe(diagnosticValue);
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('prototype_like_diagnostic_v15')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(TRUNCATION_KEY_CASES)(
    'keeps internal truncation metadata outside user key space for $name',
    ({ name, regularKeyCount, keyPosition, rejected }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-truncation-key-v16-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const regularEntries = Array.from(
          { length: regularKeyCount },
          (_, index) => [`field_${index}`, `value-${index}`] as const,
        );
        const userEntry = ['_truncated', 'legitimate-user-diagnostic'] as const;
        const entries = keyPosition === 'first'
          ? [userEntry, ...regularEntries]
          : [...regularEntries, userEntry];
        const eventId = `truncation-key-${name.replaceAll(' ', '-')}`;
        const rawDedupe = `truncation-key:${name}`;
        let caught: unknown;
        try {
          repository.recordEvent({
            id: eventId,
            kind: 'truncation_metadata_key_v16',
            severity: 'warning',
            dedupeKey: rawDedupe,
            payload: { diagnostics: Object.fromEntries(entries) },
            createdAt: CREATED_AT,
          });
        } catch (error) {
          caught = error;
        }

        if (rejected) {
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message)
            .toBe('Agent Integration event object-key redaction collision');
          expect((caught as Error).message).not.toContain('_truncated');
          expect(db.prepare(`
            SELECT COUNT(*) FROM agent_integration_events WHERE id = ?
          `).pluck().get(eventId)).toBe(0);
          return;
        }

        expect(caught).toBeUndefined();
        const row = eventRow(db, eventId);
        const payload = JSON.parse(row.payload_json) as {
          diagnostics: Record<string, string>;
        };
        expect(Object.keys(payload.diagnostics)).toHaveLength(AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE);
        expect(payload.diagnostics._truncated).toBe('legitimate-user-diagnostic');
        expect(row.dedupe_key).toBe(`sha256:${createHash('sha256')
          .update('truncation_metadata_key_v16')
          .update('\0')
          .update(rawDedupe)
          .digest('hex')}`);
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('fails closed without echoing a sensitive key when a legal key matches its placeholder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-key-collision-v14-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const sensitiveKey = '/Users/Collision Privacy Canary/private/secret.json';
      const placeholder = `_redacted_key_sha256_${createHash('sha256').update(sensitiveKey).digest('hex')}`;
      let caught: unknown;
      try {
        repository.recordEvent({
          id: 'dynamic-object-key-collision-v14',
          kind: 'dynamic_object_key_collision_v14',
          severity: 'error',
          dedupeKey: 'collision-v14',
          payload: {
            diagnostics: Object.fromEntries([
              [placeholder, 'literal-value'],
              [sensitiveKey, 'private-value'],
            ]),
          },
          createdAt: CREATED_AT,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Agent Integration event object-key redaction collision');
      expect((caught as Error).message).not.toContain(sensitiveKey);
      expect(db.prepare(`
        SELECT COUNT(*) FROM agent_integration_events WHERE id = ?
      `).pluck().get('dynamic-object-key-collision-v14')).toBe(0);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(PATH_V13_FIXTURE.safe)(
    'preserves the v13 $name negative in physical SQLite',
    ({ name, input }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-safe-v13-'));
      const db = new Database(path.join(root, 'brain.sqlite'));
      try {
        ensureSchema(db);
        const repository = new AgentIntegrationRepository(db);
        const id = `safe-v13-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
        repository.recordEvent({
          id,
          kind: 'path_v13_negative_contract',
          severity: 'info',
          dedupeKey: null,
          payload: { message: input },
          createdAt: CREATED_AT,
        });

        expect(JSON.parse(eventRow(db, id).payload_json)).toEqual({ message: input });
      } finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preserves international URLs, ordinary punctuation and non-path backslash text', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      const repository = new AgentIntegrationRepository(db);
      const safeMessages = [
        'https://example.com/Program Files/公开文档（中文版）',
        'https://例子.example/路径/说明、版本二',
        `https://example.com/${PATH_V9_LEADING_PUNCTUATION.join('')}/公开路径?next=/Users/public`,
        'https://example.com/docs?next=/Users/public&target=C:/Users/public',
        'https://example.com/docs#/Users/public/config.json',
        'custom+scheme://例子.example/[公开],;路径/说明',
        '//cdn.example.com/Program Files/公开文档（中文版）',
        '//localhost/application/公开路径',
        '普通文本：版本 1.2（稳定）、状态→正常！',
        '命令选项 /? 表示帮助；分隔符 / 不代表文件',
        String.raw`regex \\d+\\w+ and escapes \n \t are not paths`,
        String.raw`regex \\p{L}+\\s+ remains expression text`,
        String.raw`namespace\component is not an absolute path`,
      ];
      repository.recordEvent({
        id: 'non-path-negative-v6',
        kind: 'non_path_negative_v6',
        severity: 'info',
        dedupeKey: null,
        payload: { messages: safeMessages },
        createdAt: CREATED_AT,
      });

      const row = eventRow(db, 'non-path-negative-v6');
      expect(JSON.parse(row.payload_json)).toEqual({ messages: safeMessages });
      expect(row.payload_json).not.toContain('<local-path>');
    } finally {
      db.close();
    }
  });

  it('uses the same boundary for orphan activity written outside the Electron repository', () => {
    const db = new Database(':memory:');
    try {
      ensureSchema(db);
      const unsafeAgentId = `${CANARY_PATH}:token=${CANARY_TOKEN}`;
      expect(touchAgent(db, unsafeAgentId)).toEqual({ status: 'orphan', reason: 'unknown_agent' });
      const row = db.prepare(`
        SELECT dedupe_key, payload_json FROM agent_integration_events
        WHERE kind = 'orphan_agent_activity'
      `).get() as { dedupe_key: string; payload_json: string };
      expect(`${row.dedupe_key}\n${row.payload_json}`).not.toContain(CANARY_PATH);
      expect(`${row.dedupe_key}\n${row.payload_json}`).not.toContain(CANARY_TOKEN);
      expect(JSON.parse(row.payload_json)).toMatchObject({ reason: 'unknown_agent' });
    } finally {
      db.close();
    }
  });

  it('idempotently upgrades historical payloads and dedupe keys to the current scrub version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-history-'));
    const db = new Database(path.join(root, 'brain.sqlite'));
    try {
      ensureSchema(db);
      db.prepare(`
        UPDATE metadata SET value = '15'
        WHERE key = 'agent_integration_event_sanitizer_version'
      `).run();
      const historicalSensitiveKey = '/Users/History Key Canary/private/secret-v14.json';
      const historicalPlaceholder = `_redacted_key_sha256_${createHash('sha256')
        .update(historicalSensitiveKey)
        .digest('hex')}`;
      const insert = db.prepare(`
        INSERT INTO agent_integration_events (
          id, kind, severity, dedupe_key, payload_json, created_at
        ) VALUES (?, 'historical_privacy', 'error', ?, ?, ?)
      `);
      insert.run(
        'historical-a',
        `same:token=${CANARY_TOKEN}`,
        JSON.stringify({
          message: `read \`${CANARY_PATH}\` ->/private/tmp/private.json |C:\\Users\\privacy-canary\\secret.json 失败：/Users/privacy-canary/private.json 目标→D:\\Secrets\\agent.json UNC：\\\\history-server\\private-share\\Agent Secrets\\credential.json extended：“\\\\?\\C:\\Users\\History Canary\\secret.json” v7-unc：“${PATH_V7_CASES[0][1]}” v7-file：“${PATH_V7_CASES[2][1]}” v7-remote：“${PATH_V7_CASES[3][1]}” v7-device：“${PATH_V7_CASES[7][1]}” v7-posix：“${PATH_V7_CASES[8][1]}” v8-posix：“${PATH_V8_CASES[0][1]}” v8-unc：“${PATH_V8_CASES[3][1]}” v8-file：“${PATH_V8_CASES[4][1]}” v9-posix：“${PATH_V9_CASES[0][1]}” v9-home：“${PATH_V9_CASES[1][1]}” v9-windows：“${PATH_V9_CASES[2][1]}” v10-drive：“C://Users/History Canary/private/secret-v10.json” v10-url：https://example.com/docs then /Users/History Canary/private/after-url.json v10-userinfo：https://history-user:history-pass@example.com/private v11：https://example.com/docs;path=/Users/History Canary/private/secret-v11.json`,
          v10: [
            'drive C://Users/History Canary/private/secret-v10.json',
            'URL https://example.com/docs then /Users/History Canary/private/after-url.json',
            'userinfo https://history-user:history-pass@example.com/private',
          ],
          v11: 'https://example.com/docs|target=C:\\Users\\History Canary\\private\\secret-v11-windows.json',
          v13: PATH_V13_FIXTURE.unsafe.map(testCase => testCase.input),
          dynamicKeys: { [historicalSensitiveKey]: 'historical-value' },
          prototypeLikeKeys: Object.fromEntries(PROTOTYPE_LIKE_DIAGNOSTIC_KEYS.map(
            key => [key, `historical-${key}`],
          )),
          truncationKey: {
            _truncated: 'historical-user-diagnostic',
            ordinary: 'historical-ordinary-value',
          },
          publicUrl: 'https://example.com/docs/path',
          api_key: CANARY_TOKEN,
        }),
        CREATED_AT,
      );
      insert.run(
        'historical-b',
        `same:token=${CANARY_PASSWORD}`,
        JSON.stringify({ stderr: CANARY_CONFIG, password: CANARY_PASSWORD }),
        '2026-08-26T00:00:01.000Z',
      );
      insert.run(
        'historical-invalid',
        null,
        `{invalid:${CANARY_PATH}:token=${CANARY_TOKEN}`,
        '2026-08-26T00:00:02.000Z',
      );

      ensureAgentIntegrationSchema(db);
      const first = db.prepare(`
        SELECT id, dedupe_key, payload_json FROM agent_integration_events ORDER BY id
      `).all() as Array<{ id: string; dedupe_key: string | null; payload_json: string }>;
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(CANARY_TOKEN);
      expect(serialized).not.toContain(CANARY_PASSWORD);
      expect(serialized).not.toContain(CANARY_PATH);
      expect(serialized).not.toContain('/private/tmp/private.json');
      expect(serialized).not.toContain('C:\\Users\\privacy-canary');
      expect(serialized).not.toContain('/Users/privacy-canary/private.json');
      expect(serialized).not.toContain('D:\\Secrets\\agent.json');
      expect(serialized).not.toContain('history-server');
      expect(serialized).not.toContain('private-share');
      expect(serialized).not.toContain('History Canary');
      expect(serialized).not.toContain('credential.json');
      expect(serialized).not.toContain('服务器');
      expect(serialized).not.toContain('共享目录');
      expect(serialized).not.toContain('Privacy Canary');
      expect(serialized).not.toContain('GLOBALROOT');
      expect(serialized).not.toContain('//absolute');
      expect(serialized).not.toContain('secret-v8.json');
      expect(serialized).not.toContain('private+share');
      expect(serialized).not.toContain('secret-v9.json');
      expect(serialized).not.toContain('secret-v10.json');
      expect(serialized).not.toContain('after-url.json');
      expect(serialized).not.toContain('history-user');
      expect(serialized).not.toContain('history-pass');
      expect(serialized).not.toContain('secret-v11.json');
      expect(serialized).not.toContain('secret-v11-windows.json');
      expect(serialized).not.toContain(historicalSensitiveKey);
      for (const testCase of PATH_V13_FIXTURE.unsafe) {
        for (const canary of testCase.forbidden) expect(serialized).not.toContain(canary);
      }
      expect(serialized).toContain('https://example.com/docs/path');
      expect(serialized).toContain('https://example.com/docs then <local-path>');
      expect(serialized).toContain('https://<redacted-credential>@example.com/private');
      expect(first.filter(row => row.dedupe_key === null)).toHaveLength(1);
      expect(first.filter(row => row.dedupe_key !== null).every(
        row => /^sha256:[a-f0-9]{64}$/u.test(row.dedupe_key!),
      )).toBe(true);
      expect(first.find(row => row.id === 'historical-invalid')?.payload_json)
        .toBe('{"_scrubbed":"invalid_payload_json"}');
      const historicalPayload = JSON.parse(
        first.find(row => row.id === 'historical-a')!.payload_json,
      ) as {
        dynamicKeys: Record<string, string>;
        prototypeLikeKeys: Record<string, string>;
        truncationKey: Record<string, string>;
      };
      expect(historicalPayload).toMatchObject({
        dynamicKeys: { [historicalPlaceholder]: 'historical-value' },
      });
      expect(Object.keys(historicalPayload.prototypeLikeKeys))
        .toEqual(PROTOTYPE_LIKE_DIAGNOSTIC_KEYS);
      for (const key of PROTOTYPE_LIKE_DIAGNOSTIC_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(historicalPayload.prototypeLikeKeys, key)).toBe(true);
        expect(historicalPayload.prototypeLikeKeys[key]).toBe(`historical-${key}`);
      }
      expect(historicalPayload.truncationKey).toEqual({
        _truncated: 'historical-user-diagnostic',
        ordinary: 'historical-ordinary-value',
      });
      expect(db.prepare(`
        SELECT value FROM metadata WHERE key = 'agent_integration_event_sanitizer_version'
      `).pluck().get()).toBe(String(AGENT_INTEGRATION_EVENT_SANITIZER_VERSION));

      ensureAgentIntegrationSchema(db);
      const second = db.prepare(`
        SELECT id, dedupe_key, payload_json FROM agent_integration_events ORDER BY id
      `).all();
      expect(second).toEqual(first);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('safely scrubs the exact v15 32-key truncation shape across a physical SQLite restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-event-history-v15-truncation-'));
    const databasePath = path.join(root, 'brain.sqlite');
    const kind = 'historical_v15_truncated_diagnostic';
    const rawDedupe = `legacy-v15:${CANARY_TOKEN}:${CANARY_PATH}`;
    const persistedDedupe = `sha256:${createHash('sha256')
      .update(kind)
      .update('\0')
      .update(rawDedupe)
      .digest('hex')}`;
    const retainedEntries = Array.from(
      { length: AGENT_INTEGRATION_EVENT_MAX_COLLECTION_SIZE },
      (_, index) => [
        `legacy_field_${index}`,
        index === 0 ? `${CANARY_TOKEN}:${CANARY_PATH}` : `legacy-value-${index}`,
      ] as const,
    );
    const legacyTruncatedObject = Object.fromEntries([
      ...retainedEntries,
      ['_truncated', '<truncated-items>'],
    ]);

    const initial = new Database(databasePath);
    try {
      ensureSchema(initial);
      initial.prepare(`
        UPDATE metadata SET value = '15'
        WHERE key = 'agent_integration_event_sanitizer_version'
      `).run();
      initial.prepare(`
        INSERT INTO agent_integration_events (
          id, kind, severity, dedupe_key, payload_json, created_at
        ) VALUES ('historical-v15-truncated', ?, 'warning', ?, ?, ?)
      `).run(
        kind,
        persistedDedupe,
        JSON.stringify({ diagnostics: legacyTruncatedObject, retained: 'ordinary-diagnostic' }),
        CREATED_AT,
      );
    } finally {
      initial.close();
    }

    const upgraded = new Database(databasePath);
    try {
      expect(() => ensureAgentIntegrationSchema(upgraded)).not.toThrow();
      const first = eventRow(upgraded, 'historical-v15-truncated');
      expect(first.dedupe_key).toBe(persistedDedupe);
      expect(JSON.parse(first.payload_json)).toEqual({
        diagnostics: { _scrubbed: 'legacy_v15_truncated_object' },
        retained: 'ordinary-diagnostic',
      });
      expect(first.payload_json).not.toContain(CANARY_TOKEN);
      expect(first.payload_json).not.toContain(CANARY_PATH);
      expect(first.payload_json).not.toContain('legacy-value-31');
      expect(upgraded.prepare(`
        SELECT value FROM metadata WHERE key = 'agent_integration_event_sanitizer_version'
      `).pluck().get()).toBe(String(AGENT_INTEGRATION_EVENT_SANITIZER_VERSION));

      ensureAgentIntegrationSchema(upgraded);
      expect(eventRow(upgraded, 'historical-v15-truncated')).toEqual(first);
    } finally {
      upgraded.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
