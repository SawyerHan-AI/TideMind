import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'
// @ts-expect-error plain ESM scripts
import { loadSubscriptionRequirements, subscriptionCaptureScope, validateSubscriptionAcceptance, verifySubscriptionReleaseEvidence } from '../../scripts/verify-local-subscription-acceptance.mjs'
// @ts-expect-error plain ESM script
import { parseArgs, subscriptionAcceptanceArguments } from '../../scripts/release.mjs'

function capture(appVersion = '0.2.95') {
  const requirements = loadSubscriptionRequirements(appVersion)
  const files = new Map<string, any>()
  let serial = 0
  const index: any = {
    schemaVersion: 1, evidenceClass: 'real_subscription', appVersion,
    sourceCommit: 'a'.repeat(40), requirementsSha256: requirements.sha256,
    captureNonce: 'b'.repeat(64), captureCreatedAt: '2026-10-23T01:00:00.000Z',
    collectedBy: 'operator', reviewedBy: 'reviewer', reviewedAt: '2026-10-23T03:00:00.000Z',
    candidateAppsByArchitecture: { arm64: { bundleSha256: 'c'.repeat(64) } },
    providers: [], deferredProviders: [],
  }
  const save = (value: any) => {
    const name = `evidence/${++serial}.json`
    files.set(name, value)
    return name
  }
  const receipt = (binding: any, kind: string, fields: any = {}) => save({
    kind, validationMode: 'real_subscription', sourceCommit: index.sourceCommit, appVersion: index.appVersion,
    captureNonce: index.captureNonce, candidateBundleSha256: index.candidateAppsByArchitecture.arm64.bundleSha256,
    observedAt: '2026-10-23T02:00:00.000Z', binding: structuredClone(binding), billingSource: 'official_subscription',
    authMethod: binding.provider === 'codex-cli' ? 'chatgpt' : 'claude.ai', ...fields,
  })
  const invoke = (binding: any, context: string, mode = 'pinned_id', taskId: string | null = null, outputKind = 'text', pinnedModel = 'test-model-1', operationName = 'annotate') => {
    const invocationId = `invocation-${serial + 1}`
    const requestedModel = mode === 'follow_default' ? 'default' : mode === 'alias' ? 'sonnet' : pinnedModel
    const outputFile = save({ invocationId, text: outputKind === 'text' ? 'synthetic subject response' : '{"summary":"synthetic subject"}',
      actualModel: mode === 'pinned_id' ? requestedModel : null, modelObservability: 'CLI does not expose resolved model',
      outputKind })
    return receipt(binding, 'invocation', { invocationId, executionContext: context,
      cliPurpose: context === 'connection_test' ? context : 'background', outcome: 'completed',
      selectedConnectionId: binding.connectionId, executedConnectionId: binding.connectionId, fallbackUsed: false,
      requestedModel, modelArgument: mode === 'follow_default' ? null : requestedModel,
      selectionMode: mode, taskId, operationName, outputFile,
      ledgerFile: save({ id: invocationId, connection_id: binding.connectionId, provider_type: binding.provider,
        account_scope: binding.scopeKey, model_alias: requestedModel, actual_model: mode === 'pinned_id' ? requestedModel : null,
        task_id: taskId, operation_name: operationName, outcome: 'success', prompt_committed: 1,
        started_at: '2026-10-23T01:59:59.000Z', finished_at: '2026-10-23T02:00:01.000Z' }) })
  }
  for (const provider of requirements.providers) {
    const binding = { provider, connectionId: provider + '-connection', cliPath: '/test/bin/' + provider,
      cliVersion: 'test-version', cliGeneration: 'd'.repeat(64), scopeState: 'known',
      scopeKey: provider + ':' + 'e'.repeat(64), authEpoch: 1 }
    const routes: any = {
      foreground: { connectionId: binding.connectionId, provider, purpose: 'dedup-merge', modelId: 'test-foreground-model', enabled: true },
      background: { connectionId: binding.connectionId, provider, purpose: 'annotate', modelId: 'test-model-1', enabled: true },
    }
    const steps: any = {}
    steps.B1 = receipt(binding, 'environment', { status: 'ready', cliProbeFile: save({ version: 'test-version', auth: 'official subscription' }) })
    steps.B2 = receipt(binding, 'catalog', { source: provider === 'codex-cli' ? 'codex_app_server' : 'claude_aliases',
      refreshAttemptFile: save({ status: 'refreshed' }), modelIds: ['test-model-1'], fallbackExplanation: 'Official family aliases, not a dynamic catalog' })
    steps.B3 = receipt(binding, 'selection_tests', { modes: requirements.selectionModes[provider].map((mode: string) => ({
      mode, status: 'tested', invocationFile: invoke(binding, 'connection_test', mode),
    })) })
    const readback = (processId: string) => receipt(binding, 'configuration_readback', { processId, routes: structuredClone(routes), connection: { id: binding.connectionId, provider } })
    steps.B4 = receipt(binding, 'persistence', { backgroundEnabledBeforeTest: false, backgroundEnabledAfterTest: false,
      saved: readback('first'), reopened: readback('first'), restarted: readback('second') })
    for (const [step, context] of [['B5', 'foreground'], ['B6', 'background']]) {
      const taskId = step === 'B5' ? null : 'annotate'
      const route = routes[context]
      const operationName = step === 'B5' ? 'dedup' : 'annotate'
      const invocationFile = invoke(binding, context, 'pinned_id', taskId, step === 'B6' ? 'structured' : 'text', route.modelId, operationName)
      const invocation = files.get(invocationFile)
      const resultFile = save({ taskId, invocationId: invocation.invocationId, state: 'completed',
        resultSummary: 'synthetic business completed', operationName })
      steps[step] = receipt(binding, step === 'B5' ? 'foreground_business' : 'worker_business', {
        entrypoint: step === 'B5' ? 'brain_digest' : 'annotate', route, taskId, terminalState: 'completed', invocationFile,
        resultFile, operationName, origin: 'scheduler-worker', workerThreadId: 2, schedulerTaskId: 'annotate',
        ...(step === 'B6' ? { workerEventsFile: save([
          { observedAt: '2026-10-23T01:59:57.000Z', message: { protocolVersion: 1, lifecycleGeneration: 1, kind: 'scheduler_pass_started', executionThreadId: 2 } },
          { observedAt: '2026-10-23T01:59:58.000Z', message: { protocolVersion: 1, lifecycleGeneration: 1, kind: 'task_started', taskId } },
          { observedAt: '2026-10-23T01:59:59.000Z', message: { protocolVersion: 1, lifecycleGeneration: 1, kind: 'active_llm_task_started', taskId, connectionId: binding.connectionId, origin: 'scheduler-worker' } },
          { observedAt: '2026-10-23T02:00:02.000Z', message: { protocolVersion: 1, lifecycleGeneration: 1, kind: 'task_finished', taskId } },
          { observedAt: '2026-10-23T02:00:03.000Z', message: { protocolVersion: 1, lifecycleGeneration: 1, kind: 'scheduler_pass_finished', executionThreadId: 2 } },
        ]) } : {}),
      })
    }
    steps.B7 = receipt(binding, 'recovery', { cases: requirements.recoveries.map((operation: string) => {
      const before = structuredClone(binding), after = { ...binding, authEpoch: 2 }
      if (operation === 'account_switch') after.scopeKey = provider + ':' + 'f'.repeat(64)
      if (operation === 'cli_change') after.cliGeneration = 'f'.repeat(64)
      return { operation, negativeValidationMode: 'real_transition', before, after,
        transitionFile: receipt(after, 'recovery_transition', { operation, before, after,
          observedInterruption: 'environment/route unavailable until restored', restorationAction: 'official supported recovery',
          oldEvidenceRejectedReason: 'old binding not admitted during interruption' }),
        resumedInvocationFile: invoke(after, 'background'),
      }
    }) })
    index.providers.push({ provider, binding, steps })
  }
  const check = () => validateSubscriptionAcceptance(index, {
    expectedAppVersion: appVersion, expectedSourceCommit: 'a'.repeat(40), requirements,
    readEvidence: (name: string) => {
      if (!files.has(name)) throw new Error('missing evidence')
      return Buffer.from(JSON.stringify(files.get(name)))
    },
  })
  const entry = index.providers[0]
  const step = (name: string) => files.get(entry.steps[name])
  const businessInvocation = () => files.get(step('B5').invocationFile)
  return { index, files, check, entry, step, businessInvocation }
}

