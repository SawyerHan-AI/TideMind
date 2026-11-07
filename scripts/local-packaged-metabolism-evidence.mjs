import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { evaluateMetabolismPerformanceResult } from './evaluate-metabolism-performance-result.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const localPackagedMetabolismVersion = '0.2.95'
export const localPackagedMetabolismReceiptPath = `release-evidence/local-packaged-metabolism-performance/${localPackagedMetabolismVersion}.json`
const thresholdPath = 'scripts/metabolism-worker-candidate-thresholds.json'
const workerPath = 'out/bin/metabolism-worker.cjs'
const inputs = [
  'package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json',
  'client/electron-builder.yml', 'client/scripts/build-bin.mjs',
  thresholdPath,
  'scripts/agent-integration-gate-provenance.mjs',
  'scripts/cpu-utilization-sampler.mjs',
  'scripts/evaluate-metabolism-performance-result.mjs',
  'scripts/local-packaged-metabolism-evidence.mjs',
  'scripts/materialize-metabolism-performance-runner.mjs',
  'scripts/metabolism-performance-release-exception.mjs',
  'scripts/metabolism-worker-electron-performance-harness.ts',
  'scripts/run-metabolism-worker-electron-performance.mjs',
  'scripts/run-packaged-metabolism-worker-performance.mjs',
  'scripts/smoke-packaged-metabolism-worker.mjs',
  'tests/client/metabolism-worker-forced-termination.test.ts',
]
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/u
const sqlitePackages = ['better-sqlite3', 'sqlite-vec', 'sqlite-vec-darwin-arm64']

export function assertLockedLocalPackagedDependencies(root) {
  for (const [directory, names] of [
    ['.', ['esbuild', ...sqlitePackages]],
    ['client', ['electron', 'electron-builder', ...sqlitePackages]],
  ]) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, directory, 'package-lock.json')))
    for (const name of names) {
      const packagePath = `node_modules/${name}`
      const installed = JSON.parse(fs.readFileSync(path.join(root, directory, packagePath, 'package.json')))
      const expected = lock.packages?.[packagePath]?.version
      assert.ok(expected && installed.name === name && installed.version === expected,
        `installed ${directory}/${name} differs from its lock; prepare fresh locked dependencies`)
    }
  }
}

export function localPackagedMetabolismIdentity(root, sourceCommit) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u, 'expected private source commit is invalid')
  const read = file => fs.readFileSync(path.join(root, file))
  const files = Object.fromEntries(inputs.map(file => [file, read(file)]))
  const appVersion = JSON.parse(files['package.json']).version
  assert.equal(appVersion, localPackagedMetabolismVersion, 'local packaged performance is only allowed for 0.2.95')
  assert.equal(JSON.parse(files['client/package.json']).version, appVersion, 'release version mismatch')
  return {
    appVersion, sourceCommit, architecture: 'arm64',
    inputSha256: Object.fromEntries(inputs.map(file => [file, sha256(files[file])])),
  }
}

function requireFields(value, fields) {
  assert.ok(value && isDeepStrictEqual(Object.keys(value).sort(), fields.split(' ').sort()),
    'local packaged performance contains missing or unexpected measurement fields')
}

// The public receipt carries measurements only. Reject arbitrary extra fields
// before staging these original bytes in the public repository.
function validatePublicMeasurementFields(result) {
  requireFields(result, 'protocolVersion measuredAt machine fixture workloads throughput mainBaselineEventLoopDelayMs backgroundFullBacklog contentionRuns eventLoopDelayMs resourceUsage foregroundWriterDelayMs correctness provenance thresholdEvaluation')
  requireFields(result.machine, 'cpu cpuCount loadAverageAtStart loadAverageAtEnd cpuUtilizationGate memoryBytes os arch electronVersion')
  requireFields(result.machine.cpuUtilizationGate, 'start baselineHostMaximumObserved baselineProcessMaximumObserved baselineExternalMaximumObserved baselineWindows beforeCandidate maximumObserved end')
  for (const window of result.machine.cpuUtilizationGate.baselineWindows) requireFields(window, 'host process external')
  requireFields(result.fixture, 'nodeCount linkCount writesPerKind dataRoot')
  requireFields(result.workloads, 'focusedRendererIpcWrites backgroundFullBacklog')
  requireFields(result.throughput, 'mainBaselineRunsMs workerRunsMs mainBaselineMs workerRuntimeMs workerVsMainBaselineRatio')
  requireFields(result.backgroundFullBacklog, 'durationMs llmAndEmbeddingTasksCircuitGated')
  requireFields(result.resourceUsage, 'cpuUserMs cpuSystemMs walBytesBeforeCheckpoint checkpoint')
  requireFields(result.resourceUsage.checkpoint, 'busy log checkpointed')
  requireFields(result.correctness, 'foregroundSingleAttempt suspendResume workerOwnerTerminateReacquire unexpectedSqliteBusyOrLocked concurrentSchedulerPasses mainThreadSchedulerTaskExecutions orphanCliProcessGroupsAfterShutdown')
  requireFields(result.provenance, 'gitHead thresholdSha256 sourceWorkerSha256 assets')
  for (const asset of Object.values(result.provenance.assets)) requireFields(asset, 'bytes sha256')
  for (const trial of result.contentionRuns) requireFields(trial, 'eventLoopDelayMs foregroundWriterDelayMs')
  requireFields(result.mainBaselineEventLoopDelayMs, 'p50 p95 p99 max')
  for (const trial of [result, ...result.contentionRuns]) {
    requireFields(trial.eventLoopDelayMs, 'p50 p95 p99 max')
    requireFields(trial.foregroundWriterDelayMs, 'renderer note cloud')
    for (const writer of Object.values(trial.foregroundWriterDelayMs)) requireFields(writer, 'count p50 p95 p99 max')
  }
  assert.ok(/^Apple M[1-9]\d*(?: Pro| Max| Ultra)?(?: \(Virtual\))?$/u.test(result.machine.cpu)
    && result.measuredAt === new Date(result.measuredAt).toISOString(), 'unexpected public measurement metadata')
}

