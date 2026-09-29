import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPartialAuthReleaseTemplate, buildPartialAuthReleasePlan, validatePartialAuthReleaseReport,
  hashPartialAuthReleaseBody, hashPartialAuthEvidenceManifest, PARTIAL_AUTH_RELEASE_DISCLOSURE,
  PARTIAL_AUTH_RELEASE_POLICY, loadPartialAuthReleaseReport, validatePartialCandidateReceipts, copyPartialAuthReleaseSnapshot, extractPartialCandidateAppArchive, verifyPartialPerformanceArtifact } from '../../scripts/verify-partial-auth-release.mjs'
import { loadAgentHostAcceptanceRequirements, hostAcceptanceTargetIdentityDigest, hostAcceptanceTargetMetadataExportHash, distributionArtifactReceiptSha256 } from '../../scripts/verify-agent-integration-host-acceptance.mjs'
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const source = 'a'.repeat(40), publicCommit = 'b'.repeat(40), H = 'c'.repeat(64)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(bundleSha256 = H) {
  const report: any = buildPartialAuthReleaseTemplate({ expectedSourceCommit: source })
  const requirements = loadAgentHostAcceptanceRequirements(), plan: any = buildPartialAuthReleasePlan(requirements)
  report.captureCreatedAt = '2026-09-29T01:00:00.000Z'; report.generatedAt = '2026-09-29T02:00:00.000Z'
  report.authorization.authorizedAt = '2026-09-29T00:00:00.000Z'; report.collectedBy = 'fixture-collector'
  Object.assign(report.candidate, { publicCommit, runId: '11', runAttempt: '1', artifactId: '12', artifactDigest: H,
    uploadReceiptArtifactId: '13', uploadReceiptArtifactDigest: H, dmgSha256: H, zipSha256: H })
  Object.assign(report.candidate.app, { bundleSha256, executableSha256: H, signingIdentity: 'Developer ID Application: Fixture (Z4U232GXH5)', cdhash: 'd'.repeat(40) })
  Object.assign(report.candidate.performance, { artifactId: '14', artifactDigest: H, workerSha256: H })
  const documents = new Map<string, Buffer>()
  function add(file: string, value: unknown) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    documents.set(file, bytes); report.files.push({ path: file, bytes: bytes.length, sha256: hash(bytes) }); return file
  }
  add('release-notes.md', PARTIAL_AUTH_RELEASE_DISCLOSURE)
  add('evidence/update-signatures.json', { appVersion: '0.2.93', fixture: true })
  add('raw-observation.txt', 'Unit fixture data, not physical release acceptance. Never invoke the physical verifier on this fixture.')
  add(report.candidate.performance.receiptPath, { thresholdEvaluation: { protocolVersion: 3, status: 'passed', failures: [] },
    provenance: { gitHead: publicCommit, sourceWorkerSha256: H, thresholdSha256: hash(fs.readFileSync(path.resolve('scripts/metabolism-worker-candidate-thresholds.json'))) } })
  report.candidate.performance.receiptSha256 = report.files.find((f: any) => f.path === report.candidate.performance.receiptPath).sha256
  const bindings = () => ({ captureNonce: report.captureNonce, appVersion: report.appVersion, sourceCommit: report.sourceCommit, requirementsSha256: report.requirementsSha256,
    releaseContractSha256: report.releaseContractSha256, policySha256: report.policySha256, candidateBundleSha256: report.candidate.app.bundleSha256 })
  let counter = 0
  function pass(check: any, subject: any, evidenceClass = 'signed_candidate_no_auth', extraEvidence: string[] = []) {
    check.status = 'passed'; delete check.reason; delete check.explanation
    check.receipt = `receipts/${++counter}.json`; check.evidenceFiles = ['raw-observation.txt', ...extraEvidence]
    add(check.receipt, { schemaVersion: 1, kind: 'partial_release_check', evidenceClass, ...bindings(), subject, checkId: check.id,
      outcome: 'passed', observedAt: '2026-09-29T01:30:00.000Z', assertionSource: 'external', assertedBy: 'fixture-collector', findings: [], evidenceFiles: check.evidenceFiles })
  }
  for (const target of report.targets) {
    const expected = plan.targets.find((entry: any) => entry.targetKey === target.targetKey)
    const artifact = expected.acceptedDistributionArtifacts[0]
    target.hostVersion = expected.releaseAcceptedExactVersions?.[0] ?? '1.0.0'
    const distribution = artifact ? { distributionId: artifact.distributionId, packageProvenance: artifact.packageProvenance,
      artifactReceiptSha256: distributionArtifactReceiptSha256(artifact), portableArtifactFingerprint: artifact.portableArtifactFingerprint,
      executableSha256: artifact.executableSha256, executableSizeBytes: artifact.executableSizeBytes,
      distributionSha256: artifact.distributionSha256, distributionSizeBytes: artifact.distributionSizeBytes,
      rawExecutableSha256: artifact.executableSha256, rawExecutableSizeBytes: artifact.executableSizeBytes }
      : { distributionId: 'manual', packageProvenance: 'user-selected', artifactReceiptSha256: null, portableArtifactFingerprint: null,
        executableSha256: H, executableSizeBytes: 1, distributionSha256: H, distributionSizeBytes: 1, rawExecutableSha256: H, rawExecutableSizeBytes: 1 }
    const metadata: any = { targetKey: target.targetKey, targetId: target.targetId,
      ...(target.sourceCatalogId ? { sourceCatalogId: target.sourceCatalogId } : {}), hostVersion: target.hostVersion, distribution,
      environment: { platform: 'darwin', architecture: 'arm64', processArchitecture: 'arm64', hardwareArchitecture: 'arm64', translationMode: 'not_translated', osVersion: '15.0', hostIdentitySha256: H },
      installationId: `install-${target.targetKey}`, agentId: `agent-${target.targetKey}` }
    if (target.targetId === 'nonstandard_config_root' || target.targetId === 'manual_mcp_client') {
      const nonstandard = target.targetId === 'nonstandard_config_root', user = expected.userOwned
      metadata.customBinding = { kind: target.targetId, sourceInstallationId: nonstandard ? 'source-install' : null,
        sourceCatalogId: target.sourceCatalogId, configRootIdentitySha256: H, configFileIdentitySha256: nonstandard || user ? null : H,
        selectorIdentitySha256: H, executableFingerprint: nonstandard ? null : H, sourceLiveTrustProofSha256: nonstandard ? H : null,
        liveTrustProofSha256: H, readBackProofSha256: user ? null : H, ...(user ? { configurationOwnership: 'user', activityBinding: null } : {}) }
    }
    target.hostIdentitySha256 = hostAcceptanceTargetIdentityDigest(metadata)
    const exported: any = { exporterVersion: 1, evidenceClass: expected.userOwned ? 'real_host_no_auth_0.2.93' : 'real_host', candidateBundleSha256: report.candidate.app.bundleSha256, sourceCommit: source,
      releaseContractSha256: report.releaseContractSha256, targetMetadata: metadata, exportedAt: '2026-09-29T01:15:00.000Z' }
    exported.exportHash = hostAcceptanceTargetMetadataExportHash(exported)
    target.metadataExportFile = add(`target-metadata/${report.targets.indexOf(target)}.json`, exported)
    for (const step of target.steps) {
      const subject = { kind: 'target_step', targetKey: target.targetKey, targetId: target.targetId, hostVersion: target.hostVersion, hostIdentitySha256: target.hostIdentitySha256, stepId: step.id }
      step.noAuth.forEach((check: any) => pass(check, subject))
      step.runtime.forEach((check: any) => { check.explanation = 'User deferred this authenticated host/model runtime observation for 0.2.93 only.' })
    }
  }
  for (const upgrade of report.upgradePaths) {
    Object.assign(upgrade, { installationId: 'upgrade-install', originalAgentId: 'stable-agent', migratedAgentId: 'stable-agent', historyPreserved: true, statisticsPreserved: true })
    const { noAuth, runtime: _runtime, ...identity } = upgrade
    noAuth.forEach((check: any) => pass(check, { kind: 'upgrade', ...identity, hostIdentitySha256: report.targets.find((target: any) => target.targetKey === upgrade.targetKey).hostIdentitySha256 }))
  }
  for (const model of report.modelPaths) {
    model.noAuth.forEach((check: any) => pass(check, { kind: 'model', provider: model.provider }))
    model.runtime.forEach((check: any) => { check.explanation = 'Current provider login and live inference acceptance are explicitly deferred for 0.2.93.' })
  }
  for (const check of report.globalChecks) pass(check, { kind: 'global', id: check.id }, (PARTIAL_AUTH_RELEASE_POLICY.global as any)[check.id], check.id === 'update_signature_preflight' ? ['evidence/update-signatures.json'] : [])
  function seal(reviewer = 'independent-fixture-reviewer') {
    const review = { schemaVersion: 1, kind: 'independent_partial_auth_release_review', ...bindings(),
      reportBodySha256: hashPartialAuthReleaseBody(report), evidenceManifestSha256: hashPartialAuthEvidenceManifest(report), reviewer,
      reviewedAt: '2026-09-29T03:00:00.000Z', outcome: 'approved_with_auth_runtime_deferred', unresolvedNoAuthFindings: [],
      disclosureVerified: true, completedRuntimeEvidencePreserved: true }
    const reviewDocument = Buffer.from(JSON.stringify(review))
    report.review = { path: 'independent-review.json', bytes: reviewDocument.length, sha256: hash(reviewDocument) }
    return reviewDocument
  }
  const state = { report, documents, pass, seal, reviewDocument: seal() }
  return state
}
function validate(state: ReturnType<typeof fixture>) {
  return validatePartialAuthReleaseReport(state.report, { expectedSourceCommit: source, documents: state.documents, reviewDocument: state.reviewDocument })
}

