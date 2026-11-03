import crypto from 'node:crypto'
export const closureHash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')

/** Synthetic evidence only; never a real-host acceptance result. */
export function memoryClosureFixture(binding: Record<string, unknown>, captureCreatedAt: string, observedAt: string) {
  const begin = Date.parse(captureCreatedAt), duration = Date.parse(observedAt) - begin
  const at = (fraction: number) => new Date(begin + Math.floor(duration * fraction)).toISOString()
  const marker = 'tidemind synthetic closure memory 094'
  const content = marker + ': remember the violet test kettle'
  const session = 'synthetic-session-one', nextSession = 'synthetic-session-two', nodeId = 'synthetic-node'
  const raw = Buffer.from(JSON.stringify({ fixture: true, hostExport: { sessions: [session, nextSession], calls: ['brain_prepare', 'brain_digest', 'brain_recall'] } }))
  const transcript = {
    ...binding, validationMode: 'real_model', modelSource: 'local_model', modelId: 'synthetic-model',
    rawTranscriptSha256: closureHash(raw),
    sessions: [
      { id: session, startedAt: at(.1), endedAt: at(.55), calls: [
        { tool: 'brain_prepare', request: {}, result: { profile: {}, keystones: [], tags: [], crystals: {}, recent: [] }, observedAt: at(.2) },
        { tool: 'brain_digest', request: { content, async: false, source: { session } },
          result: { status: 'processed', trace_id: 'synthetic-trace', created_nodes: [{ id: nodeId, content, type: 'fact' }] }, observedAt: at(.4) },
      ] },
      { id: nextSession, startedAt: at(.7), endedAt: at(.9), calls: [
        { tool: 'brain_recall', request: { query: marker }, result: { exact_matches: [{ id: nodeId, content }], related_matches: [] }, observedAt: at(.8) },
      ] },
    ],
  }
  const readback = {
    ...binding, traceId: 'synthetic-trace', observedAt: at(.6), pendingBefore: null, pendingAfter: [],
    operation: { id: 1, operation: 'digest', agent_id: binding.agentId, session, input_summary: content.slice(0, 100),
      output_node_ids: JSON.stringify([nodeId]), created: at(.35) },
    nodes: [{ id: nodeId, content, archived: 0, source_session: session }],
  }
  const files = new Map<string, Buffer>()
  const add = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); const hash = closureHash(bytes); files.set(hash, bytes); return hash }
  files.set(closureHash(raw), raw)
  const receipt = { schemaVersion: 1, validationMode: 'real_model', modelSource: 'local_model', modelId: 'synthetic-model',
    marker, transcriptSha256: add(transcript), rawTranscriptSha256: closureHash(raw), readbackSha256: add(readback) }
  return { receipt, files, transcript, readback, add }
}
