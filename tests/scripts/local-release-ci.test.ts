import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertNoLocalCiEnvironmentFiles, installLocalCiElectron, localCiEnvironment, readBoundLocalCiReceipt, sealLocalCiOutput,
  validateLocalCiManifest, validateLocalElectronProbe } from '../../scripts/local-release-ci.mjs'
import { parseArgs } from '../../scripts/release.mjs'
import { resolveCli } from '../../src/llm/cli/resolve-cli.js'

const sourceCommit = 'a'.repeat(40)
const checkIds = [
  'audit-lock-root', 'audit-lock-client', 'audit-lock-cloud', 'audit-lock-website',
  'install-root', 'install-client', 'install-cloud', 'install-website',
  'install-electron', 'node-sqlite-abi', 'electron-sqlite-abi',
  'health', 'cloud-security', 'i18n', 'version-sync',
  'audit-root', 'audit-client', 'audit-cloud', 'release-dry-run',
  'agent-manifest', 'agent-performance', 'ui-dark', 'verify-dark', 'ui-light', 'verify-light',
]
const healthChecks = [
  'root lint', 'root build', 'worker bundle', 'root test', 'root audit',
  'cloud typecheck', 'cloud test', 'cloud audit', 'website typecheck',
  'website build', 'website audit', 'client build', 'client typecheck',
  'client audit', 'mac packaging',
]
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

function fixture() {
  const identity = {
    source: { sourceCommit, sourceAuthority: 'git-head-tree', protocolVersion: 3, sourceManifestSha256: 'b'.repeat(64), sourceFileCount: 10 },
    version: '0.2.95',
    electronVersion: '43.8.7',
    locks: Object.fromEntries(['package-lock.json', 'client/package-lock.json', 'pro/cloud-server/package-lock.json', 'pro/website/package-lock.json']
      .map(file => [file, 'c'.repeat(64)])),
  }
  const logs = new Map(checkIds.map(id => [
    id,
    Buffer.from(`Local release CI ${id} at ${sourceCommit}\n` + (id === 'health'
      ? healthChecks.map(name => `| ${name} | PASS | 0.1s |`).join('\n')
      : id === 'electron-sqlite-abi'
        ? 'Electron runtime {"electron":"43.8.7","modules":"148","arch":"arm64","platform":"darwin"}'
        : id === 'install-electron'
          ? '\nElectron installer exited successfully.\n'
          : 'synthetic step output for manifest validation')),
  ]))
  const startedAt = '2026-11-07T00:00:00.000Z'
  const completedAt = '2026-11-07T00:00:00.100Z'
  const manifest = {
    protocolVersion: 1,
    kind: 'trusted-operator-local-release-ci',
    identity: structuredClone(identity),
    platform: { os: 'darwin', arch: 'arm64', node: '24.18.0', linuxMatrix: 'not-run' },
    electronAbi: '148',
    receipts: { performance: 'a'.repeat(64), dark: 'b'.repeat(64), light: 'c'.repeat(64) },
    startedAt,
    completedAt,
    checks: checkIds.map(id => ({ id, exitCode: 0, startedAt, completedAt: startedAt, logSha256: hash(logs.get(id)!) })),
  }
  const validate = () => validateLocalCiManifest(manifest, identity, id => logs.get(id)!)
  return { identity, logs, manifest, validate }
}

