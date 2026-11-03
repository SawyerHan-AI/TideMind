// Acceptance-only checks over pre-redacted host transcripts and SQLite read-back.
// This does not invoke models, open user databases, or add a product runtime ledger.
const SHA256 = /^[a-f0-9]{64}$/u
function requireCondition(condition, message) { if (!condition) throw new Error(`memory closure: ${message}`) }
function text(value) { return typeof value === 'string' && value.trim().length > 0 }
function time(value) { const result = typeof value === 'number' ? value : Date.parse(value); requireCondition(Number.isFinite(result), 'invalid timestamp'); return result }
function resultObject(raw) {
  requireCondition(raw && typeof raw === 'object' && !raw.isError, 'tool returned an error')
  if (Array.isArray(raw.content)) {
    const item = raw.content.find(item => item.type === 'text')
    requireCondition(item && text(item.text), 'missing tool JSON response')
    return JSON.parse(item.text)
  }
  return raw
}
function evidenceJson(hash, files) {
  requireCondition(SHA256.test(hash ?? '') && files.has(hash), 'referenced supporting evidence is absent')
  return JSON.parse(files.get(hash).toString('utf8'))
}
function bind(document, expected) {
  for (const key of ['targetKey', 'installationId', 'agentId', 'sourceCommit', 'releaseContractSha256', 'candidateBundleSha256']) {
    requireCondition(document[key] === expected[key], `${key} mismatch`)
  }
}

/**
 * Formal proof uses a real host/model plus witnessed raw transcript. Fixture
 * modes exercise protocol/negative regressions but cannot satisfy real_host.
 * pendingBefore/operation/nodes preserve existing SQLite column names.
 */
