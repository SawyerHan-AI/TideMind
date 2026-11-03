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
  it('keeps parsing defaults, unknown-key stripping and normal/rejected MCP calls with the real SDK', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = new McpServer({ name: 'zod-compatibility', version: '1' })
    const client = new Client({ name: 'contract-regression', version: '1' })
    const observed: Array<{ name: string; input: unknown }> = []
    for (const [name, shape] of Object.entries(BRAIN_TOOL_INPUT_SHAPES)) {
      server.registerTool(name, { description: 'contract regression', inputSchema: z.object(shape) }, async input => {
        observed.push({ name, input })
        return { content: [{ type: 'text', text: JSON.stringify(input) }] }
      })
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const advertised = await client.listTools()
      const native = nativeBrainToolContracts()
      for (const tool of advertised.tools) expect(tool.inputSchema).toEqual(native[tool.name].parameters)

      const normal = await client.callTool({ name: 'brain_recall', arguments: {
        query: 'synthetic query', extra: 'strip me', time: { preset: 'today', extra: 'strip nested' },
      } })
      expect(normal.isError).not.toBe(true)
      expect(observed.at(-1)).toEqual({ name: 'brain_recall', input: {
        query: 'synthetic query', time: { preset: 'today' }, match: 'any', mode: 'detail', depth: 1,
      } })
      const count = observed.length
      const missing = await client.callTool({ name: 'brain_prepare', arguments: {} })
      const invalid = await client.callTool({ name: 'brain_recall', arguments: { tags: Array(21).fill('tag') } })
      expect(missing.isError).toBe(true)
      expect(invalid.isError).toBe(true)
      expect(observed).toHaveLength(count)

      const correction = await client.callTool({ name: 'brain_digest', arguments: {
        content: 'synthetic correction', intent: 'correction', target_node: 'node_1',
        source: { tool: 'test', extra: 'strip' }, target_link: { from: 'a', to: 'b', extra: 'strip' },
      } })
      expect(correction.isError).not.toBe(true)
      expect(observed.at(-1)?.input).toEqual({
        content: 'synthetic correction', intent: 'correction', target_node: 'node_1',
        source: { tool: 'test' }, target_link: { from: 'a', to: 'b' },
      })
    } finally { await client.close(); await server.close() }
  })

})
