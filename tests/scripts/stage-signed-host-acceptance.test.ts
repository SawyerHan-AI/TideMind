import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { readReleaseWorkflow } from '../helpers/release-workflow.js'
// @ts-expect-error plain ESM staging script
import { signedHostCandidateFiles, validateSignedHostCandidateReceipt, validateSignedHostChecksumManifest } from '../../scripts/stage-signed-host-acceptance.mjs'

const version = '0.2.93', source = 'a'.repeat(40), digest = 'b'.repeat(64)
const fixture = () => ({ schemaVersion: 1, verificationClass: 'private_rc_candidate', sourceCommit: source, appVersion: version,
  architecture: 'arm64', candidateBundleSha256: digest, executableSha256: digest, teamId: 'Z4U232GXH5',
  signingIdentity: 'Developer ID Application: Fixture (Z4U232GXH5)', cdhash: 'c'.repeat(40),
  dmgSha256: digest, zipSha256: digest, verifiedAt: '2026-09-30T00:00:00.000Z' })
const workflowSource = readReleaseWorkflow(process.cwd(), 'host-no-auth-acceptance.yml')
const workflow = load(workflowSource) as { permissions: unknown; jobs: { observe: { steps: Array<{ name?: string; run?: string; uses?: string; env?: unknown }> } } }
const steps = workflow.jobs.observe.steps
describe('signed host candidate staging contract', () => {
  it('binds the signed candidate to the exact source, version, architecture and signing team', () => {
    expect(validateSignedHostCandidateReceipt(fixture(), version, source)).toMatchObject({ sourceCommit: source, bundleSha256: digest, version })
    for (const [key, value] of Object.entries({ sourceCommit: 'd'.repeat(40), appVersion: '0.2.92', architecture: 'x64',
      teamId: 'OTHER', verificationClass: 'fixture', candidateBundleSha256: 'bad' })) {
      expect(() => validateSignedHostCandidateReceipt({ ...fixture(), [key]: value }, version, source), key).toThrow()
    }
    expect(() => validateSignedHostCandidateReceipt({ ...fixture(), passed: true }, version, source)).toThrow()
  })
  it('requires every original archive checksum without extra paths or duplicated entries', () => {
    const names = signedHostCandidateFiles(version).filter((name: string) => name !== 'files.sha256')
    const text = names.map((name: string) => digest + '  ' + name).join('\n')
    expect([...validateSignedHostChecksumManifest(text, version).keys()].sort()).toEqual(names)
    for (const bad of [text.split('\n').slice(1).join('\n'), text + '\n' + text.split('\n')[0], text + '\n' + digest + '  ../escape']) {
      expect(() => validateSignedHostChecksumManifest(bad, version)).toThrow()
    }
  })
  it('has read-only workflow permissions and admits immutable provenance before npm or repository imports', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
    const job = workflow.jobs.observe as unknown as { strategy: { matrix: { catalog_id: string[] }; 'fail-fast': boolean } }
    expect(job.strategy.matrix.catalog_id).toEqual(['codex-desktop', 'claude-cowork-local', 'claude-desktop-legacy'])
    expect(job.strategy['fail-fast']).toBe(false)
    expect(workflowSource).toContain('signed-host-no-auth-observations-${{ matrix.catalog_id }}')
    expect(workflowSource).toContain('--catalog-id "$OBSERVED_CATALOG_ID"')

    const admit = steps.findIndex(step => step.name?.startsWith('Admit exact'))
    const setup = steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'))
    const install = steps.findIndex(step => step.name?.startsWith('Install locked'))
    expect(admit).toBeGreaterThan(-1); expect(setup).toBeGreaterThan(admit); expect(install).toBeGreaterThan(setup)
    const operation = steps.find(step => step.name?.startsWith('Observe fixed'))!.run!
    expect(operation).toContain("env: { HOME: home, TMPDIR: tmp, USER:")
    expect(operation).not.toContain('...process.env')
    expect(operation).toContain("'--capture-nonce'")
    expect(operation).toContain("['claude-cowork-local', 'claude-desktop-legacy', 'codex-desktop']")
    expect(workflowSource).not.toContain('contents: write')
    const prepare = steps.find(step => step.name?.startsWith('Prepare reviewed'))!.run!
    expect(prepare).toContain('fs.mkdirSync(requested')
    expect(prepare).toContain('fs.realpathSync(requested)')
    expect(prepare).toContain('--output "$workspace/host-no-auth-samples.json"')
    expect(operation).toContain("path.join(workspace, 'host-no-auth-samples.json')")
  })
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
it('executes the real admission script and refuses wrong candidate runs/artifacts before download', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-admission-'))); dirs.push(dir)
  const program = path.join(dir, 'admit.cjs')
  const run = steps.find(step => step.name?.startsWith('Admit exact'))!.run!
  fs.writeFileSync(program, run.split("node - <<'NODE'\n")[1].split('\nNODE')[0])
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
  const trailer = path.join(dir, 'git')
  fs.writeFileSync(trailer, '#!/bin/sh\nprintf "%s\\n" "$REQUESTED_SOURCE"\n', { mode: 0o700 })
  fs.renameSync(trailer, path.join(bin, 'git'))
  const api = path.join(bin, 'gh')
  fs.writeFileSync(api, '#!' + process.execPath + '\n' + [
    "const fs = require('node:fs'); const e = process.env; const endpoint = process.argv[3];",
    "if (endpoint.endsWith('/zip')) { fs.writeFileSync(e.RUNNER_TEMP + '/download-attempted', 'yes'); process.stdout.write('fixture archive'); }",
    "else if (endpoint.includes('/runs/')) console.log(JSON.stringify({ id: 1, head_sha: e.TEST_BAD === 'head' ? 'b'.repeat(40) : e.GITHUB_SHA, head_branch: 'main', event: e.TEST_BAD === 'event' ? 'push' : 'workflow_dispatch', status: 'completed', conclusion: e.TEST_BAD === 'failed' ? 'failure' : 'success', path: '.github/workflows/release.yml', run_attempt: 1 }));",
    "else console.log(JSON.stringify({ id: 2, name: 'mac-rc-arm64-' + e.REQUESTED_SOURCE + '-1-' + (e.TEST_BAD === 'attempt' ? 2 : 1), expired: e.TEST_BAD === 'expired', digest: 'sha256:' + e.CANDIDATE_ARTIFACT_DIGEST, workflow_run: { id: e.TEST_BAD === 'owner' ? 7 : 1, head_sha: e.GITHUB_SHA } }));",
  ].join('\n'), { mode: 0o700 })
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RUNNER_TEMP: dir,
    REQUESTED_SOURCE: source, GITHUB_SHA: source, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'SawyerHan-AI/TideMind', CANDIDATE_RUN_ID: '1', CANDIDATE_ARTIFACT_ID: '2',
    CANDIDATE_ARTIFACT_DIGEST: digest, CAPTURE_NONCE: digest }
  for (const bad of ['head', 'event', 'failed', 'expired', 'owner', 'attempt']) {
    const result = spawnSync(process.execPath, [program], { env: { ...env, TEST_BAD: bad }, encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined(); expect(result.status, bad).not.toBe(0)
    expect(fs.existsSync(path.join(dir, 'download-attempted')), bad).toBe(false)
  }
  const accepted = spawnSync(process.execPath, [program], { env: { ...env,
    CANDIDATE_ARTIFACT_DIGEST: crypto.createHash('sha256').update('fixture archive').digest('hex'),
  }, encoding: 'utf8', timeout: 10000 })
  expect(accepted.status, accepted.stderr).toBe(0)
  expect(fs.readFileSync(path.join(dir, 'host-candidate-artifact.zip'), 'utf8')).toBe('fixture archive')
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'host-candidate-api-binding.json'), 'utf8')))
    .toMatchObject({ sourceCommit: source, publicCommit: source, runId: 1, artifactId: 2, captureNonce: digest })
})
