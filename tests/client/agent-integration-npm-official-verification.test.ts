import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { ensureAgentIntegrationSchema } from '../../src/db/agent-integration-schema.js'
import {
  NPM_OFFICIAL_VERIFIER_VERSION,
  createSqliteNpmOfficialVerificationCache,
  isOfficialNpmTarballUrl,
  npmRegistryVersionUrl,
  verifyNpmOfficialDistribution,
  type NpmOfficialVerificationFetch,
  type NpmOfficialVerificationInput,
} from '../../client/electron/agent-integration/npm-official-verification'
import {
  createPassiveVersionFileSystem,
  extractNpmTarballSafely,
} from '../../client/electron/agent-integration/npm-tarball-staging'
import { inspectPassiveCliVersionForArchitecture } from '../../client/electron/agent-integration/passive-cli-version'

const IO_TIMEOUT = 30_000
const ARCH = 'arm64' as const
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-official-verify-test-')))
  roots.push(root)
  return root
}

// ---------------------------------------------------------------------------
// In-test tar.gz writer (ustar + pax path records) so every entry is explicit.
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string
  type?: string
  mode?: number
  data?: Buffer | string
  linkname?: string
}

function tarHeader(name: string, size: number, mode: number, type: string, linkname = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1')
  block.write('0000000\0', 108, 8, 'latin1')
  block.write('0000000\0', 116, 8, 'latin1')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1')
  block.write('00000000000\0', 136, 12, 'latin1')
  block.fill(0x20, 148, 156)
  block.write(type, 156, 1, 'latin1')
  block.write(linkname, 157, 100, 'utf8')
  block.write('ustar\0', 257, 6, 'latin1')
  block.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return block
}

function padded(data: Buffer): Buffer {
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([data, Buffer.alloc(padding)])
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
  return Buffer.from(`${length}${body}`, 'utf8')
}

function tarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const type = entry.type ?? '0'
    let headerName = entry.name
    if (Buffer.byteLength(entry.name) > 100) {
      const pax = paxRecord('path', entry.name)
      parts.push(tarHeader('PaxHeader/long', pax.length, 0o644, 'x'), padded(pax))
      headerName = entry.name.slice(0, 99)
    }
    parts.push(tarHeader(headerName, type === '0' ? data.length : 0, entry.mode ?? 0o644, type, entry.linkname))
    if (type === '0' && data.length > 0) parts.push(padded(data))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

// ---------------------------------------------------------------------------
// Fake registry.npmjs.org served through an injected fetch.
// ---------------------------------------------------------------------------

interface Published {
  tarball: Buffer
  document: Record<string, unknown>
}

function officialTarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
}