describe('0.2.93 partial auth/runtime release policy', () => {
  it('keeps all source-derived targets, required steps and 63 upgrades without claiming physical acceptance', () => {
    const state = fixture(), result = validate(state)
    expect(result).toMatchObject({ status: 'validated_partial_report_only', physicalVerified: false, fullHostAcceptance: false, targetCount: 26, upgradeCount: 63 })
    expect(result.requiredStepCount).toBe(state.report.targets.reduce((sum: number, target: any) => sum + target.steps.length, 0))
    expect(result.noAuthPassed).toBeGreaterThan(result.requiredStepCount)
    expect(result.deferredRuntime).toBeGreaterThan(0)
  })
  it('generates only a pending template, never passed evidence', () => {
    const template = buildPartialAuthReleaseTemplate({ expectedSourceCommit: source })
    expect(template.targets.every((target: any) => target.steps.every((step: any) => step.noAuth.every((check: any) => check.status === 'pending')))).toBe(true)
    expect(() => validatePartialAuthReleaseReport(template, { expectedSourceCommit: source })).toThrow()
  })
  it.each([
    ['future version reuse', (r: any) => { r.appVersion = '0.2.94' }],
    ['0.2.92 reuse', (r: any) => { r.appVersion = '0.2.92' }],
    ['source mismatch', (r: any) => { r.sourceCommit = 'e'.repeat(40) }],
    ['artifact-role substitution', (r: any) => { r.candidate.performance.artifactId = r.candidate.artifactId }],
    ['performance worker mismatch', (r: any) => { r.candidate.performance.workerSha256 = 'e'.repeat(64) }],
    ['policy substitution', (r: any) => { r.policySha256 = 'e'.repeat(64) }],
    ['broader authorization', (r: any) => { r.authorization.scope.push('all_host_acceptance') }],
    ['missing target', (r: any) => { r.targets.pop() }],
    ['missing original step', (r: any) => { r.targets[0].steps.pop() }],
    ['configuration deferred', (r: any) => { r.targets[0].steps[0].noAuth[0].status = 'deferred' }],
    ['missing upgrade', (r: any) => { r.upgradePaths.pop() }],
    ['history lost', (r: any) => { r.upgradePaths[0].historyPreserved = false }],
    ['Agent identity replaced', (r: any) => { r.upgradePaths[0].migratedAgentId = 'new-agent' }],
    ['migration deferred', (r: any) => { r.upgradePaths[0].noAuth[0].status = 'deferred' }],
    ['model safety deferred', (r: any) => { r.modelPaths[0].noAuth[0].status = 'deferred' }],
    ['update signature waived', (r: any) => { r.globalChecks.find((c: any) => c.id === 'update_signature_preflight').status = 'deferred' }],
    ['update signature detached', (r: any) => { r.globalChecks.find((c: any) => c.id === 'update_signature_preflight').evidenceFiles = ['raw-observation.txt'] }],
    ['GUI waived', (r: any) => { r.globalChecks.find((c: any) => c.id === 'default_gui_startup').status = 'deferred' }],
    ['source artifact version drift', (r: any) => { r.targets[0].hostVersion = '999.0.0' }],
    ['deferred fake receipt', (r: any) => { r.targets[0].steps.find((s: any) => s.runtime.length).runtime[0].receipt = 'fake.json' }],
  ] as const)('rejects %s', (_label, mutate) => {
    const state = fixture(); mutate(state.report); state.reviewDocument = state.seal()
    expect(() => validate(state)).toThrow()
  })
  it('requires independent review and preserves report/evidence review binding', () => {
    const state = fixture(); state.reviewDocument = state.seal(' FIXTURE-COLLECTOR ')
    expect(() => validate(state)).toThrow(/independent/)
    state.reviewDocument = state.seal(); state.report.targets[0].hostVersion = 'altered-after-review'
    expect(() => validate(state)).toThrow()
  })
  it('does not accept fixture assertion classes or mutated evidence bytes', () => {
    const state = fixture(), check = state.report.targets[0].steps[0].noAuth[0]
    const doc = JSON.parse(state.documents.get(check.receipt)!.toString()); doc.evidenceClass = 'fixture'
    const bytes = Buffer.from(JSON.stringify(doc)); state.documents.set(check.receipt, bytes)
    Object.assign(state.report.files.find((f: any) => f.path === check.receipt), { bytes: bytes.length, sha256: hash(bytes) }); state.reviewDocument = state.seal()
    expect(() => validate(state)).toThrow(/evidence class/)
    state.documents.set(check.receipt, Buffer.from('tamper'))
    expect(() => validate(state)).toThrow(/content mismatch/)
  })
  it('permits the explicit no-auth metadata class only for the three user-owned Custom targets', () => {
    for (const change of ['class-on-managed', 'null-activity-with-full-class', 'partial-activity'] as const) {
      const state = fixture()
      const target = change === 'class-on-managed' ? state.report.targets[0]
        : state.report.targets.find((t: any) => t.targetKey.startsWith('manual_mcp_client:'))
      const name = target.metadataExportFile, value = JSON.parse(state.documents.get(name)!.toString())
      if (change === 'class-on-managed') value.evidenceClass = 'real_host_no_auth_0.2.93'
      if (change === 'null-activity-with-full-class') value.evidenceClass = 'real_host'
      if (change === 'partial-activity') value.targetMetadata.customBinding.activityBinding = { incomplete: true }
      value.exportHash = hostAcceptanceTargetMetadataExportHash(value)
      const bytes = Buffer.from(JSON.stringify(value)); state.documents.set(name, bytes)
      Object.assign(state.report.files.find((file: any) => file.path === name), { bytes: bytes.length, sha256: hash(bytes) })
      state.reviewDocument = state.seal()
      expect(() => validate(state)).toThrow()
    }
  })
  it('preserves valid completed-runtime entries as real_host evidence, separate from deferred entries', () => {
    const state = fixture(), target = state.report.targets[0], step = target.steps.find((value: any) => value.runtime.length)
    state.pass(step.runtime[0], { kind: 'target_step', targetKey: target.targetKey, targetId: target.targetId, hostVersion: target.hostVersion, hostIdentitySha256: target.hostIdentitySha256, stepId: step.id }, 'real_host')
    state.reviewDocument = state.seal()
    expect(validate(state).runtimePassed).toBe(1)
  })
  it('requires disclosure and actual frozen performance thresholds even after evidence is resealed', () => {
    for (const failure of ['notes', 'performance'] as const) {
      const state = fixture()
      const file = failure === 'notes' ? state.report.releaseNotesFile : state.report.candidate.performance.receiptPath
      const value = failure === 'notes' ? 'Release with no missing-acceptance disclosure.'
        : { ...JSON.parse(state.documents.get(file)!.toString()), thresholdEvaluation: { status: 'failed', failures: ['budget'] } }
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); state.documents.set(file, bytes)
      Object.assign(state.report.files.find((f: any) => f.path === file), { bytes: bytes.length, sha256: hash(bytes) })
      if (failure === 'performance') state.report.candidate.performance.receiptSha256 = hash(bytes)
      state.reviewDocument = state.seal()
      expect(() => validate(state)).toThrow(failure === 'notes' ? /disclosure/ : /performance/)
    }
  })
  it('CLI emits only pending templates and exposes no fixture/skip switch', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-template-cli-'))); roots.push(root)
    const out = path.join(root, 'report.json')
    const output = execFileSync(process.execPath, ['scripts/verify-partial-auth-release.mjs', '--template', '--source-commit', source, '--output', out], { encoding: 'utf8' })
    expect(JSON.parse(output)).toMatchObject({ status: 'pending_template_not_release_evidence', targets: 26, upgrades: 63 })
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).generatedAt).toBeNull()
    expect(spawnSync(process.execPath, ['scripts/verify-partial-auth-release.mjs', '--allow-fixture']).status).not.toBe(0)
  })
  it('binds the immutable upload and candidate receipts to exact source/run/artifact bytes', () => {
    const { report } = fixture(), c = report.candidate
    const upload = { schemaVersion: 1, purpose: 'mac_rc_upload', sourceCommit: source, publicCommit, appVersion: '0.2.93', architecture: 'arm64',
      repository: 'SawyerHan-AI/TideMind', runId: c.runId, runAttempt: c.runAttempt, artifactId: c.artifactId,
      artifactUrl: `https://github.com/SawyerHan-AI/TideMind/actions/runs/${c.runId}/artifacts/${c.artifactId}`, artifactDigest: c.artifactDigest }
    const verification = { schemaVersion: 1, verificationClass: 'private_rc_candidate', sourceCommit: source, appVersion: '0.2.93', architecture: 'arm64',
      candidateBundleSha256: c.app.bundleSha256, executableSha256: c.app.executableSha256, teamId: c.app.teamId,
      signingIdentity: c.app.signingIdentity, cdhash: c.app.cdhash, dmgSha256: c.dmgSha256, zipSha256: c.zipSha256, verifiedAt: '2026-09-29T04:00:00.000Z' }
    expect(() => validatePartialCandidateReceipts(report, upload, verification)).not.toThrow()
    expect(() => validatePartialCandidateReceipts(report, { ...upload, artifactId: '999' }, verification)).toThrow()
    expect(() => validatePartialCandidateReceipts(report, upload, { ...verification, dmgSha256: 'e'.repeat(64) })).toThrow()
  })
  it('verifies a real performance archive digest, unique member and exact indexed receipt bytes', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-performance-zip-'))); roots.push(root)
    const receipt = JSON.stringify({ test: 'archive bytes only, not performance acceptance' })
    for (const [index, member] of ['metabolism-performance-receipt.json', 'wrong-name.json'].entries()) {
      const archive = path.join(root, `${index}.zip`)
      execFileSync('/usr/bin/python3', ['-I', '-S', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],sys.argv[3]); z.close()', archive, member, receipt])
      const report = { candidate: { performance: { artifactDigest: hash(fs.readFileSync(archive)), receiptSha256: hash(receipt) } } }
      const run = () => verifyPartialPerformanceArtifact(report, archive, path.join(root, `out-${index}`))
      if (index === 0) {
        expect(run()).toMatchObject({ status: 'verified_performance_archive_bytes', receiptSha256: hash(receipt) })
        report.candidate.performance.receiptSha256 = H
        expect(() => verifyPartialPerformanceArtifact(report, archive, path.join(root, 'wrong-digest'))).toThrow(/receipt/)
      } else expect(run).toThrow(/entry allowlist/)
    }
  })
  it('copies the verified snapshot when live input changes to a different valid candidate/report', () => {
    const original = fixture(), replacement = fixture('e'.repeat(64))
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-copy-snapshot-'))); roots.push(root)
    const input = path.join(root, 'input'); fs.mkdirSync(input)
    function writeBundle(state: ReturnType<typeof fixture>) {
      for (const [name, bytes] of state.documents) { fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true }); fs.writeFileSync(path.join(input, name), bytes) }
      fs.writeFileSync(path.join(input, state.report.review.path), state.reviewDocument)
      fs.writeFileSync(path.join(input, 'report.json'), JSON.stringify(state.report))
    }
    writeBundle(original)
    const loaded = loadPartialAuthReleaseReport(path.join(input, 'report.json'), { expectedSourceCommit: source })
    writeBundle(replacement)
    expect(loadPartialAuthReleaseReport(path.join(input, 'report.json'), { expectedSourceCommit: source }).summary.candidateBundleSha256).toBe('e'.repeat(64))
    const copiedPath = copyPartialAuthReleaseSnapshot(loaded, path.join(root, 'copied'), { expectedSourceCommit: source })
    const copied = loadPartialAuthReleaseReport(copiedPath, { expectedSourceCommit: source })
    expect(copied.summary.candidateBundleSha256).toBe(H)
    expect(copied.summary.reportBodySha256).toBe(loaded.summary.reportBodySha256)
    expect(copied.summary.evidenceManifestSha256).toBe(loaded.summary.evidenceManifestSha256)
  })
  it.runIf(process.platform === 'darwin')('preserves safe framework symlinks but rejects ZIP link escapes/types before extraction', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-app-zip-'))); roots.push(root)
    const python = String.raw`import sys,zipfile,stat,json
entries=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name,kind,body in entries:
  i=zipfile.ZipInfo(name);i.create_system=3
  i.external_attr=((stat.S_IFDIR|0o755) if kind=='dir' else (stat.S_IFLNK|0o777) if kind=='link' else (stat.S_IFIFO|0o600) if kind=='fifo' else (stat.S_IFREG|0o644))<<16
  z.writestr(i,body)
`
    const common = [['Tide Mind.app/', 'dir', ''], ['Tide Mind.app/Contents/', 'dir', ''],
      ['Tide Mind.app/Contents/Versions/', 'dir', ''], ['Tide Mind.app/Contents/Versions/A/', 'dir', ''],
      ['Tide Mind.app/Contents/Versions/A/engine', 'file', 'fixture'],
      ['Tide Mind.app/Contents/Versions/Current', 'link', 'A'], ['Tide Mind.app/Contents/Engine', 'link', 'Versions/Current/engine']]
    const cases = [[], [['Tide Mind.app/Contents/escape', 'link', '/etc']],
      [['Tide Mind.app/Contents/escape', 'link', '../../outside']],
      [['Tide Mind.app/Contents/Versions/Current/new', 'file', 'must not traverse link']],
      [['Tide Mind.app/Contents/pipe', 'fifo', '']],
      [['Tide Mind.app/Contents/a', 'link', 'b'], ['Tide Mind.app/Contents/b', 'link', 'a']],
      [['Tide Mind.app/Contents/shift', 'link', '..'], ['Tide Mind.app/Contents/outside', 'file', 'decoy'], ['Tide Mind.app/Contents/indirect', 'link', 'shift/../outside']],
      [['Tide Mind.app/Contents/engine', 'file', 'case collision']]]
    for (const [index, entries] of cases.entries()) {
      const archive = path.join(root, `${index}.zip`), destination = path.join(root, `out-${index}`), snapshot = path.join(root, `snapshot-${index}.zip`)
      execFileSync('/usr/bin/python3', ['-I', '-S', '-c', python, archive, JSON.stringify([...common, ...entries])])
      const perform = () => extractPartialCandidateAppArchive(archive, hash(fs.readFileSync(archive)), destination, snapshot)
      if (index === 0) {
        expect(perform().symlinks).toBe(2)
        expect(fs.readlinkSync(path.join(destination, 'Tide Mind.app/Contents/Engine'))).toBe('Versions/Current/engine')
      } else { expect(perform).toThrow(); expect(fs.existsSync(destination)).toBe(false) }
    }
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false)
  })
  it('loads only an exact sealed regular-file bundle, rejecting unlisted files and linked evidence', () => {
    const state = fixture(), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-release-fixture-'))); roots.push(root)
    for (const [name, bytes] of state.documents) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes) }
    fs.writeFileSync(path.join(root, state.report.review.path), state.reviewDocument)
    const reportPath = path.join(root, 'report.json'); fs.writeFileSync(reportPath, JSON.stringify(state.report))
    expect(loadPartialAuthReleaseReport(reportPath, { expectedSourceCommit: source }).summary.physicalVerified).toBe(false)
    fs.writeFileSync(path.join(root, 'extra'), 'unlisted')
    expect(() => loadPartialAuthReleaseReport(reportPath, { expectedSourceCommit: source })).toThrow(/file set/)
    fs.unlinkSync(path.join(root, 'extra'))
    fs.renameSync(path.join(root, 'raw-observation.txt'), path.join(root, 'moved-raw'))
    fs.symlinkSync('moved-raw', path.join(root, 'raw-observation.txt'))
    expect(() => loadPartialAuthReleaseReport(reportPath, { expectedSourceCommit: source })).toThrow()
  })
})
