#!/usr/bin/env node
/** Independent B acceptance. Human captures are checked against their read-back
 * records; this is not a replacement for the real subscribed account or review. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { candidateAppsIdentityHash } from './verify-agent-integration-host-acceptance.mjs'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const requirementsPath = path.join(here, 'local-subscription-acceptance-requirements.json')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const same = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch`)
}
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} missing`)
}
const hash = (value, label) => {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} invalid`)
}
const time = (value, label) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} invalid`)
  return Date.parse(value)
}
const list = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
export function loadSubscriptionRequirements(appVersion) {
  const file = appVersion === '0.2.94'
    ? path.join(here, 'local-subscription-acceptance-requirements-0.2.94.json')
    : requirementsPath
  const bytes = fs.readFileSync(file)
  return { ...JSON.parse(bytes), sha256: digest(bytes) }
}
/** The .94 release narrows real acceptance only; both provider contracts remain. */
export function subscriptionCaptureScope(requirements = loadSubscriptionRequirements()) {
  same(requirements.providers, ['codex-cli', 'claude-cli'], 'supported provider contracts')
  if (requirements.appVersion !== '0.2.94') {
    if (requirements.releaseAcceptance) throw new Error('release acceptance policy is only valid for 0.2.94')
    return { providers: requirements.providers, deferredProviders: [] }
  }
  same(requirements.releaseAcceptance, {
    requiredProviders: ['codex-cli'], deferredProviders: ['claude-cli'],
  }, '0.2.94 release acceptance policy')
  return { providers: requirements.releaseAcceptance.requiredProviders,
    deferredProviders: requirements.releaseAcceptance.deferredProviders }
}
function relative(value) {
  text(value, 'evidence path')
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid evidence path')
  return value
}
function readFile(root, name) {
  const file = path.join(root, relative(name))
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 10 * 1024 * 1024
    || !fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error('invalid evidence file')
  return fs.readFileSync(file)
}
function knownBinding(binding, provider) {
  same(binding.provider, provider, 'provider binding')
  text(binding.connectionId, 'connectionId')
  text(binding.cliPath, 'cliPath')
  if (!path.isAbsolute(binding.cliPath)) throw new Error('CLI path must be absolute')
  text(binding.cliVersion, 'cliVersion')
  hash(binding.cliGeneration, 'cliGeneration')
  same(binding.scopeState, 'known', 'scope state')
  if (!new RegExp(`^${provider}:[a-f0-9]{64}$`).test(binding.scopeKey ?? '')) throw new Error('known scope required')
  if (!Number.isSafeInteger(binding.authEpoch) || binding.authEpoch < 1) throw new Error('auth epoch invalid')
}
function auth(record, provider) {
  same(record.billingSource, 'official_subscription', 'billing source')
  const methods = provider === 'codex-cli' ? ['chatgpt'] : ['claude.ai', 'oauth', 'subscription']
  if (!methods.includes(record.authMethod)) throw new Error('official subscription authentication required')
}

/** Pure semantic checks used by both capture validation and the formal verifier.
 * readEvidence reads only previously hash-checked, indexed files. */
