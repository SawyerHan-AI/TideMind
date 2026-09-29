import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareCodexToolCatalog } from '../../../src/llm/cli/codex-tool-catalog.js';
import { captureCliIdentity } from '../../../src/llm/cli/resolve-cli.js';
import { cliProcessRegistry } from '../../../src/llm/cli/runtime-process-registry.js';
import { shutdownCliRuntime } from '../../../src/llm/cli/service.js';

it('shutdown drains a metadata child and prevents a later metadata spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tidemind-metadata-shutdown-'));
  try {
    const path = join(dir, 'codex');
    writeFileSync(path, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
    chmodSync(path, 0o700);
    const resolved = { kind: 'codex' as const, path: realpathSync(path), version: '0.157.1', source: 'known_path' as const,
      controlledPath: `${dirname(process.execPath)}:/usr/bin:/bin`, identity: await captureCliIdentity(path) };
    const options = { resolved, dataDir: dir,
      contract: { contractVersion: 2, cliVersion: resolved.version, disableFeatures: ['shell_tool'], residualFeatures: [], fingerprint: 'fixture' } };
    const pending = prepareCodexToolCatalog(options).then(() => null, error => error);
    await vi.waitFor(() => expect(cliProcessRegistry.activeCount).toBe(1));
    await shutdownCliRuntime();
    expect(await pending).toBeInstanceOf(Error);
    expect(cliProcessRegistry.activeCount).toBe(0);
    await expect(prepareCodexToolCatalog(options)).rejects.toMatchObject({ kind: 'aborted' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