describe('exact-source local release CI evidence', () => {
  it('is an explicit alternate to the default private-CI path', () => {
    expect(parseArgs([]).localCiEvidence).toBeNull()
    expect(parseArgs(['--local-ci-evidence', 'private-proof']).localCiEvidence).toBe(path.resolve('private-proof'))
  })

  it('accepts the complete trusted-operator manifest with the declared Mac coverage', () => {
    expect(fixture().validate).not.toThrow()
  })

  it.each(['commit', 'version', 'lock'] as const)('rejects a different %s', drift => {
    const { manifest, validate } = fixture()
    if (drift === 'commit') manifest.identity.source.sourceCommit = 'd'.repeat(40)
    if (drift === 'version') manifest.identity.version = '0.2.94'
    if (drift === 'lock') manifest.identity.locks['client/package-lock.json'] = 'e'.repeat(64)
    expect(validate).toThrow(/source, version or lock files differ/)
  })

  it.each(['install-electron', 'health', 'ui-light', 'agent-performance'])('rejects a missing %s check', id => {
    const { manifest, validate } = fixture()
    manifest.checks = manifest.checks.filter(step => step.id !== id)
    expect(validate).toThrow(/missing or unexpected checks/)
  })

  it('rejects a changed log and a log copied from a different source even when rehashed', () => {
    const { logs, manifest, validate } = fixture()
    const id = 'cloud-security'
    logs.set(id, Buffer.from(logs.get(id)!.toString().replace(sourceCommit, 'd'.repeat(40))))
    expect(validate).toThrow(/check log differs: cloud-security/)
    manifest.checks.find(step => step.id === id)!.logSha256 = hash(logs.get(id)!)
    expect(validate).toThrow(/check log differs: cloud-security/)
  })

  it('requires every health check to pass even if the log hash matches', () => {
    const { logs, manifest, validate } = fixture()
    logs.set('health', Buffer.from(logs.get('health')!.toString().replace('| root test | PASS |', '| root test | FAIL |')))
    manifest.checks.find(step => step.id === 'health')!.logSha256 = hash(logs.get('health')!)
    expect(validate).toThrow(/health log is missing required PASS results/)
  })

  it('rejects a nonzero step and a false claim of Linux matrix coverage', () => {
    const { manifest, validate } = fixture()
    manifest.checks[0].exitCode = 1
    expect(validate).toThrow(/local check did not pass/)
    manifest.checks[0].exitCode = 0
    manifest.platform.linuxMatrix = 'passed'
    expect(validate).toThrow(/misstates workflow coverage/)
  })

  it('rejects replacement receipt bytes even when the replacement claims the same source and build', () => {
    const provenance = { sourceCommit, buildManifestSha256: 'b'.repeat(64) }
    const first = Buffer.from(JSON.stringify({ provenance, measurement: 1 }))
    const replacement = Buffer.from(JSON.stringify({ provenance, measurement: 2 }))
    expect(readBoundLocalCiReceipt(first, hash(first))).toEqual({ provenance, measurement: 1 })
    expect(() => readBoundLocalCiReceipt(replacement, hash(first))).toThrow(/receipt digest mismatch/)
    const { manifest, validate } = fixture()
    Reflect.deleteProperty(manifest.receipts, 'dark')
    expect(validate).toThrow(/receipt set differs/)
  })

  it('seals default-mode collector output without changing the receipt bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-output-test-'))
    try {
      const file = path.join(dir, 'agent-integration-performance.json')
      const result = { measurement: 1 }
      const bytes = Buffer.from(JSON.stringify(result))
      const producer = spawnSync(process.execPath, ['-e',
        'process.umask(0o022); require("node:fs").writeFileSync(process.argv[1], process.argv[2], { flag: "wx" })',
        file, bytes.toString()])
      expect(producer.status).toBe(0)
      expect(fs.statSync(file).mode & 0o777).toBe(0o644)
      expect(readBoundLocalCiReceipt(sealLocalCiOutput(file), hash(bytes))).toEqual(result)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects linked collector output before changing the target mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-output-link-test-'))
    try {
      const target = path.join(dir, 'target')
      const symlink = path.join(dir, 'symlink')
      const hardlink = path.join(dir, 'hardlink')
      fs.writeFileSync(target, '{}')
      fs.chmodSync(target, 0o644)
      fs.symlinkSync(target, symlink)
      fs.linkSync(target, hardlink)
      expect(() => sealLocalCiOutput(symlink)).toThrow()
      expect(() => sealLocalCiOutput(hardlink)).toThrow(/regular collector output with one link/)
      expect(fs.statSync(target).mode & 0o777).toBe(0o644)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('starts from an allowlist with isolated HOME, temp paths and npm configs', () => {
    const blocked = ['DATABASE_URL', 'TEST_DATABASE_URL', 'SIGNING_PRIVATE_KEY', 'GH_TOKEN', 'ELECTRON_OVERRIDE_DIST_PATH']
    try {
      for (const key of blocked) vi.stubEnv(key, 'synthetic-secret')
      const env = localCiEnvironment(sourceCommit, '/isolated/home', '/isolated/tmp', '/opt/homebrew/bin')
      expect(env).toMatchObject({ HOME: '/isolated/home', TMPDIR: '/isolated/tmp', XDG_CONFIG_HOME: '/isolated/home/.config',
        NPM_CONFIG_USERCONFIG: '/isolated/home/npmrc-user', NPM_CONFIG_GLOBALCONFIG: '/isolated/home/npmrc-global' })
      for (const key of blocked) expect(env).not.toHaveProperty(key)
    } finally { vi.unstubAllEnvs() }
  })

  it.skipIf(process.platform !== 'darwin')('uses a private macOS temp root that the CLI trusts without inherited TMPDIR', async () => {
    const moduleUrl = new URL('../../scripts/local-release-ci.mjs', import.meta.url).href
    const processResult = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { createLocalCiScratch } = await import(process.argv[1]); process.stdout.write(createLocalCiScratch())', moduleUrl],
    { encoding: 'utf8', env: {} })
    expect(processResult.status, processResult.stderr).toBe(0)
    const scratch = processResult.stdout
    try {
      const systemTemp = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: {} })
      expect(systemTemp.status).toBe(0)
      expect(path.dirname(scratch)).toBe(fs.realpathSync(systemTemp.stdout.trim()))
      expect(fs.statSync(scratch).mode & 0o777).toBe(0o700)
      const home = path.join(scratch, 'home')
      fs.mkdirSync(home, { mode: 0o700 })
      const executable = path.join(home, 'codex')
      fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
      const resolved = await resolveCli({
        kind: 'codex', candidates: [executable], homeDir: home, env: { HOME: home },
        exec: async () => ({ stdout: 'codex-cli 0.156.1', stderr: '' }),
      })
      expect(resolved.path).toBe(executable)
    } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
  })

  it('allows ordinary dotenv examples and rejects environment files in each package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-env-test-'))
    try {
      const dirs = [root, path.join(root, 'client'), path.join(root, 'pro/cloud-server'), path.join(root, 'pro/website')]
      for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, '.env.example'), 'SYNTHETIC=example')
      }
      expect(() => assertNoLocalCiEnvironmentFiles(root)).not.toThrow()
      for (const dir of dirs) {
        const dotenv = path.join(dir, '.env.production.local')
        fs.writeFileSync(dotenv, 'DATABASE_URL=synthetic')
        expect(() => assertNoLocalCiEnvironmentFiles(root)).toThrow(/refuses environment files/)
        fs.unlinkSync(dotenv)
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('runs the official installer entry point before reading a fresh Electron distribution', () => {
    const client = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-electron-test-'))
    try {
      const pkg = path.join(client, 'node_modules', 'electron')
      const executable = 'Electron.app/Contents/MacOS/Electron'
      const electron = path.join(pkg, 'dist', executable)
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '43.8.7' }))
      fs.writeFileSync(path.join(pkg, 'abi_version'), '148\n')
      fs.writeFileSync(path.join(pkg, 'install.js'), `
        const fs = require('node:fs');
        const path = require('node:path');
        const executable = ${JSON.stringify(executable)};
        const binary = path.join(__dirname, 'dist', executable);
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, 'synthetic Electron');
        fs.writeFileSync(path.join(__dirname, 'path.txt'), executable);
      `)
      expect(fs.existsSync(path.join(pkg, 'path.txt'))).toBe(false)
      expect(fs.existsSync(electron)).toBe(false)
      const run = vi.fn((_id: string, command: string, args: string[], cwd: string) => {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('')
      })
      expect(installLocalCiElectron(client, '43.8.7', run)).toEqual({ electron, electronAbi: '148' })
      expect(run).toHaveBeenCalledExactlyOnceWith('install-electron', process.execPath, ['node_modules/electron/install.js'], client)
      expect(fs.readFileSync(electron, 'utf8')).toBe('synthetic Electron')
    } finally { fs.rmSync(client, { recursive: true, force: true }) }
  })

  it.each([
    { electron: '43.8.4' },
    { arch: 'x64' },
    { platform: 'linux' },
    { modules: '147' },
  ])('rejects a mismatched real Electron runtime probe', mismatch => {
    const probe = { electron: '43.8.7', modules: '148', arch: 'arm64', platform: 'darwin', ...mismatch }
    expect(() => validateLocalElectronProbe(probe, '43.8.7', '148')).toThrow(/runtime version, architecture or ABI differs/)
  })
})