export function validateSubscriptionAcceptance(index, { expectedAppVersion, expectedSourceCommit, readEvidence, requirements = loadSubscriptionRequirements() }) {
  same(index.schemaVersion, 1, 'subscription schema')
  same(index.evidenceClass, 'real_subscription', 'evidence class')
  same(index.appVersion, expectedAppVersion, 'app version')
  same(index.appVersion, requirements.appVersion, 'requirements version')
  same(index.sourceCommit, expectedSourceCommit, 'source commit')
  if (!/^[a-f0-9]{40,64}$/.test(index.sourceCommit ?? '')) throw new Error('source commit invalid')
  same(index.requirementsSha256, requirements.sha256, 'requirements hash')
  hash(index.captureNonce, 'capture nonce')
  text(index.collectedBy, 'collector')
  text(index.reviewedBy, 'reviewer')
  if (index.collectedBy.trim().toLowerCase() === index.reviewedBy.trim().toLowerCase()) throw new Error('independent review required')
  const start = time(index.captureCreatedAt, 'capture time')
  const end = time(index.reviewedAt, 'review time')
  if (end < start) throw new Error('review precedes capture')
  const used = new Set()
  const read = name => {
    relative(name)
    used.add(name)
    return readEvidence(name)
  }
  const json = name => JSON.parse(read(name).toString('utf8'))
  const record = (name, provider, binding, kind) => {
    const value = json(name)
    same(value.kind, kind, 'receipt kind')
    same(value.validationMode, 'real_subscription', 'receipt validation mode')
    same(value.sourceCommit, index.sourceCommit, 'receipt source')
    same(value.appVersion, index.appVersion, 'receipt version')
    same(value.captureNonce, index.captureNonce, 'receipt capture')
    same(value.candidateBundleSha256, index.candidateAppsByArchitecture.arm64.bundleSha256, 'receipt candidate')
    same(value.binding, binding, 'receipt scope/epoch/CLI binding')
    knownBinding(value.binding, provider)
    auth(value, provider)
    const observed = time(value.observedAt, 'receipt time')
    if (observed < start || observed > end) throw new Error('receipt outside capture/review interval')
    return value
  }
  const invocationIds = new Set()
  const invocation = (name, provider, binding, purpose) => {
    const value = record(name, provider, binding, 'invocation')
    same(value.executionContext, purpose, 'invocation execution context')
    same(value.cliPurpose, purpose === 'connection_test' ? 'connection_test' : 'background', 'CLI purpose')
    same(value.outcome, 'completed', 'invocation outcome')
    same(value.selectedConnectionId, binding.connectionId, 'selected connection')
    same(value.executedConnectionId, binding.connectionId, 'executed connection')
    same(value.fallbackUsed, false, 'fallback use')
    text(value.invocationId, 'invocation id')
    if (invocationIds.has(value.invocationId)) throw new Error('invocation reused across acceptance cases')
    invocationIds.add(value.invocationId)
    text(value.requestedModel, 'requested model')
    if (!['follow_default', 'alias', 'pinned_id'].includes(value.selectionMode)) throw new Error('selection mode invalid')
    if (value.selectionMode === 'follow_default') {
      same(value.requestedModel, 'default', 'default selection')
      same(value.modelArgument, null, 'default model argument')
    } else same(value.modelArgument, value.requestedModel, 'requested model argument')
    // Existing cli_invocations row, exported after completion (no invented task/run IDs).
    const ledger = json(value.ledgerFile)
    same(ledger.id, value.invocationId, 'ledger invocation')
    same(ledger.connection_id, binding.connectionId, 'ledger connection')
    same(ledger.provider_type, provider, 'ledger provider')
    same(ledger.account_scope, binding.scopeKey, 'ledger account')
    same(ledger.model_alias, value.requestedModel, 'ledger selected model')
    same(ledger.task_id, value.taskId, 'ledger task')
    same(ledger.operation_name, value.operationName, 'ledger operation')
    same(ledger.outcome, 'success', 'ledger outcome')
    same(ledger.prompt_committed, 1, 'ledger prompt')
    const invocationStart = time(ledger.started_at, 'invocation start')
    const invocationEnd = time(ledger.finished_at, 'invocation finish')
    if (invocationStart < start || invocationEnd < invocationStart || invocationEnd > end) throw new Error('invocation interval invalid')
    const output = json(value.outputFile)
    same(output.invocationId, value.invocationId, 'output invocation')
    text(output.text, 'actual output text')
    if (output.actualModel === null) text(output.modelObservability, 'actual model observability limitation')
    else {
      text(output.actualModel, 'actual model')
      if (value.selectionMode === 'pinned_id'
        && output.actualModel !== value.requestedModel
        && !(output.actualModel.startsWith(value.requestedModel + '-')
          && /^-\d{8}$/.test(output.actualModel.slice(value.requestedModel.length)))) throw new Error('actual model mismatch')
    }
    if (!['text', 'structured'].includes(output.outputKind)) throw new Error('output kind invalid')
    if (output.outputKind === 'structured') {
      const parsed = JSON.parse(output.text)
      if (!parsed || typeof parsed !== 'object') throw new Error('structured output must be an object or array')
    }
    same(ledger.actual_model, output.actualModel, 'ledger actual model')
    return { ...value, output, invocationStart, invocationEnd }
  }
  const scope = subscriptionCaptureScope(requirements)
  const providers = list(index.providers, 'providers').map(p => p.provider)
  const deferredProviders = list(index.deferredProviders, 'deferred providers')
  if (new Set(providers).size !== providers.length || providers.some(p => !requirements.providers.includes(p))
    || scope.providers.some(p => !providers.includes(p))) throw new Error('provider matrix mismatch')
  same([...deferredProviders].sort(), scope.deferredProviders.filter(p => !providers.includes(p)).sort(), 'deferred provider matrix')
  for (const entry of index.providers) {
    const { provider, binding, steps } = entry
    knownBinding(binding, provider)
    same(Object.keys(steps ?? {}).sort(), [...requirements.steps].sort(), 'B1-B7 matrix')
    const environment = record(steps.B1, provider, binding, 'environment')
    same(environment.status, 'ready', 'environment status')
    text(environment.cliProbeFile, 'CLI probe evidence')
    text(read(environment.cliProbeFile).toString('utf8'), 'CLI probe output')

    const catalog = record(steps.B2, provider, binding, 'catalog')
    const sources = provider === 'codex-cli' ? ['codex_app_server', 'unsupported', 'failed'] : ['claude_aliases', 'unsupported', 'failed']
    if (!sources.includes(catalog.source)) throw new Error('catalog source invalid')
    text(catalog.refreshAttemptFile, 'catalog attempt')
    text(read(catalog.refreshAttemptFile).toString('utf8'), 'catalog attempt output')
    if (catalog.source !== 'codex_app_server') text(catalog.fallbackExplanation, 'catalog fallback explanation')
    else if (!list(catalog.modelIds, 'catalog model IDs').length) throw new Error('dynamic catalog empty')

    const selections = record(steps.B3, provider, binding, 'selection_tests')
    same(list(selections.modes, 'selection modes').map(m => m.mode).sort(), [...requirements.selectionModes[provider]].sort(), 'selection matrix')
    const outputs = []
    for (const selection of selections.modes) {
      if (selection.status === 'unsupported') {
        text(selection.interfaceReason, 'unsupported mode reason')
        text(read(selection.interfaceEvidenceFile).toString('utf8'), 'unsupported mode interface evidence')
      } else {
        same(selection.status, 'tested', 'selection status')
        const result = invocation(selection.invocationFile, provider, binding, 'connection_test')
        same(result.selectionMode, selection.mode, 'selection invocation mode')
        outputs.push(result.output.outputKind)
      }
    }
    if (!outputs.length) throw new Error('at least one real model selection required')

    const saved = record(steps.B4, provider, binding, 'persistence')
    same(saved.backgroundEnabledBeforeTest, saved.backgroundEnabledAfterTest, 'test changed background authorization')
    if (typeof saved.backgroundEnabledBeforeTest !== 'boolean') throw new Error('background authorization missing')
    const reads = ['saved', 'reopened', 'restarted'].map(phase => {
      const value = record(saved[phase], provider, binding, 'configuration_readback')
      text(value.processId, 'read-back process')
      same(Object.keys(value.routes ?? {}).sort(), ['background', 'foreground'], 'saved purpose routes')
      for (const route of Object.values(value.routes)) {
        same(route.connectionId, binding.connectionId, 'saved route connection')
        same(route.provider, provider, 'saved route provider')
        text(route.purpose, 'saved route purpose')
        text(route.modelId, 'saved route model')
        same(route.enabled, true, 'explicit enabled route')
      }
      same(value.connection.id, binding.connectionId, 'saved connection')
      same(value.connection.provider, provider, 'saved provider')
      return value
    })
    same(reads[1].routes, reads[0].routes, 'reopened routes')
    same(reads[2].routes, reads[0].routes, 'restarted routes')
    same(reads[1].connection, reads[0].connection, 'reopened connection')
    same(reads[2].connection, reads[0].connection, 'restarted connection')
    if (reads[2].processId === reads[0].processId) throw new Error('application restart not observed')

    for (const [step, kind, purpose] of [['B5', 'foreground_business', 'foreground'], ['B6', 'worker_business', 'background']]) {
      const business = record(steps[step], provider, binding, kind)
      text(business.entrypoint, 'business entrypoint')
      if (/test|service.direct|fixture/i.test(business.entrypoint)) throw new Error('test/service entrypoint cannot prove business')
      same(business.route, reads[0].routes[purpose], 'business persisted purpose route')
      same(business.terminalState, 'completed', 'business terminal state')
      if (business.taskId !== null) text(business.taskId, 'business task')
      text(business.operationName, 'business operation')
      const result = invocation(business.invocationFile, provider, binding, purpose)
      same(result.taskId, business.taskId, 'business task invocation')
      same(result.operationName, business.operationName, 'business operation invocation')
      same(result.requestedModel, business.route.modelId, 'business route model')
      const terminal = json(business.resultFile)
      same(terminal.taskId, business.taskId, 'business result task')
      same(terminal.operationName, business.operationName, 'business result operation')
      same(terminal.invocationId, result.invocationId, 'business result invocation')
      same(terminal.state, 'completed', 'business result state')
      text(terminal.resultSummary, 'business result')
      if (step === 'B6') {
        same(business.origin, 'scheduler-worker', 'background origin')
        // This matrix chooses the existing annotate task, whose context has no
        // workItemId override. digest-retry's ledger task_id is a work item and
        // must not be represented as its scheduler task name.
        same(business.schedulerTaskId, 'annotate', 'acceptance scheduler task')
        same(business.taskId, business.schedulerTaskId, 'annotate invocation task')
        if (!Number.isSafeInteger(business.workerThreadId) || business.workerThreadId < 1) throw new Error('actual worker thread required')
        const events = list(json(business.workerEventsFile), 'Worker events')
        const kinds = ['scheduler_pass_started', 'task_started', 'active_llm_task_started', 'task_finished', 'scheduler_pass_finished']
        // An isolated acceptance pass captures the actual protocol messages in order.
        same(events.map(e => e.message.kind), kinds, 'Worker execution sequence')
        const generation = events[0].message.lifecycleGeneration
        if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Worker generation missing')
        let previousAt = start
        for (const event of events) {
          same(event.message.protocolVersion, 1, 'Worker protocol')
          same(event.message.lifecycleGeneration, generation, 'Worker generation')
          const observed = time(event.observedAt, 'Worker observation')
          if (observed < previousAt || observed > end) throw new Error('Worker sequence time invalid')
          previousAt = observed
        }
        for (const position of [0, 4]) same(events[position].message.executionThreadId, business.workerThreadId, 'Worker execution thread')
        for (const position of [1, 2, 3]) same(events[position].message.taskId, business.schedulerTaskId, 'Worker task event')
        same(events[2].message.origin, 'scheduler-worker', 'Worker LLM origin')
        same(events[2].message.connectionId, binding.connectionId, 'Worker LLM connection')
        // observedAt is receipt time in the collector. postMessage delivery may
        // lag behind SQLite timestamps; never compare those as emitted times.
      }
      outputs.push(result.output.outputKind)
    }
    if (!outputs.includes('text') || !outputs.includes('structured')) throw new Error('text and structured output evidence required')

    const recovery = record(steps.B7, provider, binding, 'recovery')
    same(list(recovery.cases, 'recovery cases').map(c => c.operation).sort(), [...requirements.recoveries].sort(), 'recovery matrix')
    for (const item of recovery.cases) {
      if (item.negativeValidationMode === 'controlled_regression') {
        const requiredCases = requirements.controlledNegativeRegressions[item.operation]
        if (!requiredCases) throw new Error('controlled negative case has no reviewed regression mapping')
        text(item.realTriggerLimitation, 'real transition limitation')
        if ('before' in item || 'after' in item) throw new Error('controlled state must not impersonate actual account bindings')
        const regression = json(item.regressionEvidenceFile)
        same(regression.kind, 'controlled_negative_regression', 'negative evidence kind')
        same(regression.operation, item.operation, 'negative evidence operation')
        same(regression.sourceCommit, index.sourceCommit, 'negative evidence source')
        const report = json(regression.reportFile)
        same(report.success, true, 'regression report success')
        same(report.numFailedTests, 0, 'regression report failures')
        for (const required of requiredCases) {
          const matchedFile = list(report.testResults, 'regression test files').find(file =>
            typeof file.name === 'string' && file.name.replaceAll('\\', '/').endsWith('/' + required.testFile))
          const matchedCase = matchedFile?.assertionResults?.find(test => test.title === required.title)
          if (!matchedCase || matchedCase.status !== 'passed') throw new Error('required relevant negative regression not passed')
        }
        // Only the failure transition is controlled. Successful recovery remains a
        // distinct, real subscribed invocation under the current actual binding.
        invocation(item.resumedInvocationFile, provider, binding, 'background')
        continue
      }
      same(item.negativeValidationMode, 'real_transition', 'negative validation mode')
      knownBinding(item.before, provider)
      knownBinding(item.after, provider)
      same(item.before.connectionId, binding.connectionId, 'recovery original connection')
      same(item.after.connectionId, binding.connectionId, 'recovery connection')
      const transition = record(item.transitionFile, provider, item.after, 'recovery_transition')
      same(transition.operation, item.operation, 'recovery operation')
      same(transition.before, item.before, 'recovery before')
      same(transition.after, item.after, 'recovery after')
      text(transition.observedInterruption, 'recovery interruption')
      text(transition.restorationAction, 'recovery action')
      if (item.operation === 'account_switch' && (item.before.scopeKey === item.after.scopeKey || item.after.authEpoch <= item.before.authEpoch)) throw new Error('account switch must change scope and advance epoch')
      if (item.operation === 'cli_change' && item.before.cliGeneration === item.after.cliGeneration) throw new Error('CLI change not observed')
      if (['account_switch', 'logout_login', 'cli_change'].includes(item.operation)) text(transition.oldEvidenceRejectedReason, 'old evidence rejection')
      invocation(item.resumedInvocationFile, provider, item.after, 'background')
    }
  }
  return { usedFiles: [...used], deferredProviders, providerCount: index.providers.length, stepCount: index.providers.length * requirements.steps.length }
}

