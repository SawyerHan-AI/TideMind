import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const thresholds = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'scripts', 'agent-integration-performance-thresholds.json'),
  'utf8',
))

function timing(samplesMs = [1, 2, 3, 4, 5, 6, 7]) {
  return { samplesMs, p50: samplesMs[3], p95: samplesMs[6], max: samplesMs[6] }
}

function validResult() {
  const rowCounts = [{ table: 'metadata', rows: 2 }]
  return {
    protocolVersion: 1,
    measuredAt: '2026-08-26T00:00:00.000Z',
    fixture: {
      dataRoot: 'ephemeral-physical-sqlite-only',
      writesRealAgentConfiguration: false,
      probeCount: 18,
      probeOperationTimeoutMs: 20,
      probeWarmupRuns: 1,
      probeMeasuredRuns: 5,
      queryWarmupRuns: 2,
      queryMeasuredRuns: 7,
      scanRounds: 100,
      reconcileRounds: 100,
    },
    machine: { cpu: 'test', cpuCount: 8, os: 'test', arch: 'arm64', nodeVersion: 'v22.0.0' },
    discoveryTimeout: {
      timedOutCatalogCount: 18,
      timedOutCatalogIds: Array.from({ length: 18 }, (_, index) => `catalog-${index}`),
      wall: { samplesMs: [20, 21, 22, 23, 24], p50: 22, p95: 24, max: 24 },
    },
    queries: {
      '100-installations-10000-events': {
        installationCount: 100,
        eventCount: 10_000,
        snapshot: timing(), detail: timing(), events: timing(),
      },
      '1000-installations-100000-events': {
        installationCount: 1_000,
        eventCount: 100_000,
        snapshot: timing(), detail: timing(), events: timing(),
      },
    },
    taskFeed: {
      '10000-attention-full-traversal': {
        taskCount: 10_000,
        pageLimit: 50,
        traverseAll: true,
        pageCount: 200,
        returnedCount: 10_000,
        totalCount: 10_000,
        elapsedMs: 5_000,
        rssDeltaBytes: 64 * 1024 * 1024,
        physicalSqlite: true,
        writesRealAgentConfiguration: false,
      },
      '100000-attention-first-page': {
        taskCount: 100_000,
        pageLimit: 50,
        traverseAll: false,
        pageCount: 1,
        returnedCount: 50,
        totalCount: 100_000,
        elapsedMs: 500,
        rssDeltaBytes: 192 * 1024 * 1024,
        physicalSqlite: true,
        writesRealAgentConfiguration: false,
      },
    },
    stability: {
      scanRounds: 100,
      reconcileRounds: 100,
      finalOutstandingTimers: 0,
      maxOutstandingTimers: 17,
      databaseRowGrowth: 0,
      rowCountsBefore: rowCounts,
      rowCountsAfter: structuredClone(rowCounts),
      physicalSqlite: true,
      writesRealAgentConfiguration: false,
    },
  }
}

type ValidResult = ReturnType<typeof validResult>

const temporaryRepos: string[] = []
const fixtureSourceRoots = [
  'src',
  'client/src',
  'client/scripts',
  'client/electron',
  'client/public',
  'client/resources',
  'data',
]
const fixtureBuildRoots = [
  'dist',
  'client/out',
  'client/electron/native/secure-store-mac/build',
]

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

