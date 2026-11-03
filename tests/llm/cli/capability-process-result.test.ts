import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeCliCapabilityProbe } from '../../../src/llm/cli/readiness';

const exec = promisify(execFile);
const env = { PATH: '/usr/bin:/bin' };
let temp: string;
let bundle: string;

beforeAll(() => {
  temp = mkdtempSync(path.join(tmpdir(), 'cli-capability-result-'));
  bundle = path.join(temp, 'readiness.cjs');
  buildSync({
    entryPoints: [path.resolve('src/llm/cli/readiness.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
});
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

describe('real capability process results', () => {
  it('rejects timeout-killed empty output even when Node reports a successful exit', async () => {
    // Reproduce the Node event-loop/stdio ordering in a standalone process. The
    // command finishes while the parent is blocked; execFile's timeout destroys
    // its buffered output before delivering an error=null/code=0 callback.
    const script = `
      const { executeCliCapabilityProbe } = require(process.argv[1]);
      const pending = executeCliCapabilityProbe('/bin/sh', ['-c', 'printf feature_fixture'], {PATH:'/usr/bin:/bin'});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8500);
      pending.then(
        value => { console.log(JSON.stringify({accepted:true, value})); process.exitCode=1; },
        error => { console.log(JSON.stringify({accepted:false, kind:error.kind, retryable:error.options.retryable})); }
      );
    `;
    const result = await exec(process.execPath, ['-e', script, bundle], {
      timeout: 18_000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    expect(JSON.parse(result.stdout)).toEqual({ accepted: false, kind: 'timeout', retryable: true });
  }, 20_000);

  it('retains ordinary output and nonzero exit results', async () => {
    await expect(executeCliCapabilityProbe('/bin/sh', ['-c', 'printf feature_fixture; exit 3'], env))
      .resolves.toEqual({ stdout: 'feature_fixture', stderr: '', exitCode: 3 });
  });

  it('does not relabel cancellation or output overflow as a timeout', async () => {
    const controller = new AbortController();
    const pending = executeCliCapabilityProbe('/bin/sh', ['-c', 'exec /bin/sleep 5'], env, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await expect(executeCliCapabilityProbe(
      process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'], env,
    )).rejects.toMatchObject({ kind: 'output_limit' });
  });
});
