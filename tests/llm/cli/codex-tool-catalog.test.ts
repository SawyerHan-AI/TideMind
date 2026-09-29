import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_TOOL_CATALOG_LIMITS, prepareCodexToolCatalog, sanitizeCodexToolCatalog } from '../../../src/llm/cli/codex-tool-catalog.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';

const model = (slug: string, priority: number) => ({
  slug, priority, display_name: slug, context_window: 256000, supported_in_api: true,
  apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock', 'request_user_input_async'],
  tool_mode: 'code_mode_only', multi_agent_version: 'v2', supports_search_tool: true,
  supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
});
const catalog = () => ({ models: [model('future-model-2', 20), model('preferred-model', 0)] });
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Codex execution-only catalog', () => {
  it('preserves every non-tool field, every model and default priority/order', () => {
    const raw = catalog();
    const result = JSON.parse(sanitizeCodexToolCatalog(JSON.stringify(raw)));
    for (const entry of raw.models) Object.assign(entry, {
      apply_patch_tool_type: null, experimental_supported_tools: [], tool_mode: null,
      multi_agent_version: null, supports_search_tool: false,
    });
    for (const entry of raw.models) { delete (entry as Partial<typeof entry>).tool_mode; delete (entry as Partial<typeof entry>).multi_agent_version; }
    expect(result).toEqual(raw);
    expect(result.models.map((item: { slug: string }) => item.slug)).toEqual(['future-model-2', 'preferred-model']);
  });

  it('rejects malformed, incomplete, oversized, duplicate and newly introduced execution capabilities', () => {
    const invalid = [
      'bad JSON', '{}', JSON.stringify({ models: [] }),
      JSON.stringify({ models: [model('same', 0), model('same', 1)] }),
      JSON.stringify({ models: [{ ...model('x', 0), future_unconditional_tool: true }] }),
      JSON.stringify({ models: [{ ...model('x', 0), experimental_supported_tools: {} }] }),
      JSON.stringify({ models: [{ ...model('x', 0), tool_mode: 'future_mode' }] }),
      JSON.stringify({ models: [{ ...model('x', 0), apply_patch_tool_type: 'future_tool' }] }),
      JSON.stringify({ models: [Object.fromEntries(Object.entries(model('x', 0)).filter(([key]) => key !== 'experimental_supported_tools'))] }),
      ' '.repeat(CODEX_TOOL_CATALOG_LIMITS.maxBytes + 1),
    ];
    for (const raw of invalid) expect(() => sanitizeCodexToolCatalog(raw)).toThrow();
  });

  it('requires exact effective readback, uses a private file and removes it afterwards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tidemind-tool-catalog-test-')); roots.push(root);
    const executable = join(root, 'codex');
    copyFileSync(fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)), executable);
    chmodSync(executable, 0o700);
    const resolved = { kind: 'codex' as const, path: realpathSync(executable), version: '0.157.1', source: 'known_path' as const,
      controlledPath: `${dirname(process.execPath)}:/usr/bin:/bin`, identity: await captureCliIdentity(executable) };
    let file = '';
    const options = { resolved, dataDir: root,
      contract: { contractVersion: 2, cliVersion: resolved.version, disableFeatures: ['shell_tool'], residualFeatures: ['unified_exec'], fingerprint: 'fixture' },
      exec: async (args: readonly string[]) => {
        expect(args).toContain('debug');
        expect(args).toContain('models');
        expect(args).toContain('model_provider="openai"');
        const override = args.find(arg => arg.startsWith('model_catalog_json='));
        if (!override) { expect(args.at(-1)).toBe('--bundled'); return JSON.stringify(catalog()); }
        file = JSON.parse(override.slice('model_catalog_json='.length));
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
        return readFileSync(file, 'utf8');
      },
    };
    const result = await prepareCodexToolCatalog(options);
    expect(result).toBe(sanitizeCodexToolCatalog(JSON.stringify(catalog())));
    expect(existsSync(file)).toBe(false);
    let calls = 0;
    await expect(prepareCodexToolCatalog({ ...options, exec: async () => {
      calls++;
      return JSON.stringify(calls === 1 ? catalog() : { models: [model('substituted-default', 0)] });
    } })).rejects.toMatchObject({ kind: 'unsupported_version' });
  });
});