function gateRepository(): { root: string; commit: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-agent-gate-repo-'))
  temporaryRepos.push(root)
  fs.mkdirSync(path.join(root, 'client', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'client', 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'client', 'out'), { recursive: true })
  fs.mkdirSync(path.join(root, 'client', 'electron', 'native', 'secure-store-mac', 'build'), { recursive: true })
  fs.mkdirSync(path.join(root, 'client', 'public'), { recursive: true })
  fs.mkdirSync(path.join(root, 'client', 'resources'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, '.gitignore'), [
    'dist/',
    'client/out/',
    'client/src/*.js',
    'client/scripts/*.generated.mjs',
    'client/public/*.generated.js',
    'client/resources/*.generated.plist',
    'client/electron/native/secure-store-mac/build/',
    '.env*',
    'src/*.js',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'client', 'src', 'App.tsx'), 'export const app = true\n')
  fs.writeFileSync(path.join(root, 'client', 'scripts', 'build-bin.mjs'), 'export const build = true\n')
  fs.writeFileSync(path.join(root, 'client', 'electron', 'main.ts'), 'export const main = true\n')
  fs.writeFileSync(path.join(root, 'client', 'public', 'icon.png'), 'public-copy-v1\n')
  fs.writeFileSync(path.join(root, 'client', 'resources', 'entitlements.plist'), 'resource-v1\n')
  fs.writeFileSync(path.join(root, 'data', 'runtime.json'), '{"runtime":1}\n')
  fs.writeFileSync(
    path.join(root, 'client', 'electron', 'native', 'secure-store-mac', 'build', 'secure-store.node'),
    'native-build-v1\n',
  )
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const server = true\n')
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'root-build-v1\n')
  fs.writeFileSync(path.join(root, 'client', 'out', 'index.js'), 'client-build-v1\n')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'gate@example.invalid'])
  git(root, ['config', 'user.name', 'Gate Test'])
  git(root, [
    'add',
    '.gitignore',
    'src/index.ts',
    'client/src/App.tsx',
    'client/scripts/build-bin.mjs',
    'client/electron/main.ts',
    'client/public/icon.png',
    'client/resources/entitlements.plist',
    'data/runtime.json',
  ])
  git(root, ['commit', '-qm', 'fixture'])
  return { root, commit: git(root, ['rev-parse', 'HEAD']) }
}

