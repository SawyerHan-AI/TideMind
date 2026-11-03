import { describe, expect, it } from 'vitest'
// @ts-expect-error acceptance script
import { validateAgentMemoryClosure } from '../../scripts/agent-memory-closure.mjs'
import { memoryClosureFixture } from '../fixtures/agent-integration/memory-closure-fixture.js'

const expected = {
  targetKey: 'codex-cli:arm64', installationId: 'test-installation', agentId: 'test-agent',
  sourceCommit: 'a'.repeat(40), releaseContractSha256: 'b'.repeat(64), candidateBundleSha256: 'c'.repeat(64),
  hostVariant: 'codex-cli', hostVersion: '1.2.3',
  captureCreatedAt: '2026-10-23T00:00:00.000Z', observedAt: '2026-10-23T00:10:00.000Z',
  allowFixtureActivity: false,
}
function fixture() {
  const data = memoryClosureFixture(expected, expected.captureCreatedAt, expected.observedAt)
  const validate = () => {
    data.receipt.transcriptSha256 = data.add(data.transcript)
    data.receipt.readbackSha256 = data.add(data.readback)
    return validateAgentMemoryClosure(data.receipt, expected, data.files)
  }
  return { ...data, validate }
}

describe('real-host memory closure acceptance', () => {
  it('accepts processed output, SQLite product read-back and a new-session recall', () => {
    expect(fixture().validate()).toMatchObject({ validationMode: 'real_model' })
  })
  it('accepts an async trace only with matched queued input, successful operation and product read-back', () => {
    const data = fixture()
    const digest = data.transcript.sessions[0].calls[1]
    digest.result = { status: 'accepted', trace_id: 'synthetic-trace' } as never
    data.readback.pendingBefore = {
      id: 'pending-one', trace_id: 'synthetic-trace', status: 'processing',
      input_json: JSON.stringify({ ...digest.request, agent_id: expected.agentId }),
    } as never
    expect(data.validate()).toBeTruthy()
  })
  it.each(['controlled_response', 'protocol_direct'])('rejects %s as formal normal acceptance', mode => {
    const data = fixture()
    data.receipt.validationMode = mode
    data.transcript.validationMode = mode
    expect(data.validate).toThrow(/real host and real model/)
    data.receipt.transcriptSha256 = data.add(data.transcript)
    expect(validateAgentMemoryClosure(data.receipt, { ...expected, allowFixtureActivity: true }, data.files)).toBeTruthy()
  })
  it.each([
    ['queued', 'still queued'],
    ['failed', 'complete successfully'],
    ['accepted-only', 'original queued trace'],
    ['wrong-queued-input', 'queued digest input'],
    ['no-operation', 'successful digest operation'],
    ['no-product', 'products were not read back'],
    ['same-session', 'new host session'],
    ['wrong-recall-product', 'did not return'],
    ['wrong-candidate', 'candidateBundleSha256 mismatch'],
    ['wrong-host-model', 'modelId mismatch'],
    ['missing-transcript', 'original host transcript missing'],
    ['no-prepare', 'brain_prepare'],
  ])('rejects incomplete or misbound closure: %s', (defect, error) => {
    const data = fixture()
    const digest = data.transcript.sessions[0].calls[1]
    if (defect === 'queued') data.readback.pendingAfter = [{ status: 'processing' }] as never
    if (defect === 'failed') digest.result = { status: 'failed', trace_id: 'synthetic-trace' } as never
    if (defect === 'accepted-only' || defect === 'wrong-queued-input') digest.result = { status: 'accepted', trace_id: 'synthetic-trace' } as never
    if (defect === 'wrong-queued-input') data.readback.pendingBefore = {
      id: 'pending-one', trace_id: 'synthetic-trace', status: 'processing',
      input_json: JSON.stringify({ content: 'different', source: { session: 'synthetic-session-one' }, agent_id: expected.agentId }),
    } as never
    if (defect === 'no-operation') data.readback.operation.operation = 'recall'
    if (defect === 'no-product') data.readback.nodes = []
    if (defect === 'same-session') data.transcript.sessions[1].id = data.transcript.sessions[0].id
    if (defect === 'wrong-recall-product') data.transcript.sessions[1].calls[0].result = { exact_matches: [{ id: 'another', content: data.receipt.marker }] } as never
    if (defect === 'wrong-candidate') data.readback.candidateBundleSha256 = 'd'.repeat(64)
    if (defect === 'wrong-host-model') data.transcript.modelId = 'tidemind-backend-model'
    if (defect === 'missing-transcript') data.files.delete(data.receipt.rawTranscriptSha256)
    if (defect === 'no-prepare') data.transcript.sessions[0].calls.shift()
    expect(data.validate).toThrow(error)
  })
})
