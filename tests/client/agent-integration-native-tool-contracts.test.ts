import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { nativeBrainToolContracts } from '../../client/electron/agent-integration/hosts/native-tool-contracts'
import { BRAIN_TOOL_INPUT_SHAPES, DEFAULT_BRAIN_TOOL_DESCRIPTIONS } from '../../src/mcp-tool-contracts.js'

describe('native memory tools share the MCP input contract', () => {
  it('retains every advertised parameter and description, including retrieval and correction', () => {
    const contracts = nativeBrainToolContracts()
    for (const name of Object.keys(BRAIN_TOOL_INPUT_SHAPES) as Array<keyof typeof BRAIN_TOOL_INPUT_SHAPES>) {
      const schema = contracts[name].parameters
      expect(Object.keys(schema.properties as object).sort()).toEqual(Object.keys(BRAIN_TOOL_INPUT_SHAPES[name]).sort())
      expect(contracts[name].description).toBe(DEFAULT_BRAIN_TOOL_DESCRIPTIONS[name])
    }
    expect(contracts.brain_prepare.parameters.required).toContain('tool')
    expect(contracts.brain_recall.parameters.properties).toMatchObject({ query: { type: 'string' }, node_id: { type: 'string' }, time: { type: 'object' } })
    expect(contracts.brain_digest.parameters.properties).toMatchObject({ intent: { enum: ['new', 'correction', 'archive'] }, target_node: { type: 'string' } })
    expect(z.object(BRAIN_TOOL_INPUT_SHAPES.brain_recall).parse({ query: 'prior decision', time: { preset: 'recent_week' } })).toMatchObject({ query: 'prior decision' })
    expect(z.object(BRAIN_TOOL_INPUT_SHAPES.brain_digest).parse({ content: 'corrected fact', intent: 'correction', target_node: 'node_1' })).toMatchObject({ target_node: 'node_1' })
  })
})
