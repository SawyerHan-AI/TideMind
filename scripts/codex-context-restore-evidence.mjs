import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha = /^[a-f0-9]{64}$/u
const check = (ok, message) => { if (!ok) throw new Error(`Codex context restore: ${message}`) }
const text = value => typeof value === 'string' && value.length > 0
const time = value => typeof value === 'number' ? value : Date.parse(value)
export const isCodexContextRestoreStep = id => ['codex_context_restore_manual', 'codex_context_restore_auto'].includes(id)
const fields = ['schemaVersion','trigger','sessionId','restoreTurnId','metadataExportSha256','nativeNotificationsSha256','rolloutSha256','postCompactInputSha256','postCompactRunId','restoreRunId']
function bytes(files, digest) {
  check(sha.test(digest ?? '') && files.has(digest), 'missing referenced original evidence')
  return files.get(digest).toString('utf8')
}
function records(raw) {
  try { const value = JSON.parse(raw); if (Array.isArray(value)) return value } catch {}
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
/** Acceptance-only: consumes native JSON-RPC notifications, rollout records and candidate read-back.
 * Each step captures one bounded execution window. Multiple same-turn executions
 * of a stable handler ID are ambiguous evidence, not a host functionality failure.
 */
export function validateCodexContextRestore(value, expected, files) {
  check(value && fields.length === Object.keys(value).length && fields.every(key => key in value), 'receipt fields mismatch')
  check(value.schemaVersion === 1 && isCodexContextRestoreStep(expected.stepId)
    && value.trigger === expected.stepId.slice('codex_context_restore_'.length), 'wrong trigger/step')
  check(['codex-cli','codex-desktop'].includes(expected.hostVariant), 'wrong host variant')
  const metadata = JSON.parse(bytes(files, value.metadataExportSha256))
  const { exportHash, ...binding } = metadata
  check(exportHash === hash(binding) && metadata.exporterVersion === 1
    && (metadata.evidenceClass === 'real_host' || (expected.allowFixtureActivity === true && metadata.evidenceClass === 'fixture')), 'not a real candidate metadata export')
  for (const key of ['sourceCommit','releaseContractSha256','candidateBundleSha256']) check(metadata[key] === expected[key], `${key} mismatch`)
  const target = metadata.targetMetadata
  for (const key of ['targetKey','installationId','agentId','hostVersion']) check(target?.[key] === expected[key], `target ${key} mismatch`)
  check((target.sourceCatalogId ?? target.targetId) === expected.hostVariant, 'metadata host mismatch')
  for (const key of ['distribution','environment']) if (expected[key]) check(JSON.stringify(target[key]) === JSON.stringify(expected[key]), `target ${key} mismatch`)
  const state = target.codexContextRestore
  check(state?.schemaVersion === 1 && state.captureNonce === expected.captureNonce && sha.test(state.generationSha256)
    && sha.test(state.upsScriptSha256) && sha.test(state.hookDefinitionSha256) && sha.test(state.hookSourcePathSha256), 'missing current five-hook generation proof')
  const sidecar = JSON.parse(bytes(files, value.postCompactInputSha256))
  const sidecarKeys = ['schemaVersion','captureNonce','observedAt','eventName','sessionId','turnId','trigger','generationSha256','scopeKey','revision']
  check(Object.keys(sidecar).length === sidecarKeys.length && sidecarKeys.every(key => key in sidecar), 'PostCompact whitelist fields mismatch')
  check(sidecar.schemaVersion === 1 && sidecar.captureNonce === expected.captureNonce && sidecar.eventName === 'PostCompact'
    && sidecar.trigger === value.trigger && text(sidecar.sessionId) && text(sidecar.turnId), 'wrong native PostCompact input')
  check(value.sessionId === sidecar.sessionId, 'receipt session selector mismatch')
  check(sidecar.scopeKey === state.scopeKey && /^codex_context_restore:v1:[a-f0-9]{64}$/u.test(state.scopeKey)
    && sidecar.generationSha256 === state.generationSha256 && hash(sidecar.sessionId) === state.sessionIdSha256, 'session/generation/scope mismatch')
  check(Number.isSafeInteger(sidecar.revision) && sidecar.revision > 0 && state.deliveredRevision === sidecar.revision
    && state.pendingRevision === sidecar.revision, 'revision was not consumed exactly')
  const native = records(bytes(files, value.nativeNotificationsSha256))
  function run(id, event, turnId) {
    check(text(id), 'missing native run id')
    const matches = x => x.params?.run?.id === id && x.params.threadId === sidecar.sessionId
      && x.params.turnId === turnId && x.params.run.eventName === event
    const started = native.filter(x => x.method === 'hook/started' && matches(x))
    const completed = native.filter(x => x.method === 'hook/completed' && matches(x))
    check(started.length === 1 && completed.length === 1, 'ambiguous or absent native Hook run')
    const a = started[0].params, b = completed[0].params
    for (const item of [a,b]) check(item.threadId === sidecar.sessionId && text(item.turnId)
      && item.run.eventName === event && item.run.handlerType === 'command'
      && hash(item.run.sourcePath) === state.hookSourcePathSha256, 'native event/session/source mismatch')
    check(a.turnId === b.turnId && a.run.startedAt === b.run.startedAt && b.run.status === 'completed'
      && Number.isSafeInteger(b.run.startedAt) && b.run.startedAt >= 0
      && Number.isSafeInteger(b.run.completedAt) && b.run.completedAt >= b.run.startedAt
      && Number.isSafeInteger((b.run.completedAt + 1) * 1000), 'native Hook did not complete')
    // Codex rust-v0.157.1 emits Unix seconds here (durationMs alone is milliseconds).
    // A recorded second denotes [second * 1000, (second + 1) * 1000).
    const startedAtMs = b.run.startedAt * 1000
    const completedAtMs = b.run.completedAt * 1000
    const completedBeforeMs = completedAtMs + 1000
    const startedIndex = native.indexOf(started[0]), completedIndex = native.indexOf(completed[0])
    check(startedIndex < completedIndex, 'native Hook notification order mismatch')
    check(startedAtMs + 1000 > time(expected.captureCreatedAt)
      && completedAtMs <= time(expected.observedAt), 'Hook outside capture window')
    return { ...b, startedAtMs, completedAtMs, completedBeforeMs, startedIndex, completedIndex }
  }
  const compact = run(value.postCompactRunId, 'postCompact', sidecar.turnId)
  const restore = run(value.restoreRunId, 'userPromptSubmit', value.restoreTurnId)
  check(compact.turnId === sidecar.turnId && time(sidecar.observedAt) >= compact.startedAtMs
    && time(sidecar.observedAt) < compact.completedBeforeMs && restore.startedAtMs >= compact.completedAtMs
    && restore.startedIndex > compact.completedIndex, 'PostCompact/UPS order mismatch')
  check(value.restoreTurnId === restore.turnId, 'receipt turn selector mismatch')
  check(native.some(x => x.method === 'item/completed' && x.params?.threadId === sidecar.sessionId
    && x.params.turnId === compact.turnId && x.params.item?.type === 'contextCompaction'), 'native compaction item missing')
  check(hash(restore.turnId) === state.deliveredTurnIdHash, 'delivery is not this UPS turn (SS is not UPS)')
  check(time(state.updatedAt) >= restore.startedAtMs && time(metadata.exportedAt) >= restore.completedAtMs
    && time(metadata.exportedAt) <= time(expected.observedAt) && time(state.expiresAt) > time(metadata.exportedAt), 'state/export time mismatch')
  const contexts = restore.run.entries?.filter(x => x.kind === 'context' && text(x.text)) ?? []
  check(contexts.length === 1, 'one original UPS context entry required')
  const rollout = records(bytes(files, value.rolloutSha256))
  check(rollout.some(x => x.type === 'event_msg' && x.payload?.thread_id === sidecar.sessionId), 'rollout thread identity missing')
  const injected = rollout.filter(x => x.type === 'response_item' && x.payload?.role === 'developer'
    && x.payload.internal_chat_message_metadata_passthrough?.turn_id === restore.turnId
    && x.payload.content?.some((c, i) => c.type === 'input_text' && c.text === contexts[0].text
      && x.payload.internal_chat_message_metadata_passthrough.content_item_kinds?.[i] === 'hooks.additional_context'))
  check(injected.length === 1, 'UPS context absent or ambiguous in native model input')
  check(time(injected[0].timestamp) >= restore.startedAtMs && time(injected[0].timestamp) <= time(expected.observedAt), 'rollout input outside run')
  const compactions = native.filter(x => x.method === 'thread/compact/start' && x.params?.threadId === sidecar.sessionId && x.id !== undefined)
  if (value.trigger === 'manual') check(compactions.length === 1 && native.some(x => x.id === compactions[0].id && x.result && !x.error), 'manual compact request/response absent')
  else check(compactions.length === 0, 'auto evidence contains manual compact request')
  return { sessionId: sidecar.sessionId, turnId: restore.turnId, postCompactRunId: value.postCompactRunId, restoreRunId: value.restoreRunId }
}
export function rejectReusedCodexRestoreRuns(targets) {
  const used = new Set()
  for (const target of targets) for (const step of target.steps ?? []) {
    const value = step.codexContextRestore
    if (!isCodexContextRestoreStep(step.id) || !value) continue
    const key = JSON.stringify([value.sessionId, value.restoreTurnId])
    check(text(value.sessionId) && text(value.restoreTurnId) && !used.has(key), 'native Hook run reused across steps or hosts')
    used.add(key)
  }
}

// CLI shared identities intentionally have no per-Installation aha row. Reuse the
// already-required real compact/restore session, including its candidate proof.
const lifecycleEvents = Object.freeze({ lifecycle_session_start: 'sessionStart', lifecycle_pre_compact: 'preCompact',
  lifecycle_post_compact: 'postCompact', lifecycle_session_end: 'sessionEnd' })
export const isCodexNativeLifecycleReceipt = value => value?.ledgerSource === 'codex_native_hooks'
export const codexNativeLifecycleEvidenceHash = value => hash(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'evidenceHash')))
export function validateCodexNativeLifecycleReceiptShape(value, expected) {
  check(['0.2.94', '0.2.95'].includes(expected.appVersion) && expected.targetId === 'codex-cli' && expected.hostVariant === 'codex-cli'
    && lifecycleEvents[expected.stepId], 'native lifecycle path is only for 0.2.94/0.2.95 Codex CLI lifecycle')
  const keys = ['ledgerSource','restoreReceipt','runId','turnId','evidenceHash']
  check(value && Object.keys(value).length === keys.length && keys.every(key => key in value)
    && isCodexNativeLifecycleReceipt(value) && text(value.runId) && text(value.turnId)
    && value.restoreReceipt && sha.test(value.evidenceHash) && value.evidenceHash === codexNativeLifecycleEvidenceHash(value), 'native lifecycle receipt shape/hash mismatch')
  return value
}
export function validateCodexNativeLifecycleReceipt(value, expected, files) {
  validateCodexNativeLifecycleReceiptShape(value, expected)
  const restore = value.restoreReceipt
  validateCodexContextRestore(restore, { ...expected, stepId: `codex_context_restore_${restore.trigger}` }, files)
  const metadata = JSON.parse(bytes(files, restore.metadataExportSha256))
  const state = metadata.targetMetadata.codexContextRestore
  const native = records(bytes(files, restore.nativeNotificationsSha256))
  const eventName = lifecycleEvents[expected.stepId]
  function pair(id, event, turn) {
    const matches = x => x.params?.threadId === restore.sessionId && x.params.turnId === turn
      && x.params.run?.id === id && x.params.run.eventName === event
    const starts = native.filter(x => x.method === 'hook/started' && matches(x))
    const ends = native.filter(x => x.method === 'hook/completed' && matches(x))
    check(starts.length === 1 && ends.length === 1, 'native lifecycle run absent or ambiguous')
    const a = starts[0].params.run, b = ends[0].params.run
    for (const run of [a,b]) check(run.handlerType === 'command' && hash(run.sourcePath) === state.hookSourcePathSha256,
      'native lifecycle Hook source mismatch')
    check(b.status === 'completed' && a.startedAt === b.startedAt && Number.isSafeInteger(b.startedAt)
      && Number.isSafeInteger(b.completedAt) && b.completedAt >= b.startedAt && b.startedAt >= 0
      && Number.isSafeInteger((b.completedAt + 1) * 1000), 'native lifecycle Hook did not complete')
    check((b.startedAt + 1) * 1000 > time(expected.captureCreatedAt) && b.completedAt * 1000 <= time(expected.observedAt),
      'native lifecycle outside capture window')
    const start = native.indexOf(starts[0]), end = native.indexOf(ends[0])
    check(start < end, 'native lifecycle notification order mismatch')
    return { start, end, run: b }
  }
  const selected = pair(value.runId, eventName, value.turnId)
  const sidecar = JSON.parse(bytes(files, restore.postCompactInputSha256))
  const post = pair(restore.postCompactRunId, 'postCompact', sidecar.turnId)
  const ups = pair(restore.restoreRunId, 'userPromptSubmit', restore.restoreTurnId)
  if (eventName === 'preCompact') check(value.turnId === sidecar.turnId && selected.end < post.start, 'PreCompact must precede the real PostCompact')
  if (eventName === 'postCompact') check(value.runId === restore.postCompactRunId && value.turnId === sidecar.turnId, 'PostCompact is not the real restored compaction')
  if (eventName === 'sessionEnd') check(selected.start > ups.end, 'SessionEnd must complete after the restored turn')
  if (eventName === 'sessionStart') {
    check(selected.end < post.start, 'SessionStart must precede compaction')
    const contexts = selected.run.entries?.filter(x => x.kind === 'context' && text(x.text)) ?? []
    check(contexts.length > 0, 'SessionStart context missing')
    const rollout = records(bytes(files, restore.rolloutSha256))
    for (const context of contexts) check(rollout.some(x => x.type === 'response_item' && x.payload?.role === 'developer'
      && x.payload.internal_chat_message_metadata_passthrough?.turn_id === value.turnId
      && time(x.timestamp) >= selected.run.startedAt * 1000 && time(x.timestamp) <= time(expected.observedAt)
      && x.payload.content?.some((c,i) => c.type === 'input_text' && c.text === context.text
        && x.payload.internal_chat_message_metadata_passthrough.content_item_kinds?.[i] === 'hooks.additional_context')),
    'SessionStart context absent from native model input')
  }
  return value
}