function verifyBundle({ indexPath, expectedAppVersion, expectedSourceCommit }, acceptedCandidates) {
  const absolute = path.resolve(indexPath)
  const root = fs.realpathSync(path.dirname(absolute))
  const index = JSON.parse(readFile(root, path.basename(absolute)))
  const files = new Map()
  let total = 0
  for (const file of list(index.files, 'evidence files')) {
    relative(file.path)
    if (file.path === path.basename(absolute) || files.has(file.path)) throw new Error('duplicate/self evidence')
    hash(file.sha256, 'evidence hash')
    const bytes = readFile(root, file.path)
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('evidence bytes/hash mismatch')
    total += bytes.length
    if (files.size >= 2048 || total > 100 * 1024 * 1024) throw new Error('evidence bundle too large')
    files.set(file.path, bytes)
  }
  same(Object.keys(index.candidateAppsByArchitecture ?? {}), ['arm64'], 'candidate architectures')
  same(index.candidateAppsByArchitecture, acceptedCandidates, 'accepted signed candidate')
  const result = validateSubscriptionAcceptance(index, {
    expectedAppVersion, expectedSourceCommit, requirements: loadSubscriptionRequirements(expectedAppVersion),
    readEvidence: name => {
      if (!files.has(name)) throw new Error(`unindexed evidence: ${name}`)
      return files.get(name)
    },
  })
  same([...files.keys()].sort(), [...result.usedFiles].sort(), 'unreferenced evidence')
  return { status: 'passed', appVersion: index.appVersion, sourceCommit: index.sourceCommit,
    providerCount: result.providerCount, stepCount: result.stepCount, deferredProviders: result.deferredProviders,
    candidateAppsSha256: candidateAppsIdentityHash(index.candidateAppsByArchitecture),
    evidenceManifestSha256: digest(JSON.stringify([...index.files].sort((a, b) => a.path.localeCompare(b.path)))),
    indexSha256: digest(fs.readFileSync(absolute)) }
}