function createFakeRegistry() {
  const documents = new Map<string, Published>()
  const tarballs = new Map<string, Buffer>()
  const requests: string[] = []
  const state = { offline: false, hang: false, failStatus: 0 }
  const fetch: NpmOfficialVerificationFetch = async (url, init) => {
    requests.push(url)
    if (state.offline) throw new TypeError('fetch failed')
    if (state.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (state.failStatus) return new Response('failure', { status: state.failStatus })
    expect(init.redirect).toBe('manual')
    const published = documents.get(url)
    if (published) {
      return new Response(JSON.stringify(published.document), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const tarball = tarballs.get(url)
    if (tarball) return new Response(new Uint8Array(tarball), { status: 200 })
    return new Response('{"error":"not found"}', { status: 404 })
  }
  return {
    fetch,
    requests,
    state,
    publish(name: string, version: string, tarball: Buffer, overrides: {
      integrity?: string
      tarballUrl?: string
      documentName?: string
    } = {}) {
      const tarballUrl = overrides.tarballUrl ?? officialTarballUrl(name, version)
      documents.set(npmRegistryVersionUrl(name, version), {
        tarball,
        document: {
          name: overrides.documentName ?? name,
          version,
          dist: { integrity: overrides.integrity ?? sri(tarball), tarball: tarballUrl },
        },
      })
      tarballs.set(tarballUrl, tarball)
    },
  }
}

// ---------------------------------------------------------------------------
// Local "npm install" written by hand (independent of the staging module).
// ---------------------------------------------------------------------------

interface LocalPackage {
  installName: string
  version: string
  integrity: string
  files: Record<string, { data: string | Buffer; mode?: number }>
}

function writeLocalInstall(root: string, packages: readonly LocalPackage[]): string {
  const nodeModules = path.join(root, 'lib', 'node_modules')
  fs.mkdirSync(nodeModules, { recursive: true, mode: 0o755 })
  const lock: { lockfileVersion: number; packages: Record<string, unknown> } = { lockfileVersion: 3, packages: {} }
  for (const pkg of packages) {
    const packageRoot = path.join(nodeModules, ...pkg.installName.split('/'))
    for (const [relative, file] of Object.entries(pkg.files)) {
      const target = path.join(packageRoot, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      fs.writeFileSync(target, file.data, { mode: file.mode ?? 0o644 })
      fs.chmodSync(target, file.mode ?? 0o644)
    }
    lock.packages[`node_modules/${pkg.installName}`] = { version: pkg.version, integrity: pkg.integrity }
  }
  fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify(lock), { mode: 0o644 })
  return nodeModules
}

async function localFingerprint(executable: string): Promise<string> {
  const result = await inspectPassiveCliVersionForArchitecture(
    executable, createPassiveVersionFileSystem(), ARCH,
  )
  expect(result.exitCode).toBe(0)
  expect(result.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
  return result.portableArtifactFingerprint!
}

const KIMI = '@moonshot-ai/kimi-code'
const KIMI_VERSION = '0.99.0'

function kimiFiles(overrides: Record<string, string> = {}) {
  return {
    'package.json': { data: JSON.stringify({ name: KIMI, version: KIMI_VERSION, bin: { kimi: 'bin/kimi.js' } }) },
    'bin/kimi.js': { data: '#!/usr/bin/env node\nrequire("../lib/index.js")\n', mode: 0o755 },
    'lib/index.js': { data: overrides['lib/index.js'] ?? 'module.exports = "星海科技"\n' },
    'README.md': { data: '# DataPilot fixture\n' },
  }
}

function kimiTarball(): Buffer {
  const files = kimiFiles()
  return tarGz([
    { name: 'package/', type: '5', mode: 0o755 },
    { name: 'package/package.json', data: files['package.json'].data },
    { name: 'package/bin/', type: '5', mode: 0o755 },
    { name: 'package/bin/kimi.js', data: files['bin/kimi.js'].data, mode: 0o755 },
    { name: 'package/lib/index.js', data: files['lib/index.js'].data },
    { name: 'package/README.md', data: files['README.md'].data },
  ])
}

async function kimiScenario(options: { localOverrides?: Record<string, string> } = {}) {
  const root = tempRoot()
  const registry = createFakeRegistry()
  const tarball = kimiTarball()
  registry.publish(KIMI, KIMI_VERSION, tarball)
  const nodeModules = writeLocalInstall(path.join(root, 'prefix'), [{
    installName: KIMI, version: KIMI_VERSION, integrity: sri(tarball), files: kimiFiles(options.localOverrides),
  }])
  const fingerprint = await localFingerprint(path.join(nodeModules, '@moonshot-ai', 'kimi-code', 'bin', 'kimi.js'))
  const db = new Database(':memory:')
  ensureAgentIntegrationSchema(db)
  const input: NpmOfficialVerificationInput = {
    catalogId: 'kimi-code-cli',
    distributionId: 'cli:kimi-code-cli',
    packageProvenance: `npm_metadata:${KIMI}`,
    version: KIMI_VERSION,
    architecture: ARCH,
    localPortableArtifactFingerprint: fingerprint,
    portableFingerprintSchema: 'npm-owned-package-surface-v1',
  }
  const stagingParent = path.join(root, 'staging')
  fs.mkdirSync(stagingParent, { mode: 0o700 })
  let clock = Date.parse('2026-09-25T08:00:00.000Z')
  const deps = {
    fetch: registry.fetch,
    db,
    tempRoot: stagingParent,
    now: () => clock,
  }
  return {
    root, registry, tarball, db, input, deps, stagingParent,
    advance(ms: number) { clock += ms },
    cacheRows: () => db.prepare('SELECT * FROM agent_npm_official_verifications').all() as Array<Record<string, unknown>>,
  }
}

describe('npm official registry verification', () => {
  it('verifies an exact unlisted version against the official tarball and then serves it from cache', async () => {
    const scenario = await kimiScenario()
    const first = await verifyNpmOfficialDistribution(scenario.input, scenario.deps)
    expect(first).toEqual({
      status: 'verified',
      officialFingerprint: scenario.input.localPortableArtifactFingerprint,
      checkedAt: '2026-09-25T08:00:00.000Z',
      evidence: 'registry',
    })
    expect(scenario.registry.requests).toEqual([
      'https://registry.npmjs.org/@moonshot-ai%2fkimi-code/0.99.0',
      officialTarballUrl(KIMI, KIMI_VERSION),
    ])
    const rows = scenario.cacheRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distribution_id: 'cli:kimi-code-cli',
      package_provenance: `npm_metadata:${KIMI}`,
      version: KIMI_VERSION,
      architecture: ARCH,
      local_portable_fingerprint: scenario.input.localPortableArtifactFingerprint,
      verifier_version: NPM_OFFICIAL_VERIFIER_VERSION,
      status: 'verified',
    })
    expect(JSON.parse(rows[0]!.evidence_json as string).packages[0]).toMatchObject({
      role: 'root', packageName: KIMI, integrity: sri(scenario.tarball),
    })
    // The private staging directory is removed in finally.
    expect(fs.readdirSync(scenario.stagingParent)).toEqual([])

    scenario.advance(90 * 24 * 60 * 60 * 1000)
    scenario.registry.requests.length = 0
    const second = await verifyNpmOfficialDistribution(scenario.input, scenario.deps)
    expect(second).toEqual({ ...first, evidence: 'cache' })
    expect(scenario.registry.requests).toEqual([])
  }, IO_TIMEOUT)

  it('uses the verified cache while offline and reports offline without one', async () => {
    const scenario = await kimiScenario()
    expect((await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).status).toBe('verified')
    scenario.registry.state.offline = true
    expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).toMatchObject({
      status: 'verified', evidence: 'cache', checkedAt: '2026-09-25T08:00:00.000Z',
    })

    const fresh = await kimiScenario()
    fresh.registry.state.offline = true
    expect(await verifyNpmOfficialDistribution(fresh.input, fresh.deps)).toMatchObject({
      status: 'unavailable', reason: 'offline',
    })
    expect(fresh.cacheRows()).toEqual([])
  }, IO_TIMEOUT)

  it('reports a mismatch when the local package content differs from the official tarball', async () => {
    const genuine = await kimiScenario()
    const tampered = await kimiScenario({ localOverrides: { 'lib/index.js': 'module.exports = "tampered"\n' } })
    expect(tampered.input.localPortableArtifactFingerprint).not.toBe(genuine.input.localPortableArtifactFingerprint)
    const result = await verifyNpmOfficialDistribution(tampered.input, tampered.deps)
    expect(result).toEqual({
      status: 'mismatch',
      officialFingerprint: genuine.input.localPortableArtifactFingerprint,
      checkedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(tampered.cacheRows()).toEqual([expect.objectContaining({ status: 'mismatch' })])

    // Cached with its time; re-checked online only after the TTL.
    tampered.registry.requests.length = 0
    expect((await verifyNpmOfficialDistribution(tampered.input, tampered.deps)).status).toBe('mismatch')
    expect(tampered.registry.requests).toEqual([])
    tampered.advance(25 * 60 * 60 * 1000)
    tampered.registry.state.offline = true
    expect(await verifyNpmOfficialDistribution(tampered.input, tampered.deps)).toMatchObject({
      status: 'mismatch', checkedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(tampered.registry.requests).toHaveLength(1)
  }, IO_TIMEOUT)

  it('rejects a tarball whose bytes do not match the registry sha512 integrity', async () => {
    const scenario = await kimiScenario()
    scenario.registry.publish(KIMI, KIMI_VERSION, scenario.tarball, { integrity: sri(Buffer.from('other bytes')) })
    expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).toMatchObject({
      status: 'unavailable', reason: 'integrity_mismatch',
    })
    expect(scenario.cacheRows()).toEqual([])
  }, IO_TIMEOUT)

  it('requires sha512 integrity and a same-origin tarball URL bound to the package name', async () => {
    for (const tarballUrl of [
      `https://evil.example.com/${KIMI}/-/kimi-code-${KIMI_VERSION}.tgz`,
      `http://registry.npmjs.org/${KIMI}/-/kimi-code-${KIMI_VERSION}.tgz`,
      `https://registry.npmjs.org/other-package/-/other-package-${KIMI_VERSION}.tgz`,
      `https://registry.npmjs.org/${KIMI}/-/kimi-code-0.98.0.tgz`,
      `${officialTarballUrl(KIMI, KIMI_VERSION)}?redirect=https://evil.example.com`,
      `https://user@registry.npmjs.org/${KIMI}/-/kimi-code-${KIMI_VERSION}.tgz`,
    ]) {
      const scenario = await kimiScenario()
      scenario.registry.publish(KIMI, KIMI_VERSION, scenario.tarball, { tarballUrl })
      expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps), tarballUrl).toMatchObject({
        status: 'unavailable', reason: 'protocol', detail: 'registry_tarball_url_not_official',
      })
      expect(scenario.registry.requests).toHaveLength(1)
    }
    const sha1 = await kimiScenario()
    sha1.registry.publish(KIMI, KIMI_VERSION, sha1.tarball, { integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
    expect(await verifyNpmOfficialDistribution(sha1.input, sha1.deps)).toMatchObject({
      status: 'unavailable', reason: 'protocol', detail: 'registry_integrity_not_sha512',
    })
    const renamed = await kimiScenario()
    renamed.registry.publish(KIMI, KIMI_VERSION, renamed.tarball, { documentName: '@moonshot-ai/kimi-code-fork' })
    expect(await verifyNpmOfficialDistribution(renamed.input, renamed.deps)).toMatchObject({
      status: 'unavailable', reason: 'protocol', detail: 'registry_metadata_identity_mismatch',
    })
    expect(isOfficialNpmTarballUrl(officialTarballUrl(KIMI, KIMI_VERSION), KIMI, KIMI_VERSION)).toBe(true)
  }, IO_TIMEOUT)

  it('enforces metadata, tarball and extraction size limits', async () => {
    const tarballLimit = await kimiScenario()
    expect(await verifyNpmOfficialDistribution(tarballLimit.input, {
      ...tarballLimit.deps, limits: { maxTarballBytes: 64 },
    })).toMatchObject({ status: 'unavailable', reason: 'too_large' })

    const metadataLimit = await kimiScenario()
    expect(await verifyNpmOfficialDistribution(metadataLimit.input, {
      ...metadataLimit.deps, limits: { maxMetadataBytes: 16 },
    })).toMatchObject({ status: 'unavailable', reason: 'too_large' })

    const unpackedLimit = await kimiScenario()
    expect(await verifyNpmOfficialDistribution(unpackedLimit.input, {
      ...unpackedLimit.deps, limits: { extraction: { maxUnpackedBytes: 32 } },
    })).toMatchObject({ status: 'unavailable', reason: 'too_large' })

    const entryLimit = await kimiScenario()
    expect(await verifyNpmOfficialDistribution(entryLimit.input, {
      ...entryLimit.deps, limits: { extraction: { maxEntries: 3 } },
    })).toMatchObject({ status: 'unavailable', reason: 'too_large' })
    expect(entryLimit.cacheRows()).toEqual([])
    expect(fs.readdirSync(entryLimit.stagingParent)).toEqual([])
  }, IO_TIMEOUT)

  it('maps HTTP failures and request timeouts to unavailable', async () => {
    const httpFailure = await kimiScenario()
    httpFailure.registry.state.failStatus = 503
    expect(await verifyNpmOfficialDistribution(httpFailure.input, httpFailure.deps)).toMatchObject({
      status: 'unavailable', reason: 'http_error', detail: 'http_503',
    })
    const timeout = await kimiScenario()
    timeout.registry.state.hang = true
    expect(await verifyNpmOfficialDistribution(timeout.input, {
      ...timeout.deps, limits: { metadataTimeoutMs: 50 },
    })).toMatchObject({ status: 'unavailable', reason: 'timeout' })
  }, IO_TIMEOUT)

  it('bounds transports that ignore abort and permits a later verification', async () => {
    const scenario = await kimiScenario()
    const stalled: NpmOfficialVerificationFetch = () => new Promise(() => {})
    const result = await verifyNpmOfficialDistribution(scenario.input, {
      ...scenario.deps, fetch: stalled, limits: { metadataTimeoutMs: 30 },
    })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' })
    expect(scenario.cacheRows()).toEqual([])
    expect(fs.readdirSync(scenario.stagingParent)).toEqual([])
    expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps))
      .toMatchObject({ status: 'verified' })
  }, IO_TIMEOUT)

  it('bounds a stalled response body even when its cancellation never resolves', async () => {
    const scenario = await kimiScenario()
    let cancelled = false
    const stalled: NpmOfficialVerificationFetch = async () => new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => { cancelled = true; return new Promise(() => {}) },
    }))
    expect(await verifyNpmOfficialDistribution(scenario.input, {
      ...scenario.deps, fetch: stalled, limits: { metadataTimeoutMs: 30 },
    })).toMatchObject({ status: 'unavailable', reason: 'timeout' })
    expect(cancelled).toBe(true)
    expect(scenario.cacheRows()).toEqual([])
    expect(fs.readdirSync(scenario.stagingParent)).toEqual([])
  }, IO_TIMEOUT)

  it.each([
    ['parent traversal', [{ name: 'package/../escape.js', data: 'x' }]],
    ['absolute path', [{ name: '/tmp/escape.js', data: 'x' }]],
    ['outside package/', [{ name: 'other/escape.js', data: 'x' }]],
    ['symbolic link', [{ name: 'package/link', type: '2', linkname: '../../../../etc/passwd' }]],
    ['hard link', [{ name: 'package/hard', type: '1', linkname: 'package/package.json' }]],
    ['character device', [{ name: 'package/dev', type: '3' }]],
    ['FIFO', [{ name: 'package/fifo', type: '6' }]],
    ['duplicate path', [{ name: 'package/lib/index.js', data: 'second copy' }]],
    ['case-colliding path', [{ name: 'package/README.MD', data: 'collides on APFS' }]],
  ])('refuses a tarball with a %s entry without writing outside the stage', async (_label, extra) => {
    const scenario = await kimiScenario()
    const files = kimiFiles()
    const hostile = tarGz([
      { name: 'package/package.json', data: files['package.json'].data },
      { name: 'package/bin/kimi.js', data: files['bin/kimi.js'].data, mode: 0o755 },
      { name: 'package/lib/index.js', data: files['lib/index.js'].data },
      { name: 'package/README.md', data: files['README.md'].data },
      ...extra,
    ])
    scenario.registry.publish(KIMI, KIMI_VERSION, hostile)
    expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).toMatchObject({
      status: 'unavailable', reason: 'protocol',
    })
    expect(fs.existsSync(path.join(scenario.stagingParent, 'escape.js'))).toBe(false)
    expect(fs.existsSync(path.join(scenario.root, 'escape.js'))).toBe(false)
    expect(fs.readdirSync(scenario.stagingParent)).toEqual([])
    expect(scenario.cacheRows()).toEqual([])
  }, IO_TIMEOUT)

  it('rejects distributions whose installed tree cannot be reproduced statically', async () => {
    const base = {
      version: '1.0.0', architecture: ARCH, localPortableArtifactFingerprint: 'a'.repeat(64),
    }
    const registry = createFakeRegistry()
    const cases: Array<[Omit<NpmOfficialVerificationInput, keyof typeof base>, string]> = [
      [{ catalogId: 'openclaw-local', distributionId: 'cli:openclaw-local:portable-wrapper', packageProvenance: 'npm_metadata:openclaw' },
        'portable_wrapper_postinstall_not_statically_reproducible'],
      [{ catalogId: 'qwen-code-cli', distributionId: 'cli:qwen-code-cli:standalone', packageProvenance: 'npm_metadata:@qwen-code/qwen-code' },
        'standalone_archive_has_no_registry_integrity'],
      [{ catalogId: 'claude-code-native', distributionId: 'cli:claude-code-native', packageProvenance: 'signed_cli:anthropic:Q6L2SF6YDW' },
        'distribution_not_npm'],
      [{ catalogId: 'kimi-code-cli', distributionId: 'cli:kimi-code-cli', packageProvenance: 'npm_metadata:kimi-code' },
        'package_provenance_mismatch'],
      [{ catalogId: 'kimi-code-cli', distributionId: 'cli:gemini-cli', packageProvenance: 'npm_metadata:@google/gemini-cli' },
        'distribution_not_official'],
      [{ catalogId: 'opencode-v1-cli', distributionId: 'cli:opencode-v1-cli:darwin-x64', packageProvenance: 'npm_metadata:opencode-ai' },
        'architecture_not_supported'],
    ]
    for (const [identity, reason] of cases) {
      const result = await verifyNpmOfficialDistribution({ ...base, ...identity }, { fetch: registry.fetch })
      expect(result, reason).toEqual({ status: 'unsupported', reason })
    }
    expect(await verifyNpmOfficialDistribution({
      ...base, catalogId: 'kimi-code-cli', distributionId: 'cli:kimi-code-cli',
      packageProvenance: `npm_metadata:${KIMI}`, localPortableArtifactFingerprint: 'not-a-digest',
    }, { fetch: registry.fetch })).toEqual({ status: 'unsupported', reason: 'local_fingerprint_invalid' })
    expect(await verifyNpmOfficialDistribution({
      ...base, catalogId: 'kimi-code-cli', distributionId: 'cli:kimi-code-cli',
      packageProvenance: `npm_metadata:${KIMI}`, portableFingerprintSchema: 'npm-composed-platform-surface-v1',
    }, { fetch: registry.fetch })).toEqual({ status: 'unsupported', reason: 'portable_fingerprint_schema_mismatch' })
    expect(registry.requests).toEqual([])
  }, IO_TIMEOUT)
})

