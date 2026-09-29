import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { readReleaseWorkflow } from '../helpers/release-workflow';
const workflow = load(readReleaseWorkflow(path.resolve('.'))) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string; uses?: string }> }> };
const admission = workflow.jobs['admit-source'].steps.find(step => step.name === 'Admit release source before secrets')!.run!;
const dirs: string[] = [];
function setup(version = '0.2.93') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-release-admission-')); dirs.push(dir);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(path.join(dir, 'client'));
  for (const file of ['package.json', 'client/package.json']) fs.writeFileSync(path.join(dir, file), JSON.stringify({ version }));
  fs.mkdirSync(path.join(dir, 'release-evidence/partial-auth-runtime/0.2.93'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'release-evidence/partial-auth-runtime/0.2.93/report.json'), '{}');
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', `fixture\n\nTideMind-Source-Commit: ${'a'.repeat(40)}`); git('remote', 'add', 'origin', dir);
  const head = git('rev-parse', 'HEAD');
  return { dir, git, run(overrides: Record<string, string> = {}) {
    const output = path.join(dir, `output-${Math.random().toString(36).slice(2)}`);
    const result = spawnSync('/bin/bash', ['-c', admission], { cwd: dir, encoding: 'utf8', env: { ...env,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_REF_TYPE: 'branch',
      GITHUB_SHA: head, GITHUB_OUTPUT: output, CANDIDATE_ONLY: 'false', PARTIAL_AUTH_RUNTIME: 'false', REQUESTED_SOURCE_SHA: 'a'.repeat(40), ...overrides } });
    return { ...result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
  } };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('0.2.93 partial-auth workflow admission', () => {
  it('does not enable an exception merely because a report exists', () => {
    const result = setup().run(); expect(result.status).toBe(0); expect(result.output).toContain('partial_auth_runtime=false');
  });
  it('admits only an explicitly requested main preflight', () => {
    const repo = setup();
    const accepted = repo.run({ PARTIAL_AUTH_RUNTIME: 'true' }); expect(accepted.status).toBe(0); expect(accepted.output).toContain('partial_auth_runtime=true');
    expect(repo.run({ PARTIAL_AUTH_RUNTIME: 'true', CANDIDATE_ONLY: 'true' }).status).not.toBe(0);
    expect(repo.run({ PARTIAL_AUTH_RUNTIME: 'true', GITHUB_REF: 'refs/heads/other', GITHUB_REF_NAME: 'other' }).status).not.toBe(0);
  });
  it('rejects package metadata symlinks without executing their target', () => {
    const repo = setup(); const marker = path.join(repo.dir, 'executed.txt');
    fs.writeFileSync(path.join(repo.dir, 'payload.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports={version:'0.2.93'};`);
    fs.unlinkSync(path.join(repo.dir, 'package.json')); fs.symlinkSync('payload.js', path.join(repo.dir, 'package.json'));
    expect(repo.run({ PARTIAL_AUTH_RUNTIME: 'true' }).status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
  it.each(['0.2.92', '0.2.94'])('does not carry the exception to %s', version => {
    expect(setup(version).run({ PARTIAL_AUTH_RUNTIME: 'true' }).status).not.toBe(0);
  });
  it('requires an explicit annotated tag and binds it to the event commit', () => {
    const repo = setup(); const tagEnv = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.2.93', GITHUB_REF_NAME: 'v0.2.93', GITHUB_REF_TYPE: 'tag' };
    repo.git('tag', 'v0.2.93'); expect(repo.run(tagEnv).output).toContain('partial_auth_runtime=false');
    repo.git('tag', '-d', 'v0.2.93');
    repo.git('tag', '-a', 'v0.2.93', '-m', 'Release\n\nTideMind-Acceptance: partial-auth-runtime-0.2.93');
    const accepted = repo.run(tagEnv); expect(accepted.status).toBe(0); expect(accepted.output).toContain('partial_auth_runtime=true');
    expect(repo.run({ ...tagEnv, GITHUB_SHA: 'b'.repeat(40) }).status).not.toBe(0);
  });
  it('rejects unsupported annotation markers instead of silently lowering the gate', () => {
    const repo = setup(); repo.git('tag', '-a', 'v0.2.93', '-m', 'TideMind-Acceptance: arbitrary-override');
    expect(repo.run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.2.93', GITHUB_REF_NAME: 'v0.2.93', GITHUB_REF_TYPE: 'tag' }).status).not.toBe(0);
  });
  it('accepts only newly added evidence after the candidate and rejects code drift', () => {
    const repo = setup(), candidate = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.dir, 'release-evidence/partial-auth-runtime/0.2.93/proof.json'), '{}');
    repo.git('add', '.'); repo.git('commit', '-qm', `evidence\n\nTideMind-Source-Commit: ${'a'.repeat(40)}`);
    const script = workflow.jobs['partial-auth-runtime-release'].steps.find(step => step.name === 'Reject source drift after the immutable candidate')!.run!;
    const run = () => spawnSync('/bin/bash', ['-c', script], { cwd: repo.dir, encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: repo.dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      CANDIDATE_PUBLIC_COMMIT: candidate, TIDEMIND_SOURCE_COMMIT: 'a'.repeat(40),
    } });
    expect(run().status).toBe(0);
    fs.writeFileSync(path.join(repo.dir, 'client/package.json'), JSON.stringify({ version: '0.2.93', altered: true }));
    repo.git('add', '.'); repo.git('commit', '-qm', `code drift\n\nTideMind-Source-Commit: ${'a'.repeat(40)}`);
    expect(run().status).not.toBe(0);
  });

  it('checks source immutability before repository code and checks signatures before draft upload', () => {
    const steps = workflow.jobs['partial-auth-runtime-release'].steps;
    const index = (name: string) => steps.findIndex(step => step.name === name);
    for (const name of ['Reject source drift after the immutable candidate', 'Install locked verification tools',
      'Verify sealed partial report before fetching artifacts', 'Verify and stage precomputed public update signatures',
      'Upload original verified candidate as Draft']) expect(index(name)).toBeGreaterThanOrEqual(0);
    const setupNode = steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toBeGreaterThan(index('Reject source drift after the immutable candidate'));
    expect(index('Reject source drift after the immutable candidate')).toBeLessThan(index('Install locked verification tools'));
    expect(index('Reject source drift after the immutable candidate')).toBeLessThan(index('Verify sealed partial report before fetching artifacts'));
    expect(index('Verify and stage precomputed public update signatures')).toBeLessThan(index('Upload original verified candidate as Draft'));
    expect(steps.find(step => step.name === 'Verify partial coverage and exact signed candidate')!.run).toContain('--performance-artifact-zip');
  });
});