export function verifyLocalSubscriptionAcceptance(options) {
  const candidate = inspectPhysicalTideMindCandidateApp(options.candidateAppPathsByArchitecture?.arm64,
    options.expectedAppVersion, options.expectedSourceCommit, 'arm64')
  return verifyBundle(options, { arm64: candidate })
}

/** Publish CI already verifies the exact candidate against both container hashes.
 * Reuse that identity here; the standalone CLI still always inspects the .app. */
export function verifySubscriptionReleaseEvidence(options, acceptedCandidates) {
  if (!acceptedCandidates?.arm64) throw new Error('verified release candidate required')
  return verifyBundle(options, acceptedCandidates)
}

export function copyVerifiedSubscriptionAcceptance(options, destination) {
  const summary = verifyLocalSubscriptionAcceptance(options)
  if (!path.isAbsolute(destination) || fs.existsSync(destination)) throw new Error('copy destination must be new and absolute')
  const index = JSON.parse(fs.readFileSync(options.indexPath))
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  try {
    for (const name of [path.basename(options.indexPath), ...index.files.map(f => f.path)]) {
      const target = path.join(destination, name === path.basename(options.indexPath) ? 'index.json' : name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(path.dirname(options.indexPath), name), target, fs.constants.COPYFILE_EXCL)
    }
    const copied = verifyLocalSubscriptionAcceptance({ ...options, indexPath: path.join(destination, 'index.json') })
    same(copied, summary, 'copied subscription evidence')
    return copied
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), opts = { candidateAppPathsByArchitecture: {} }
    let destination
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1]
      if (!value) throw new Error('missing argument')
      if (flag === '--index') opts.indexPath = path.resolve(value)
      else if (flag === '--app-version') opts.expectedAppVersion = value
      else if (flag === '--source-commit') opts.expectedSourceCommit = value
      else if (flag === '--candidate-app-arm64') opts.candidateAppPathsByArchitecture.arm64 = path.resolve(value)
      else if (flag === '--copy-to') destination = path.resolve(value)
      else throw new Error(`unknown argument ${flag}`)
    }
    console.log(JSON.stringify(destination ? copyVerifiedSubscriptionAcceptance(opts, destination) : verifyLocalSubscriptionAcceptance(opts)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