describe('npm official verification of composed platform packages', () => {
  const ROOT = '@anthropic-ai/claude-code'
  const LEAF = `@anthropic-ai/claude-code-darwin-${ARCH}`
  const VERSION = '2.2.0'
  const BINARY = Buffer.from('\xcf\xfa\xed\xfe fake native claude executable for DataPilot\n', 'latin1')
  const rootManifest = JSON.stringify({
    name: ROOT, version: VERSION, bin: { claude: 'bin/claude.exe' },
    scripts: { postinstall: 'node install.cjs' },
    optionalDependencies: { [LEAF]: VERSION },
  })
  const leafManifest = JSON.stringify({ name: LEAF, version: VERSION, os: ['darwin'], cpu: [ARCH] })
  const rootTarball = tarGz([
    { name: 'package/package.json', data: rootManifest },
    { name: 'package/bin/claude.exe', data: 'official placeholder, replaced by postinstall', mode: 0o644 },
    { name: 'package/install.cjs', data: 'throw new Error("must never execute")\n' },
  ])
  const leafTarball = tarGz([
    { name: 'package/package.json', data: leafManifest },
    { name: 'package/claude', data: BINARY, mode: 0o755 },
  ])

  async function composedScenario() {
    const root = tempRoot()
    const registry = createFakeRegistry()
    registry.publish(ROOT, VERSION, rootTarball)
    registry.publish(LEAF, VERSION, leafTarball)
    const nodeModules = writeLocalInstall(path.join(root, 'prefix'), [
      {
        installName: ROOT, version: VERSION, integrity: sri(rootTarball),
        files: {
          'package.json': { data: rootManifest },
          'bin/claude.exe': { data: BINARY, mode: 0o755 },
          'install.cjs': { data: 'throw new Error("must never execute")\n' },
        },
      },
      {
        installName: LEAF, version: VERSION, integrity: sri(leafTarball),
        files: { 'package.json': { data: leafManifest }, claude: { data: BINARY, mode: 0o755 } },
      },
    ])
    const fingerprint = await localFingerprint(path.join(nodeModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
    const stagingParent = path.join(root, 'staging')
    fs.mkdirSync(stagingParent, { mode: 0o700 })
    return {
      registry,
      stagingParent,
      input: {
        catalogId: 'claude-code-cli',
        distributionId: 'cli:claude-code-cli',
        packageProvenance: `npm_metadata:${ROOT}`,
        version: VERSION,
        architecture: ARCH,
        localPortableArtifactFingerprint: fingerprint,
      } satisfies NpmOfficialVerificationInput,
      deps: { fetch: registry.fetch, tempRoot: stagingParent, now: () => Date.parse('2026-09-25T09:00:00.000Z') },
    }
  }

  it('fetches and verifies every component of the exact composed topology', async () => {
    const scenario = await composedScenario()
    expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).toEqual({
      status: 'verified',
      officialFingerprint: scenario.input.localPortableArtifactFingerprint,
      checkedAt: '2026-09-25T09:00:00.000Z',
      evidence: 'registry',
    })
    expect(scenario.registry.requests).toEqual([
      npmRegistryVersionUrl(ROOT, VERSION),
      npmRegistryVersionUrl(LEAF, VERSION),
      officialTarballUrl(ROOT, VERSION),
      officialTarballUrl(LEAF, VERSION),
    ])
    expect(fs.readdirSync(scenario.stagingParent)).toEqual([])
  }, IO_TIMEOUT)

  it('cannot verify a composed package whose platform leaf is missing from the registry', async () => {
    const scenario = await composedScenario()
    const registry = createFakeRegistry()
    registry.publish(ROOT, VERSION, rootTarball)
    expect(await verifyNpmOfficialDistribution(scenario.input, { ...scenario.deps, fetch: registry.fetch }))
      .toMatchObject({ status: 'unavailable', reason: 'http_error', detail: 'http_404' })
    expect(registry.requests).toEqual([npmRegistryVersionUrl(ROOT, VERSION), npmRegistryVersionUrl(LEAF, VERSION)])
  }, IO_TIMEOUT)

  it('reports a mismatch when the official leaf binary differs from the local copy', async () => {
    const scenario = await composedScenario()
    const registry = createFakeRegistry()
    const otherLeaf = tarGz([
      { name: 'package/package.json', data: leafManifest },
      { name: 'package/claude', data: Buffer.concat([BINARY, Buffer.from('patched')]), mode: 0o755 },
    ])
    registry.publish(ROOT, VERSION, rootTarball)
    registry.publish(LEAF, VERSION, otherLeaf)
    const result = await verifyNpmOfficialDistribution(scenario.input, { ...scenario.deps, fetch: registry.fetch })
    expect(result.status).toBe('mismatch')
  }, IO_TIMEOUT)
})

describe('npm official verification of lockless (npm install -g) installs', () => {
  function writeLocklessPackage(packageRoot: string, files: Record<string, { data: string | Buffer; mode?: number }>) {
    for (const [relative, file] of Object.entries(files)) {
      const target = path.join(packageRoot, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      fs.writeFileSync(target, file.data, { mode: file.mode ?? 0o644 })
      fs.chmodSync(target, file.mode ?? 0o644)
    }
  }

  async function locklessKimiScenario(overrides: Record<string, string> = {}) {
    const root = tempRoot()
    const registry = createFakeRegistry()
    registry.publish(KIMI, KIMI_VERSION, kimiTarball())
    const nodeModules = path.join(root, 'prefix', 'lib', 'node_modules')
    fs.mkdirSync(nodeModules, { recursive: true, mode: 0o755 })
    const packageRoot = path.join(nodeModules, '@moonshot-ai', 'kimi-code')
    writeLocklessPackage(packageRoot, kimiFiles(overrides))
    // npm global installs keep their dependencies nested; they are not part of the identity.
    writeLocklessPackage(path.join(packageRoot, 'node_modules', 'dependency'), {
      'index.js': { data: 'module.exports = "nested dependency"\n' },
    })
    const stagingParent = path.join(root, 'staging')
    fs.mkdirSync(stagingParent, { mode: 0o700 })
    return {
      registry,
      stagingParent,
      executable: path.join(packageRoot, 'bin', 'kimi.js'),
      fingerprint: await localFingerprint(path.join(packageRoot, 'bin', 'kimi.js')),
      deps: { fetch: registry.fetch, tempRoot: stagingParent, now: () => Date.parse('2026-09-25T10:00:00.000Z') },
    }
  }

  const kimiInput = (fingerprint: string, portableFingerprintSchema?: string): NpmOfficialVerificationInput => ({
    catalogId: 'kimi-code-cli',
    distributionId: 'cli:kimi-code-cli',
    packageProvenance: `npm_metadata:${KIMI}`,
    version: KIMI_VERSION,
    architecture: ARCH,
    localPortableArtifactFingerprint: fingerprint,
    ...(portableFingerprintSchema ? { portableFingerprintSchema } : {}),
  })

  it('verifies the lockless surface only against the official tarball content', async () => {
    const genuine = await locklessKimiScenario()
    const lockedLocal = await kimiScenario()
    expect(genuine.fingerprint).not.toBe(lockedLocal.input.localPortableArtifactFingerprint)

    // Without a named schema both official surfaces are computed.
    expect(await verifyNpmOfficialDistribution(kimiInput(genuine.fingerprint), genuine.deps)).toEqual({
      status: 'verified',
      officialFingerprint: genuine.fingerprint,
      checkedAt: '2026-09-25T10:00:00.000Z',
      evidence: 'registry',
    })
    expect(fs.readdirSync(genuine.stagingParent)).toEqual([])
    expect(await verifyNpmOfficialDistribution(
      kimiInput(genuine.fingerprint, 'npm-owned-package-surface-lockless-v1'), genuine.deps,
    )).toMatchObject({ status: 'verified', officialFingerprint: genuine.fingerprint })
    // The locked surface of the same official package is a different digest.
    expect(await verifyNpmOfficialDistribution(
      kimiInput(genuine.fingerprint, 'npm-owned-package-surface-v1'), genuine.deps,
    )).toEqual({
      status: 'mismatch',
      officialFingerprint: lockedLocal.input.localPortableArtifactFingerprint,
      checkedAt: '2026-09-25T10:00:00.000Z',
    })
    // The locked local install still verifies exactly as before.
    expect(await verifyNpmOfficialDistribution(lockedLocal.input, lockedLocal.deps))
      .toMatchObject({ status: 'verified', officialFingerprint: lockedLocal.input.localPortableArtifactFingerprint })

    const tampered = await locklessKimiScenario({ 'lib/index.js': 'module.exports = "tampered"\n' })
    expect(tampered.fingerprint).not.toBe(genuine.fingerprint)
    expect(await verifyNpmOfficialDistribution(
      kimiInput(tampered.fingerprint, 'npm-owned-package-surface-lockless-v1'), tampered.deps,
    )).toEqual({ status: 'mismatch', officialFingerprint: genuine.fingerprint, checkedAt: '2026-09-25T10:00:00.000Z' })
    expect((await verifyNpmOfficialDistribution(kimiInput(tampered.fingerprint), tampered.deps)).status).toBe('mismatch')
  }, IO_TIMEOUT)

  it('rejects a lockless schema name of the wrong topology before any request', async () => {
    const registry = createFakeRegistry()
    expect(await verifyNpmOfficialDistribution(
      kimiInput('a'.repeat(64), 'npm-composed-platform-surface-lockless-v1'), { fetch: registry.fetch },
    )).toEqual({ status: 'unsupported', reason: 'portable_fingerprint_schema_mismatch' })
    expect(registry.requests).toEqual([])
  }, IO_TIMEOUT)

  describe('composed Codex-style package', () => {
    const ROOT = '@openai/codex'
    const LEAF_INSTALL = `@openai/codex-darwin-${ARCH}`
    const VERSION = '0.157.0'
    const LEAF_VERSION = `${VERSION}-darwin-${ARCH}`
    const NATIVE = Buffer.from('\xcf\xfa\xed\xfe fake native codex for 星海科技\n', 'latin1')
    const rootManifest = JSON.stringify({
      name: ROOT, version: VERSION, bin: { codex: 'bin/codex.js' },
      optionalDependencies: { [LEAF_INSTALL]: `npm:${ROOT}@${LEAF_VERSION}` },
    })
    const leafManifest = JSON.stringify({ name: ROOT, version: LEAF_VERSION, os: ['darwin'], cpu: [ARCH] })
    const entry = '#!/usr/bin/env node\n// resolves @openai/codex-darwin-arm64\n'
    const rootTarball = tarGz([
      { name: 'package/package.json', data: rootManifest },
      { name: 'package/bin/codex.js', data: entry, mode: 0o755 },
      { name: 'package/README.md', data: '# DataPilot\n' },
    ])
    const leafTarball = (native: Buffer) => tarGz([
      { name: 'package/package.json', data: leafManifest },
      { name: 'package/vendor/aarch64-apple-darwin/bin/codex', data: native, mode: 0o755 },
      { name: 'package/vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh', data: 'zsh\n', mode: 0o755 },
    ])

    async function codexScenario(layout: 'nested' | 'hoisted', localNative = NATIVE) {
      const root = tempRoot()
      const registry = createFakeRegistry()
      registry.publish(ROOT, VERSION, rootTarball)
      registry.publish(ROOT, LEAF_VERSION, leafTarball(NATIVE))
      const nodeModules = path.join(root, 'prefix', 'lib', 'node_modules')
      fs.mkdirSync(nodeModules, { recursive: true, mode: 0o755 })
      const packageRoot = path.join(nodeModules, '@openai', 'codex')
      writeLocklessPackage(packageRoot, {
        'package.json': { data: rootManifest },
        'bin/codex.js': { data: entry, mode: 0o755 },
        'README.md': { data: '# DataPilot\n' },
      })
      const leafRoot = layout === 'nested'
        ? path.join(packageRoot, 'node_modules', '@openai', `codex-darwin-${ARCH}`)
        : path.join(nodeModules, '@openai', `codex-darwin-${ARCH}`)
      writeLocklessPackage(leafRoot, {
        'package.json': { data: leafManifest },
        'vendor/aarch64-apple-darwin/bin/codex': { data: localNative, mode: 0o755 },
        'vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh': { data: 'zsh\n', mode: 0o755 },
      })
      const stagingParent = path.join(root, 'staging')
      fs.mkdirSync(stagingParent, { mode: 0o700 })
      return {
        registry,
        stagingParent,
        input: {
          catalogId: 'codex-cli',
          distributionId: 'cli:codex-cli',
          packageProvenance: `npm_metadata:${ROOT}`,
          version: VERSION,
          architecture: ARCH,
          localPortableArtifactFingerprint: await localFingerprint(path.join(packageRoot, 'bin', 'codex.js')),
        } satisfies NpmOfficialVerificationInput,
        deps: { fetch: registry.fetch, tempRoot: stagingParent, now: () => Date.parse('2026-09-25T11:00:00.000Z') },
      }
    }

    it.each(['nested', 'hoisted'] as const)('verifies a lockless %s install against the official root and leaf', async layout => {
      const scenario = await codexScenario(layout)
      expect(await verifyNpmOfficialDistribution(scenario.input, scenario.deps)).toEqual({
        status: 'verified',
        officialFingerprint: scenario.input.localPortableArtifactFingerprint,
        checkedAt: '2026-09-25T11:00:00.000Z',
        evidence: 'registry',
      })
      expect(scenario.registry.requests).toEqual([
        npmRegistryVersionUrl(ROOT, VERSION),
        npmRegistryVersionUrl(ROOT, LEAF_VERSION),
        officialTarballUrl(ROOT, VERSION),
        officialTarballUrl(ROOT, LEAF_VERSION),
      ])
      expect(fs.readdirSync(scenario.stagingParent)).toEqual([])
    }, IO_TIMEOUT)

    it('reports a mismatch when the local lockless leaf differs from the official one', async () => {
      const genuine = await codexScenario('nested')
      const tampered = await codexScenario('nested', Buffer.concat([NATIVE, Buffer.from('patched')]))
      expect(tampered.input.localPortableArtifactFingerprint).not.toBe(genuine.input.localPortableArtifactFingerprint)
      expect(await verifyNpmOfficialDistribution(
        { ...tampered.input, portableFingerprintSchema: 'npm-composed-platform-surface-lockless-v1' }, tampered.deps,
      )).toEqual({
        status: 'mismatch',
        officialFingerprint: genuine.input.localPortableArtifactFingerprint,
        checkedAt: '2026-09-25T11:00:00.000Z',
      })
    }, IO_TIMEOUT)
  })
})

describe('safe npm tarball extraction', () => {
  async function extract(entries: TarEntry[]) {
    const root = tempRoot()
    const tarball = path.join(root, 'input.tgz')
    fs.writeFileSync(tarball, tarGz(entries))
    const destination = path.join(root, 'out')
    fs.mkdirSync(destination, { mode: 0o700 })
    return { root, destination, result: await extractNpmTarballSafely(tarball, destination) }
  }

  it('applies npm install semantics for modes, pax paths, .gitignore and AppleDouble members', async () => {
    const longName = `package/${'deep/'.repeat(25)}file.js`
    const { destination, result } = await extract([
      { name: '._package', data: Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07]), Buffer.alloc(60)]) },
      { name: 'package/package.json', data: '{"name":"fixture","version":"1.0.0"}', mode: 0o666 },
      { name: 'package/tool.sh', data: '#!/bin/sh\n', mode: 0o4777 },
      { name: 'package/templates/.gitignore', data: 'node_modules\n' },
      { name: longName, data: 'long' },
      { name: 'package/._real', data: 'not apple double' },
    ])
    expect(result.fileCount).toBe(5)
    const packageRoot = path.join(destination, 'package')
    expect(fs.statSync(path.join(packageRoot, 'package.json')).mode & 0o7777).toBe(0o644)
    expect(fs.statSync(path.join(packageRoot, 'tool.sh')).mode & 0o7777).toBe(0o755)
    expect(fs.existsSync(path.join(packageRoot, 'templates', '.gitignore'))).toBe(false)
    expect(fs.readFileSync(path.join(packageRoot, 'templates', '.npmignore'), 'utf8')).toBe('node_modules\n')
    expect(fs.readFileSync(path.join(destination, ...longName.split('/')), 'utf8')).toBe('long')
    expect(fs.readFileSync(path.join(packageRoot, '._real'), 'utf8')).toBe('not apple double')
    expect(fs.existsSync(path.join(destination, '._package'))).toBe(false)
  }, IO_TIMEOUT)

  it('rejects link entries before creating them', async () => {
    const root = tempRoot()
    const tarball = path.join(root, 'input.tgz')
    fs.writeFileSync(tarball, tarGz([
      { name: 'package/package.json', data: '{}' },
      { name: 'package/escape', type: '2', linkname: '../../outside' },
    ]))
    const destination = path.join(root, 'out')
    fs.mkdirSync(destination, { mode: 0o700 })
    await expect(extractNpmTarballSafely(tarball, destination)).rejects.toThrow('npm_tarball_entry_type_forbidden')
    expect(fs.existsSync(path.join(destination, 'package', 'escape'))).toBe(false)
  }, IO_TIMEOUT)
})