describe('independent local subscription acceptance semantics', () => {
  it('retains both provider contracts and all seven independent steps with actual outputs and task records', () => {
    const test = capture()
    expect(test.check()).toMatchObject({ providerCount: 2, stepCount: 14 })
  })
  it('initializes the .94 Codex scope with Claude explicitly deferred and both contracts retained', () => {
    const requirements = loadSubscriptionRequirements('0.2.94')
    expect(requirements.providers).toEqual(['codex-cli', 'claude-cli'])
    expect(requirements.selectionModes['claude-cli']).toEqual(['follow_default', 'alias', 'pinned_id'])
    expect(subscriptionCaptureScope(requirements)).toEqual({ providers: ['codex-cli'], deferredProviders: ['claude-cli'] })
    expect(() => subscriptionCaptureScope({ ...requirements, appVersion: '0.2.93' })).toThrow('only valid for 0.2.94')
  })
  it('accepts all seven Codex steps with explicit Claude deferral, never a Codex deferral', () => {
    const test = capture('0.2.94')
    test.index.providers.pop()
    test.index.deferredProviders = ['claude-cli']
    expect(test.check()).toMatchObject({ providerCount: 1, stepCount: 7, deferredProviders: ['claude-cli'] })
    test.index.providers = []
    test.index.deferredProviders = ['codex-cli', 'claude-cli']
    expect(test.check).toThrow('provider matrix')
  })
  it('rejects unknown or falsely completed deferred providers and policy changes', () => {
    const test = capture('0.2.94'); test.index.providers.pop()
    for (const deferred of [['unknown'], [{ provider: 'claude-cli', status: 'passed' }], ['claude-cli', 'claude-cli']]) {
      test.index.deferredProviders = deferred
      expect(test.check).toThrow('deferred provider matrix')
    }
    const requirements = loadSubscriptionRequirements('0.2.94')
    expect(() => subscriptionCaptureScope({ ...requirements, releaseAcceptance: {
      requiredProviders: [], deferredProviders: ['codex-cli', 'claude-cli'],
    } })).toThrow('0.2.94 release acceptance policy')
  })
  it('keeps requirements hash, candidate identity and every Codex step mandatory in the narrowed scope', () => {
    for (const step of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']) {
      const test = capture('0.2.94'); test.index.providers.pop(); test.index.deferredProviders = ['claude-cli']
      delete test.entry.steps[step]
      expect(test.check).toThrow('B1-B7')
    }
    const test = capture('0.2.94'); test.index.providers.pop(); test.index.deferredProviders = ['claude-cli']
    test.index.requirementsSha256 = '0'.repeat(64)
    expect(test.check).toThrow('requirements hash')
    test.index.requirementsSha256 = loadSubscriptionRequirements('0.2.94').sha256
    test.step('B1').candidateBundleSha256 = '0'.repeat(64)
    expect(test.check).toThrow('receipt candidate')
  })
  it.each(['fixture', 'api', 'real_host'])('rejects %s evidence classes', evidenceClass => {
    const test = capture(); test.index.evidenceClass = evidenceClass
    expect(test.check).toThrow('evidence class')
  })
  it('rejects undeclared provider omission or an incomplete B matrix', () => {
    const requirements = loadSubscriptionRequirements()
    expect(requirements.appVersion).toBe('0.2.95')
    expect(subscriptionCaptureScope(requirements)).toEqual({ providers: ['codex-cli'], deferredProviders: ['claude-cli'] })
    const test = capture(); test.index.providers.pop()
    expect(test.check).toThrow('deferred provider matrix')
    test.index.deferredProviders = ['claude-cli']
    expect(test.check()).toMatchObject({ providerCount: 1, stepCount: 7, deferredProviders: ['claude-cli'] })
    test.index.providers = []
    expect(test.check).toThrow('provider matrix')
    const deferred = capture(); deferred.index.deferredProviders = ['claude-cli']
    expect(deferred.check).toThrow('deferred provider matrix')
    expect(() => subscriptionCaptureScope({ ...loadSubscriptionRequirements('0.2.94'), appVersion: '0.2.96' }))
      .toThrow('only valid for 0.2.94')
    const incomplete = capture(); delete incomplete.entry.steps.B6
    expect(incomplete.check).toThrow('B1-B7')
  })
  it.each(['sourceCommit', 'captureNonce', 'candidateBundleSha256'])('rejects stale receipt %s', key => {
    const test = capture(); test.step('B1')[key] = '9'.repeat(64)
    expect(test.check).toThrow('receipt')
  })
  it('rejects old scope, epoch or CLI binding on a business call', () => {
    for (const key of ['scopeKey', 'authEpoch', 'cliGeneration']) {
      const test = capture(); test.businessInvocation().binding[key] = 'stale'
      expect(test.check).toThrow('binding')
    }
  })
  it('rejects API authentication and alternate provider fallback success', () => {
    const api = capture(); api.step('B1').authMethod = 'api_key'
    expect(api.check).toThrow('official subscription')
    const fallback = capture(); fallback.businessInvocation().fallbackUsed = true
    expect(fallback.check).toThrow('fallback')
    const replaced = capture(); replaced.businessInvocation().executedConnectionId = 'other'
    expect(replaced.check).toThrow('executed connection')
  })
  it('rejects test buttons or direct service calls substituted for business execution', () => {
    for (const entrypoint of ['connections.test', 'service.direct', 'fixture']) {
      const test = capture(); test.step('B5').entrypoint = entrypoint
      expect(test.check).toThrow('business')
    }
    const test = capture(); test.businessInvocation().executionContext = 'connection_test'
    expect(test.check).toThrow('execution context')
  })
  it('rejects missing output, model substitution and fake Worker completion', () => {
    const missing = capture(); missing.files.get(missing.businessInvocation().outputFile).text = ''
    expect(missing.check).toThrow('output text')
    const mismatch = capture(); mismatch.files.get(mismatch.businessInvocation().outputFile).actualModel = 'other'
    expect(mismatch.check).toThrow('actual model mismatch')
    const worker = capture(); worker.step('B6').origin = 'service'
    expect(worker.check).toThrow('background origin')
    const unfinished = capture(); unfinished.files.get(unfinished.step('B6').resultFile).state = 'started'
    expect(unfinished.check).toThrow('result state')
  })
  it('rejects persistence changes and missing actual restart', () => {
    const changed = capture()
    changed.files.get(changed.step('B4').restarted).routes.foreground.modelId = 'different'
    expect(changed.check).toThrow('restarted route')
    const restart = capture(); restart.files.get(restart.step('B4').restarted).processId = 'first'
    expect(restart.check).toThrow('restart')
  })
  it('keeps distinct foreground/background purpose routes and models on the same connection', () => {
    const test = capture()
    expect(test.step('B5').route.purpose).toBe('dedup-merge')
    expect(test.step('B6').route.purpose).toBe('annotate')
    expect(test.step('B5').route.modelId).not.toBe(test.step('B6').route.modelId)
    expect(test.check()).toMatchObject({ stepCount: 14 })
    test.step('B5').route = test.step('B6').route
    expect(test.check).toThrow('business persisted purpose route')
  })
  it('requires all recovery cases and rejects reuse of an earlier scope after account switch', () => {
    const test = capture(); test.step('B7').cases.pop()
    expect(test.check).toThrow('recovery matrix')
    const stale = capture(); const item = stale.step('B7').cases.find((c: any) => c.operation === 'account_switch')
    stale.files.get(item.resumedInvocationFile).binding = item.before
    expect(stale.check).toThrow('binding')
  })

  it('allows only mapped negative regressions while recovery remains a separate real current-account call', () => {
    const test = capture()
    const item = test.step('B7').cases.find((c: any) => c.operation === 'account_switch')
    delete item.before; delete item.after; delete item.transitionFile
    item.negativeValidationMode = 'controlled_regression'
    item.realTriggerLimitation = 'No second official subscription account; do not purchase or change daily credentials'
    item.regressionEvidenceFile = 'evidence/negative-regression.json'
    const required = loadSubscriptionRequirements().controlledNegativeRegressions.account_switch[0]
    const report = { success: true, numFailedTests: 0, testResults: [{
      name: '/checkout/' + required.testFile,
      assertionResults: [{ title: required.title, status: 'passed' }],
    }] }
    test.files.set(item.regressionEvidenceFile, { kind: 'controlled_negative_regression', operation: 'account_switch',
      sourceCommit: test.index.sourceCommit, reportFile: 'evidence/vitest-report.json' })
    test.files.set('evidence/vitest-report.json', report)
    const resumed = test.files.get(item.resumedInvocationFile)
    resumed.binding = structuredClone(test.entry.binding)
    test.files.get(resumed.ledgerFile).account_scope = test.entry.binding.scopeKey
    expect(test.check()).toMatchObject({ stepCount: 14 })
    report.testResults[0].assertionResults[0].title = 'unrelated passing test'
    expect(test.check).toThrow('required relevant negative regression')
    report.testResults[0].assertionResults[0].title = required.title
    resumed.validationMode = 'fixture'
    expect(test.check).toThrow('receipt validation mode')
    resumed.validationMode = 'real_subscription'
    test.files.get(item.regressionEvidenceFile).sourceCommit = 'f'.repeat(40)
    expect(test.check).toThrow('negative evidence source')
  })
  it('permits same known epoch on same-account logout/login recovery', () => {
    const test = capture(); const item = test.step('B7').cases.find((c: any) => c.operation === 'logout_login')
    item.after.authEpoch = 1
    test.files.get(item.transitionFile).binding.authEpoch = 1
    test.files.get(item.resumedInvocationFile).binding.authEpoch = 1
    expect(test.check()).toMatchObject({ stepCount: 14 })
  })
})