afterEach(() => {
  for (const root of temporaryRepos.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Agent Integration deterministic performance gate', { timeout: 30_000 }, () => {
  it('accepts the complete internally bound result', async () => {
    const { evaluateAgentIntegrationPerformanceResult } = await import(
      '../../scripts/evaluate-agent-integration-performance-result.mjs'
    )
    expect(evaluateAgentIntegrationPerformanceResult({ result: validResult(), thresholds })).toEqual([])
  })

  it.each([
    ['missing P0 timeout', (result: ValidResult) => { result.discoveryTimeout.timedOutCatalogCount = 16 }],
    ['query threshold breach', (result: ValidResult) => {
      result.queries['1000-installations-100000-events'].snapshot.samplesMs = Array(7).fill(30_000)
      result.queries['1000-installations-100000-events'].snapshot.p50 = 30_000
      result.queries['1000-installations-100000-events'].snapshot.p95 = 30_000
      result.queries['1000-installations-100000-events'].snapshot.max = 30_000
    }],
    ['unbound percentile', (result: ValidResult) => { result.queries['100-installations-10000-events'].detail.p95 = 0 }],
    ['timer leak', (result: ValidResult) => { result.stability.finalOutstandingTimers = 1 }],
    ['database growth', (result: ValidResult) => {
      result.stability.databaseRowGrowth = 1
      result.stability.rowCountsAfter[0].rows = 3
    }],
    ['non-physical database', (result: ValidResult) => { result.stability.physicalSqlite = false }],
    ['task feed traversal cardinality', (result: ValidResult) => {
      result.taskFeed['10000-attention-full-traversal'].returnedCount = 9_999
    }],
    ['task feed RSS threshold', (result: ValidResult) => {
      result.taskFeed['100000-attention-first-page'].rssDeltaBytes = 1024 * 1024 * 1024
    }],
  ])('fails closed for %s', async (_label, mutate) => {
    const { evaluateAgentIntegrationPerformanceResult } = await import(
      '../../scripts/evaluate-agent-integration-performance-result.mjs'
    )
    const result = validResult()
    mutate(result)
    expect(evaluateAgentIntegrationPerformanceResult({ result, thresholds }).length).toBeGreaterThan(0)
  })

  it('exposes a side-effect-free help path', () => {
    const prefix = 'tide-agent-integration-performance-'
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix)))
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'measure-agent-integration-performance.mjs'), '--help',
    ], { cwd: repoRoot, encoding: 'utf8' })
    const leaked = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix) && !before.has(name))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(leaked).toEqual([])
  })

  it('refuses an existing receipt before creating a temporary fixture', () => {
    const prefix = 'tide-agent-integration-performance-'
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix)))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-agent-integration-existing-receipt-'))
    const output = path.join(root, 'receipt.json')
    fs.writeFileSync(output, '{"old":true}\n')
    try {
      const result = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts', 'measure-agent-integration-performance.mjs'), '--output', output,
      ], { cwd: repoRoot, encoding: 'utf8' })
      const leaked = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix) && !before.has(name))
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('output already exists')
      expect(fs.readFileSync(output, 'utf8')).toBe('{"old":true}\n')
      expect(leaked).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a retained gate receipt is not bound to the current source and build', async () => {
    const { validateAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const expected = {
      protocolVersion: 3,
      sourceCommit: 'a'.repeat(40),
      sourceAuthority: 'git-head-tree',
      worktreeClean: true,
      sourceManifestSha256: 'b'.repeat(64),
      sourceFileCount: 500,
      buildManifestSha256: 'c'.repeat(64),
      buildFileCount: 200,
    }
    expect(validateAgentIntegrationGateProvenance(structuredClone(expected), expected)).toEqual([])
    expect(validateAgentIntegrationGateProvenance({ ...expected, protocolVersion: 2 }, expected))
      .toContain('provenance protocol version')

    for (const [field, replacement] of [
      ['sourceCommit', 'd'.repeat(40)],
      ['sourceAuthority', 'worktree-snapshot'],
      ['sourceManifestSha256', 'e'.repeat(64)],
      ['buildManifestSha256', 'f'.repeat(64)],
      ['worktreeClean', false],
    ] as const) {
      const receipt = { ...expected, [field]: replacement }
      expect(validateAgentIntegrationGateProvenance(receipt, expected)).toContain(`provenance ${field}`)
    }
  })

  it.each([
    ['ignored client renderer JavaScript', 'client/src/App.js'],
    ['ignored server JavaScript', 'src/index.js'],
    ['ignored client build script', 'client/scripts/build-bin.generated.mjs'],
    ['ignored public copy input', 'client/public/runtime.generated.js'],
    ['ignored packaging resource', 'client/resources/runtime.generated.plist'],
  ])('rejects %s that shadows the exact tracked source tree', async (_label, relative) => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const { root, commit } = gateRepository()
    fs.writeFileSync(path.join(root, relative), 'shadow source\n')
    expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: root,
      expectedCommit: commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/source roots differ.*shadow=/)
  })

  it.each(['.env.production', 'client/.env.local'])(
    'rejects implicit ignored Vite environment input %s even when Git status is clean',
    async relative => {
      const { captureAgentIntegrationGateProvenance } = await import(
        '../../scripts/agent-integration-gate-provenance.mjs'
      )
      const fixture = gateRepository()
      fs.writeFileSync(path.join(fixture.root, relative), 'VITE_SHADOW=outside-commit\n')
      expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
      expect(() => captureAgentIntegrationGateProvenance({
        repoRoot: fixture.root,
        expectedCommit: fixture.commit,
        sourceRoots: fixtureSourceRoots,
        buildRoots: fixtureBuildRoots,
      })).toThrow(/refuses implicit build environment file/)
    },
  )

  it('rejects untracked source and tracked source drift in an exact checkout', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const first = gateRepository()
    fs.writeFileSync(path.join(first.root, 'src', 'extra.ts'), 'untracked\n')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: first.root,
      expectedCommit: first.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/clean exact checkout/)

    const second = gateRepository()
    git(second.root, ['update-index', '--assume-unchanged', 'src/index.ts'])
    fs.writeFileSync(path.join(second.root, 'src', 'index.ts'), 'tracked drift\n')
    expect(git(second.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: second.root,
      expectedCommit: second.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/tracked source drifted/)
  })

  it('rejects hidden content drift in the client runtime bundle builder', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/scripts/build-bin.mjs'])
    fs.writeFileSync(path.join(fixture.root, 'client', 'scripts', 'build-bin.mjs'), 'export const build = false\n')
    expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/tracked source drifted.*client\/scripts\/build-bin\.mjs/)
  })

  it('rejects hidden content drift in a public file copied verbatim into the client build', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/public/icon.png'])
    fs.writeFileSync(path.join(fixture.root, 'client', 'public', 'icon.png'), 'public-copy-v2\n')
    expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/tracked source drifted.*client\/public\/icon\.png/)
  })

  it.runIf(process.platform !== 'win32')('rejects hidden executable-mode drift even when Git filemode detection is disabled', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    git(fixture.root, ['config', 'core.filemode', 'false'])
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/scripts/build-bin.mjs'])
    fs.chmodSync(path.join(fixture.root, 'client', 'scripts', 'build-bin.mjs'), 0o755)
    expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/tracked source mode drifted.*client\/scripts\/build-bin\.mjs.*expected 100644, got 100755/)
  })

  it.runIf(process.platform !== 'win32')('rejects hidden executable-mode drift in a client public input', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    git(fixture.root, ['config', 'core.filemode', 'false'])
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/public/icon.png'])
    fs.chmodSync(path.join(fixture.root, 'client', 'public', 'icon.png'), 0o755)
    expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/tracked source mode drifted.*client\/public\/icon\.png.*expected 100644, got 100755/)
  })

  it.runIf(process.platform !== 'win32')('rejects a hidden symlink replacement of the client runtime bundle builder', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    const builder = path.join(fixture.root, 'client', 'scripts', 'build-bin.mjs')
    const replacement = path.join(fixture.root, 'dist', 'replacement-build-bin.mjs')
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/scripts/build-bin.mjs'])
    fs.writeFileSync(replacement, fs.readFileSync(builder))
    fs.unlinkSync(builder)
    fs.symlinkSync(replacement, builder)
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/gate provenance refuses symlink.*client\/scripts\/build-bin\.mjs/)
  })

  it.runIf(process.platform !== 'win32')('rejects a hidden symlink replacement of a public build input', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const fixture = gateRepository()
    const publicInput = path.join(fixture.root, 'client', 'public', 'icon.png')
    const replacement = path.join(fixture.root, 'dist', 'replacement-icon.png')
    git(fixture.root, ['update-index', '--assume-unchanged', 'client/public/icon.png'])
    fs.writeFileSync(replacement, fs.readFileSync(publicInput))
    fs.unlinkSync(publicInput)
    fs.symlinkSync(replacement, publicInput)
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: fixture.root,
      expectedCommit: fixture.commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/gate provenance refuses symlink.*client\/public\/icon\.png/)
  })

  it.runIf(process.platform !== 'win32')('rejects a committed symlink in an exact source tree', async () => {
    const { captureAgentIntegrationGateProvenance } = await import(
      '../../scripts/agent-integration-gate-provenance.mjs'
    )
    const { root } = gateRepository()
    fs.symlinkSync('index.ts', path.join(root, 'src', 'linked.ts'))
    git(root, ['add', 'src/linked.ts'])
    git(root, ['commit', '-qm', 'add tracked symlink'])
    const commit = git(root, ['rev-parse', 'HEAD'])
    expect(() => captureAgentIntegrationGateProvenance({
      repoRoot: root,
      expectedCommit: commit,
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })).toThrow(/source tree refuses blob\/120000/)
  })

  it('binds the exact commit source tree and rejects old root/client builds and stale receipts', { timeout: 30_000 }, async () => {
    const {
      captureAgentIntegrationGateProvenance,
      validateAgentIntegrationGateProvenance,
    } = await import('../../scripts/agent-integration-gate-provenance.mjs')
    const { root, commit } = gateRepository()
    const capture = () => captureAgentIntegrationGateProvenance({
      repoRoot: root,
      expectedCommit: git(root, ['rev-parse', 'HEAD']),
      sourceRoots: fixtureSourceRoots,
      buildRoots: fixtureBuildRoots,
    })
    const original = capture()
    expect(original).toMatchObject({
      protocolVersion: 3,
      sourceCommit: commit,
      sourceAuthority: 'git-head-tree',
      worktreeClean: true,
      sourceFileCount: 7,
      buildFileCount: 3,
    })

    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'root-build-v2\n')
    const changedRootBuild = capture()
    expect(changedRootBuild.sourceManifestSha256).toBe(original.sourceManifestSha256)
    expect(validateAgentIntegrationGateProvenance(original, changedRootBuild))
      .toContain('provenance buildManifestSha256')

    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'root-build-v1\n')
    fs.writeFileSync(path.join(root, 'client', 'out', 'index.js'), 'client-build-v2\n')
    const changedClientBuild = capture()
    expect(validateAgentIntegrationGateProvenance(original, changedClientBuild))
      .toContain('provenance buildManifestSha256')

    fs.writeFileSync(path.join(root, 'client', 'out', 'index.js'), 'client-build-v1\n')
    const nativeBuild = path.join(
      root,
      'client',
      'electron',
      'native',
      'secure-store-mac',
      'build',
      'secure-store.node',
    )
    fs.writeFileSync(nativeBuild, 'native-build-v2\n')
    const changedNativeBuild = capture()
    expect(changedNativeBuild.sourceManifestSha256).toBe(original.sourceManifestSha256)
    expect(validateAgentIntegrationGateProvenance(original, changedNativeBuild))
      .toContain('provenance buildManifestSha256')

    fs.writeFileSync(nativeBuild, 'native-build-v1\n')
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(root, 'dist', 'index.js'), 0o755)
      const changedRootBuildMode = capture()
      expect(changedRootBuildMode.sourceManifestSha256).toBe(original.sourceManifestSha256)
      expect(validateAgentIntegrationGateProvenance(original, changedRootBuildMode))
        .toContain('provenance buildManifestSha256')

      fs.chmodSync(path.join(root, 'dist', 'index.js'), 0o644)
      fs.chmodSync(path.join(root, 'client', 'out', 'index.js'), 0o755)
      const changedClientBuildMode = capture()
      expect(changedClientBuildMode.sourceManifestSha256).toBe(original.sourceManifestSha256)
      expect(validateAgentIntegrationGateProvenance(original, changedClientBuildMode))
        .toContain('provenance buildManifestSha256')

      fs.chmodSync(path.join(root, 'client', 'out', 'index.js'), 0o644)
    }
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const server = false\n')
    git(root, ['add', 'src/index.ts'])
    git(root, ['commit', '-qm', 'change tracked source'])
    const changedSource = capture()
    expect(changedSource.sourceCommit).not.toBe(original.sourceCommit)
    expect(changedSource.sourceManifestSha256).not.toBe(original.sourceManifestSha256)
    expect(validateAgentIntegrationGateProvenance(original, changedSource)).toEqual(expect.arrayContaining([
      'provenance sourceCommit',
      'provenance sourceManifestSha256',
    ]))
  })

  it('keeps private exact-head gates and the public OSS CI topology distribution-correct', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    const publicOssWorkflow = workflow.includes('  test:\n    runs-on: ubuntu-latest')
    if (publicOssWorkflow) {
      expect(workflow).not.toContain('externabrain-macos')
      expect(workflow).not.toContain('externabrain-linux')
      expect(workflow).toContain('cd client && npm run build:bin')
      expect(workflow).toContain('- run: npm test')
      return
    }

    const macJobStart = workflow.indexOf('  mac-packaging:')
    expect(macJobStart).toBeGreaterThan(-1)
    const macJob = workflow.slice(macJobStart, workflow.indexOf('  website:'))
    expect(macJob).toContain("github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || 'externabrain-macos'")
    expect(macJob).toContain('HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name || github.repository }}')
    expect(macJob).toContain('[ "$GITHUB_EVENT_NAME" != pull_request ] || [ "$HEAD_REPOSITORY" = "$GITHUB_REPOSITORY" ]')
    expect(macJob).toContain('ref: ${{ env.TIDEMIND_CI_SOURCE_HEAD }}')
    expect(macJob).toContain('[ "$(git rev-parse HEAD)" = "$TIDEMIND_CI_SOURCE_HEAD" ]')
    expect(macJob.match(/node scripts\/verify-agent-integration-source-checkout\.mjs/g)).toHaveLength(3)
    expect(macJob).toContain('npm run measure:agent-integration -- --output')
    expect(macJob).toContain('run-agent-integration-electron-ui-e2e.mjs --receipt')
    expect(macJob).toContain('--evidence-dir "$TIDEMIND_CI_JOB_TEMP/agent-integration-ui-e2e-evidence"')
    expect(macJob).toContain('npm run verify:agent-integration-gates -- --performance')
    expect(macJob).toContain('--ui-evidence "$TIDEMIND_CI_JOB_TEMP/agent-integration-ui-e2e-evidence"')
    expect(macJob).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(macJob).toContain('retention-days: 14')
    expect(macJob).toContain('if-no-files-found: error')
    const verify = macJob.indexOf('Bind Agent Integration gate receipts to exact source and build')
    const upload = macJob.indexOf('Retain Agent Integration receipts, report, and screenshots')
    const cleanup = macJob.indexOf('Self-hosted cleanup')
    const trust = macJob.indexOf('Source repository trust gate')
    const checkout = macJob.indexOf('actions/checkout@')
    expect(trust).toBeGreaterThan(-1)
    expect(checkout).toBeGreaterThan(trust)
    expect(verify).toBeGreaterThan(-1)
    expect(upload).toBeGreaterThan(verify)
    expect(cleanup).toBeGreaterThan(upload)
    expect(macJob.slice(cleanup, cleanup + 260)).toContain("always() && (github.event_name != 'pull_request'")

    const provenance = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'agent-integration-gate-provenance.mjs'),
      'utf8',
    )
    for (const sourceRoot of ["'client/scripts'", "'client/public'", "'client/resources'", "'data'"]) {
      expect(provenance).toContain(sourceRoot)
    }
    expect(provenance).toContain('assertNoBuildEnvironmentFiles(repoRoot)')

    const uiRunner = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'run-agent-integration-electron-ui-e2e.mjs'),
      'utf8',
    )
    const receiptVerifier = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'verify-agent-integration-gate-receipts.mjs'),
      'utf8',
    )
    expect(uiRunner).toContain('evidenceManifestSha256,')
    expect(receiptVerifier).toContain('verifyAgentIntegrationUiE2eEvidence')
    expect(receiptVerifier).toContain('validateAgentIntegrationUiE2eReceipt')
    expect(receiptVerifier).toContain("args[4] !== '--ui-evidence'")

    const evidenceVerifier = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'agent-integration-ui-e2e-evidence.mjs'),
      'utf8',
    )
    expect(evidenceVerifier).toContain("receipt?.isolation !== 'temporary-home-physical-sqlite-real-electron'")
    expect(evidenceVerifier).toContain('receipt?.writesRealAgentConfiguration !== false')
  })
})