describe('real registry smoke (opt-in)', () => {
  // TIDEMIND_NPM_OFFICIAL_VERIFY_SMOKE=1 re-derives frozen receipt fingerprints
  // from the live official registry. It downloads real packages; off by default.
  const enabled = process.env.TIDEMIND_NPM_OFFICIAL_VERIFY_SMOKE === '1'
  it.skipIf(!enabled)('reproduces frozen npm receipt fingerprints from registry.npmjs.org', async () => {
    const { AGENT_INTEGRATION_RELEASE_ENTRIES } = await import('../../client/electron/agent-integration/release-manifest')
    const only = process.env.TIDEMIND_NPM_OFFICIAL_VERIFY_SMOKE_DISTRIBUTIONS?.split(',').filter(Boolean)
    const receipts = AGENT_INTEGRATION_RELEASE_ENTRIES.flatMap(entry => entry.acceptedDistributionArtifacts
      .filter(receipt => receipt.packageProvenance.startsWith('npm_metadata:'))
      .filter(receipt => !only || only.includes(receipt.distributionId))
      .map(receipt => ({ entry, receipt })))
    const failures: string[] = []
    const verified: string[] = []
    for (const { entry, receipt } of receipts) {
      const result = await verifyNpmOfficialDistribution({
        catalogId: entry.catalogId,
        distributionId: receipt.distributionId,
        packageProvenance: receipt.packageProvenance,
        version: receipt.version,
        architecture: receipt.architecture,
        localPortableArtifactFingerprint: receipt.portableArtifactFingerprint,
        portableFingerprintSchema: receipt.portableFingerprintSchema,
      })
      const label = `${receipt.distributionId}@${receipt.version}/${receipt.architecture}`
      if (result.status === 'verified') verified.push(label)
      else if (result.status !== 'unsupported'
        || !['cli:openclaw-local:portable-wrapper', 'cli:qwen-code-cli:standalone'].includes(receipt.distributionId)) {
        failures.push(`${label}: ${JSON.stringify(result)}`)
      }
    }
    expect(failures).toEqual([])
    expect(verified.length).toBeGreaterThan(0)
  }, 1_800_000)
})