export function validateAgentMemoryClosure(value, expected, files) {
  requireCondition(value && typeof value === 'object' && value.schemaVersion === 1, 'missing supported receipt')
  const keys = ['schemaVersion', 'validationMode', 'modelSource', 'modelId', 'marker',
    'transcriptSha256', 'rawTranscriptSha256', 'readbackSha256']
  requireCondition(Object.keys(value).length === keys.length && keys.every(key => key in value), 'receipt fields mismatch')
  requireCondition(['real_model', 'controlled_response', 'protocol_direct'].includes(value.validationMode), 'invalid validation mode')
  requireCondition(['local_model', 'official_subscription', 'third_party_api'].includes(value.modelSource), 'invalid host model source')
  requireCondition(text(value.modelId) && text(value.marker), 'host model and synthetic marker required')
  requireCondition(expected.allowFixtureActivity || value.validationMode === 'real_model', 'normal acceptance requires a real host and real model')
  requireCondition(SHA256.test(value.rawTranscriptSha256 ?? '') && files.has(value.rawTranscriptSha256)
    && files.get(value.rawTranscriptSha256).length > 0, 'original host transcript missing')
  const transcript = evidenceJson(value.transcriptSha256, files)
  const readback = evidenceJson(value.readbackSha256, files)
  bind(transcript, expected); bind(readback, expected)
  for (const key of ['validationMode', 'modelSource', 'modelId']) {
    requireCondition(transcript[key] === value[key], `host transcript ${key} mismatch`)
  }
  requireCondition(transcript.rawTranscriptSha256 === value.rawTranscriptSha256, 'raw transcript binding mismatch')
  requireCondition(transcript.hostVariant === expected.hostVariant && transcript.hostVersion === expected.hostVersion, 'host identity mismatch')
  requireCondition(Array.isArray(transcript.sessions) && transcript.sessions.length === 2, 'two host sessions required')
  const [first, second] = transcript.sessions
  requireCondition(text(first.id) && text(second.id) && first.id !== second.id, 'recall must run in a new host session')
  const begin = time(expected.captureCreatedAt), end = time(expected.observedAt)
  requireCondition(time(first.startedAt) >= begin && time(first.endedAt) >= time(first.startedAt)
    && time(second.startedAt) > time(first.endedAt) && time(second.endedAt) >= time(second.startedAt)
    && time(second.endedAt) <= end, 'host sessions outside capture window or overlap')
  const call = (session, tool) => {
    requireCondition(Array.isArray(session.calls), 'missing host tool calls')
    const found = session.calls.filter(item => item.tool === tool)
    requireCondition(found.length === 1, `one unambiguous ${tool} call required`)
    const item = found[0]
    requireCondition(time(item.observedAt) >= time(session.startedAt) && time(item.observedAt) <= time(session.endedAt),
      'tool call outside its host session')
    return item
  }
  const prepare = call(first, 'brain_prepare'), digest = call(first, 'brain_digest'), recall = call(second, 'brain_recall')
  requireCondition(time(prepare.observedAt) <= time(digest.observedAt), 'prepare must precede digest')
  const prepared = resultObject(prepare.result)
  requireCondition(prepared.profile && Array.isArray(prepared.keystones) && Array.isArray(prepared.tags)
    && prepared.crystals && Array.isArray(prepared.recent), 'prepare did not return the product output')
  requireCondition(digest.request && text(digest.request.content) && digest.request.content.includes(value.marker)
    && digest.request.source?.session === first.id
    && (!digest.request.intent || digest.request.intent === 'new'), 'digest input must contain the synthetic marker and source session')
  const output = resultObject(digest.result)
  requireCondition(text(output.trace_id) && readback.traceId === output.trace_id, 'digest trace binding mismatch')
  requireCondition(time(readback.observedAt) >= time(digest.observedAt)
    && time(readback.observedAt) < time(second.startedAt), 'digest completion must precede the new recall session')
  requireCondition(Array.isArray(readback.pendingAfter) && readback.pendingAfter.length === 0, 'digest is still queued, failed or ambiguous')
  const operation = readback.operation
  requireCondition(operation?.operation === 'digest' && operation.agent_id === expected.agentId
    && operation.session === first.id && operation.input_summary === digest.request.content.slice(0, 100),
    'successful digest operation does not match the host input')
  requireCondition(Number.isInteger(operation.id) && operation.id > 0
    && time(operation.created) >= time(first.startedAt) && time(operation.created) <= time(readback.observedAt),
    'digest operation is outside this run')
  const ids = typeof operation.output_node_ids === 'string' ? JSON.parse(operation.output_node_ids) : operation.output_node_ids
  requireCondition(Array.isArray(ids) && ids.length > 0 && ids.every(text), 'digest operation has no product')
  if (output.status === 'processed') {
    requireCondition(Array.isArray(output.created_nodes) && output.created_nodes.length > 0
      && output.created_nodes.every(node => ids.includes(node.id)), 'processed digest lacks matching created products')
  } else {
    requireCondition(output.status === 'accepted', 'digest did not complete successfully')
    const before = readback.pendingBefore
    requireCondition(before && text(before.id) && before.trace_id === output.trace_id
      && ['pending', 'processing'].includes(before.status), 'accepted digest lacks its original queued trace')
    const input = typeof before.input_json === 'string' ? JSON.parse(before.input_json) : before.input_json
    requireCondition(input.content === digest.request.content && input.source?.session === first.id
      && input.agent_id === expected.agentId, 'queued digest input does not match the host call')
  }
  requireCondition(Array.isArray(readback.nodes), 'product read-back missing')
  const products = readback.nodes.filter(node => ids.includes(node.id) && node.archived === 0
    && node.source_session === first.id && text(node.content) && node.content.includes(value.marker))
  requireCondition(products.length > 0, 'digest products were not read back from SQLite')
  const recalled = resultObject(recall.result)
  const matches = [...(recalled.exact_matches ?? []), ...(recalled.related_matches ?? []), ...(recalled.nodes ?? [])]
  requireCondition(matches.some(node => products.some(product => product.id === node.id)
    && text(node.content) && node.content.includes(value.marker)), 'new-session recall did not return the digest product')
  return value
}