describe('release B gate integration', () => {
  it.each(['0.2.94', '0.2.95'])('requires B for %s formal release', version => {
    const options = parseArgs(['--subscription-evidence', '/tmp/B/index.json'])
    expect(subscriptionAcceptanceArguments(version, options, 'source', { arm64: '/tmp/RC.app' }))
      .toContain('/tmp/B/index.json')
    expect(subscriptionAcceptanceArguments('0.2.93', options, 'source', {})).toBeNull()
    expect(subscriptionAcceptanceArguments(version, { ...options, prepareCandidate: true }, 'source', {})).toBeNull()
  })
  it('pairs A and B at initial validation and evidence copying', () => {
    const source = fs.readFileSync(path.resolve('scripts/release.mjs'), 'utf8')
    expect(source).toContain("if (subscriptionVerifierArgs) run('node', subscriptionVerifierArgs")
    expect(source).toContain("if (subscriptionVerifierArgs) run('node', [...subscriptionVerifierArgs, '--copy-to'")
    expect(source).toContain("} else run('node', acceptanceVerifierArgs")
    expect(source).toContain("} else run('node', [...acceptanceVerifierArgs, '--copy-to'")
  })
})

describe('subscription evidence bundle and publish CI binding', () => {
  it('rechecks indexed bytes and matches the A-verified packaged candidate', () => {
    const test = capture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-bundle-'))
    try {
      test.index.files = [...test.files].map(([name, value]) => {
        const bytes = Buffer.from(JSON.stringify(value))
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
        fs.writeFileSync(path.join(root, name), bytes)
        return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
      })
      const indexPath = path.join(root, 'index.json')
      fs.writeFileSync(indexPath, JSON.stringify(test.index))
      const options = { indexPath, expectedAppVersion: test.index.appVersion, expectedSourceCommit: test.index.sourceCommit }
      expect(verifySubscriptionReleaseEvidence(options, test.index.candidateAppsByArchitecture)).toMatchObject({ status: 'passed', stepCount: 14 })
      expect(() => verifySubscriptionReleaseEvidence(options, { arm64: { bundleSha256: '9'.repeat(64) } })).toThrow('accepted signed candidate')
      fs.appendFileSync(path.join(root, test.index.files[0].path), 'tampered')
      expect(() => verifySubscriptionReleaseEvidence(options, test.index.candidateAppsByArchitecture)).toThrow('bytes/hash')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('requires existing invocation ledger and actual Worker sequence, not invented run IDs', () => {
    const test = capture()
    test.files.get(test.businessInvocation().ledgerFile).outcome = 'running'
    expect(test.check).toThrow('ledger outcome')
    const worker = capture()
    worker.files.get(worker.step('B6').workerEventsFile)[2].message.connectionId = 'different'
    expect(worker.check).toThrow('Worker LLM connection')
    const missing = capture()
    missing.files.get(missing.step('B6').workerEventsFile).splice(1, 1)
    expect(missing.check).toThrow('Worker execution sequence')
  })

  it('uses the existing annotate task without conflating digest work items with scheduler IDs', () => {
    const test = capture()
    test.step('B6').schedulerTaskId = 'digest-retry'
    expect(test.check).toThrow('acceptance scheduler task')
  })
  it('allows delayed main-thread receipt of Worker messages without comparing it to database clock boundaries', () => {
    const test = capture()
    const events = test.files.get(test.step('B6').workerEventsFile)
    events.forEach((event: any, i: number) => { event.observedAt = `2026-10-23T02:01:0${i}.000Z` })
    expect(test.check()).toMatchObject({ stepCount: 14 })
  })
  it('requires B at both candidate check and publish artifact verification', () => {
    const privateWorkflow = path.resolve('oss-release/.github/workflows/release.yml')
    const workflow = fs.readFileSync(fs.existsSync(privateWorkflow)
      ? privateWorkflow : path.resolve('.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('requiresSubscriptionAcceptance(process.argv[1])')
    expect(workflow).toContain('node scripts/verify-local-subscription-acceptance.mjs')
    expect(workflow).toContain('--subscription-index "release-evidence/local-subscription-acceptance/$version/index.json"')
    const verifier = fs.readFileSync(path.resolve('scripts/verify-agent-host-release-artifacts.mjs'), 'utf8')
    expect(verifier).toContain('if (requiresSubscriptionAcceptance(appVersion))')
    expect(verifier).toContain("argument('--subscription-index')")
  })
})
