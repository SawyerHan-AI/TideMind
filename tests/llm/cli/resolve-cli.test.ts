import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResolvedCliIdentity, resolveCli } from '../../../src/llm/cli/resolve-cli.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

describe('CLI resolver', () => {
  const tempDirs: string[] = [];
  const makeTrustedTempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(homedir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('realpaths, validates, and probes a fixed candidate', async () => {
    const dir = makeTrustedTempDir('.tidemind-resolver-');
    const real = join(dir, 'claude-real');
    const link = join(dir, 'claude');
    copyFileSync(fixture, real);
    chmodSync(real, 0o700);
    symlinkSync(real, link);
    const resolved = await resolveCli({
      kind: 'claude',
      candidates: [link],
      allowLoginShell: false,
      homeDir: dir,
    });
    expect(resolved.path).toBe(realpathSync(real));
    expect(resolved.version).toBe('2.1.215');
    expect(resolved.source).toBe('known_path');
    expect(resolved.identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    appendFileSync(real, '\n// replaced');
    await expect(assertResolvedCliIdentity(resolved)).rejects.toThrowError(
      expect.objectContaining({ kind: 'permission_policy' }),
    );
  }, 15_000);

  it('rejects world-writable and non-absolute candidates', async () => {
    const dir = makeTrustedTempDir('.tidemind-resolver-unsafe-');
    const path = join(dir, 'codex');
    copyFileSync(fixture, path);
    chmodSync(path, 0o777);
    await expect(resolveCli({
      kind: 'codex',
      candidates: [path, 'codex'],
      allowLoginShell: false,
      homeDir: dir,
    })).rejects.toMatchObject({ kind: 'permission_policy' });
  });

  it('rejects an executable below an untrusted writable parent', async () => {
    const dir = makeTrustedTempDir('.tidemind-resolver-parent-');
    const writable = join(dir, 'writable');
    mkdirSync(writable, { mode: 0o777 });
    chmodSync(writable, 0o777);
    const path = join(writable, 'codex');
    copyFileSync(fixture, path);
    chmodSync(path, 0o700);
    await expect(resolveCli({
      kind: 'codex',
      candidates: [path],
      allowLoginShell: false,
      homeDir: dir,
    })).rejects.toMatchObject({ kind: 'permission_policy' });
  });

  it('allows a group-writable parent owned by the current user for standard Homebrew layouts', async () => {
    const dir = makeTrustedTempDir('.tidemind-resolver-group-parent-');
    const writable = join(dir, 'writable');
    mkdirSync(writable, { mode: 0o775 });
    chmodSync(writable, 0o775);
    const path = join(writable, 'codex');
    copyFileSync(fixture, path);
    chmodSync(path, 0o700);
    await expect(resolveCli({
      kind: 'codex',
      candidates: [path],
      allowLoginShell: false,
      homeDir: dir,
    })).resolves.toMatchObject({ kind: 'codex', path: realpathSync(path) });
  });

  it('ignores development override unless explicitly enabled', async () => {
    const dir = makeTrustedTempDir('.tidemind-resolver-dev-');
    const path = join(dir, 'codex');
    copyFileSync(fixture, path);
    chmodSync(path, 0o700);
    await expect(resolveCli({
      kind: 'codex',
      developmentOverride: path,
      allowDevelopmentOverride: false,
      candidates: [],
      allowLoginShell: false,
      homeDir: dir,
    })).rejects.toMatchObject({ kind: 'not_installed' });
  });
});
