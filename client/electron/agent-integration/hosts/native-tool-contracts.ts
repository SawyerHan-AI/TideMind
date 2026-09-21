import { z } from 'zod'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { BRAIN_TOOL_INPUT_SHAPES, DEFAULT_BRAIN_TOOL_DESCRIPTIONS } from '@server/mcp-tool-contracts.js'

/** Freeze the same input contract advertised by the MCP server into native plugins. */
export function nativeBrainToolContracts() {
  return Object.fromEntries(Object.entries(BRAIN_TOOL_INPUT_SHAPES).map(([name, shape]) => [name, {
    description: DEFAULT_BRAIN_TOOL_DESCRIPTIONS[name as keyof typeof BRAIN_TOOL_INPUT_SHAPES],
    parameters: toJsonSchemaCompat(z.object(shape), { target: 'jsonSchema7', pipeStrategy: 'input' }),
  }]))
}