export function validateLocalPackagedMetabolismReceipt(receipt, { root, sourceCommit, worker, app }) {
  const { schemaVersion, kind, result, ...identity } = receipt
  assert.equal(schemaVersion, 1, 'local packaged performance schema mismatch')
  assert.equal(kind, 'local-packaged-metabolism-performance', 'local packaged performance kind mismatch')
  assert.ok(isDeepStrictEqual(identity, localPackagedMetabolismIdentity(root, sourceCommit)),
    'local packaged performance source or input digest mismatch')
  const thresholds = JSON.parse(fs.readFileSync(path.join(root, thresholdPath)))
  const clientLock = JSON.parse(fs.readFileSync(path.join(root, 'client/package-lock.json')))
  const electronVersion = clientLock.packages?.['node_modules/electron']?.version
  assert.ok(electronVersion && result?.machine?.electronVersion === electronVersion
    && /^Darwin \d+(?:\.\d+){1,2}$/u.test(result.machine.os) && result.machine.arch === 'arm64',
  'local packaged performance must match the locked macOS arm64 Electron runtime')
  assert.ok(!Object.hasOwn(result, 'releaseException') && !result.error, 'local packaged performance cannot use an exception or failed run')
  assert.ok(isDeepStrictEqual(result.thresholdEvaluation, { protocolVersion: thresholds.protocolVersion, status: 'passed', failures: [] }),
    'local packaged performance receipt did not pass')
  assert.deepEqual(evaluateMetabolismPerformanceResult({
    result, thresholds, packaged: true, writesPerKind: 100, maximumCpuUtilization: thresholds.environment.cpuUtilizationMax,
  }), [], 'local packaged performance metrics do not meet the frozen thresholds')
  validatePublicMeasurementFields(result)
  const provenance = result.provenance
  assert.equal(provenance?.gitHead, sourceCommit, 'measured Git head differs from the private source commit')
  assert.equal(provenance.thresholdSha256, identity.inputSha256[thresholdPath], 'measured threshold digest mismatch')
  assert.match(provenance.sourceWorkerSha256, hashPattern, 'invalid measured source Worker digest')
  assert.deepEqual(Object.keys(provenance.assets ?? {}).sort(), ['appAsar', 'executable', 'workerBundle'], 'measured packaged asset set mismatch')
  for (const asset of Object.values(provenance.assets)) {
    assert.ok(hashPattern.test(asset?.sha256 ?? '') && Number.isSafeInteger(asset.bytes) && asset.bytes > 0,
      'invalid measured packaged asset identity')
  }
  assert.equal(provenance.assets.workerBundle.sha256, provenance.sourceWorkerSha256, 'measured packaged Worker differs from source Worker')
  for (const [label, file] of [
    ['freshly built', worker],
    ['signed App', app && path.join(app, 'Contents/Resources/app.asar.unpacked', workerPath)],
  ]) {
    if (!file) continue
    const bytes = fs.readFileSync(file)
    assert.ok(bytes.length === provenance.assets.workerBundle.bytes && sha256(bytes) === provenance.sourceWorkerSha256,
      `${label} Worker differs from the measured packaged Worker`)
  }
}

export function readLocalPackagedMetabolismReceipt(file, options) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd)
    assert.ok(before.isFile() && before.size > 0 && before.size <= 64 * 1024, 'local packaged performance receipt must be a bounded regular file')
    const bytes = Buffer.alloc(before.size)
    assert.equal(fs.readSync(fd, bytes), before.size, 'local packaged performance receipt changed while reading')
    const after = fs.fstatSync(fd)
    assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      'local packaged performance receipt changed while reading')
    let receipt
    try { receipt = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('invalid local packaged performance receipt JSON') }
    assert.ok(bytes.equals(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)),
      'local packaged performance receipt must preserve the original producer JSON')
    validateLocalPackagedMetabolismReceipt(receipt, options)
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const allowed = new Set(['--receipt', '--source-commit', '--worker', '--app', '--copy-to'])
    const options = new Map()
    for (let index = 0; index < args.length; index += 2) {
      const [flag, value] = args.slice(index, index + 2)
      assert.ok(allowed.has(flag) && !options.has(flag) && value && !value.startsWith('--'), 'invalid local packaged performance argument')
      options.set(flag, value)
    }
    for (const flag of ['--receipt', '--source-commit', '--worker']) assert.ok(options.has(flag), `missing ${flag}`)
    const bytes = readLocalPackagedMetabolismReceipt(options.get('--receipt'), {
      root: repoRoot, sourceCommit: options.get('--source-commit'), worker: options.get('--worker'), app: options.get('--app'),
    })
    const destination = options.get('--copy-to')
    if (destination) fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    console.log('Verified local packaged performance for the exact private source and Worker.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
