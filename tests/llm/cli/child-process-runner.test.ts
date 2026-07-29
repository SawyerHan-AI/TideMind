import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliChildProcessRunner,
  CliProcessRegistry,
} from '../../../src/llm/cli/child-process-runner.js';

const fixture = resolve(
  fileURLToPath(new URL('../../fixtures/llm-cli/fake-cli.mjs', import.meta.url)),
);

function executable(name = 'fake-cli'): { executable: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tidemind-runner-'));
  const path = join(cwd, name);
  copyFileSync(fixture, path);
  chmodSync(path, 0o700);
  return { executable: path, cwd };
}

describe('CLI child process runner', () => {
  it('uses stdin and handles split-safe UTF-8 output', async () => {
    const { executable: path, cwd } = executable('claude');
    const registry = new CliProcessRegistry();
    const result = await new CliChildProcessRunner(registry).run({
      executable: path,
      args: ['-p'],
      cwd,
      env: { PATH: `${dirname(process.execPath)}:${cwd}:/usr/bin:/bin` },
      stdin: '你好',
      timeoutMs: 10_000,
      purpose: 'background',
    });
    expect(result.promptCommitted).toBe(true);
    expect(result.stdout).toContain('你好');
    expect(registry.activeCount).toBe(0);
  }, 15_000);

  it('does not spawn when pre-aborted', async () => {
    const { executable: path, cwd } = executable();
    const registry = new CliProcessRegistry();
    const controller = new AbortController();
    controller.abort();
    await expect(new CliChildProcessRunner(registry).run({
      executable: path,
      args: [],
      cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'never',
      timeoutMs: 1_000,
      signal: controller.signal,
      purpose: 'background',
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(registry.activeCount).toBe(0);
  });

  it('classifies post-stdin timeout as ambiguous for background', async () => {
    const { executable: path, cwd } = executable();
    await expect(new CliChildProcessRunner(new CliProcessRegistry()).run({
      executable: path,
      args: [],
      cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'SLEEP',
      timeoutMs: 50,
      purpose: 'background',
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome', options: { promptCommitted: true } });
  });

  it('classifies connection-test cancellation as aborted and enforces output caps', async () => {
    const first = executable();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await expect(new CliChildProcessRunner(new CliProcessRegistry()).run({
      executable: first.executable,
      args: [],
      cwd: first.cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'SLEEP',
      timeoutMs: 2_000,
      signal: controller.signal,
      purpose: 'connection_test',
    })).rejects.toMatchObject({ kind: 'aborted' });

    const second = executable();
    await expect(new CliChildProcessRunner(new CliProcessRegistry()).run({
      executable: second.executable,
      args: [],
      cwd: second.cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'BIG',
      timeoutMs: 2_000,
      stdoutLimitBytes: 1024,
      purpose: 'background',
    })).rejects.toMatchObject({ kind: 'ambiguous_outcome' });
  });

  it('registry shutdown refuses new calls', async () => {
    const registry = new CliProcessRegistry();
    await registry.shutdown();
    const { executable: path, cwd } = executable();
    await expect(new CliChildProcessRunner(registry).run({
      executable: path,
      args: [],
      cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'x',
      timeoutMs: 100,
      purpose: 'background',
    })).rejects.toThrow(/stopping/);
  });

  it('shutdown waits for an in-flight spawn admission before taking its child snapshot', async () => {
    const registry = new CliProcessRegistry();
    const releaseAdmission = registry.beginAdmission();
    let settled = false;
    const shutdown = registry.shutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseAdmission();
    await shutdown;
    expect(settled).toBe(true);
  });

  it('kills a stubborn same-group grandchild after the parent exits', async () => {
    if (process.platform === 'win32') return;
    const { executable: path, cwd } = executable();
    const result = await new CliChildProcessRunner(new CliProcessRegistry()).run({
      executable: path,
      args: [],
      cwd,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: 'GRANDCHILD',
      timeoutMs: 2_000,
      purpose: 'connection_test',
    });
    const pid = Number(result.stdout);
    expect(Number.isSafeInteger(pid)).toBe(true);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        break;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
