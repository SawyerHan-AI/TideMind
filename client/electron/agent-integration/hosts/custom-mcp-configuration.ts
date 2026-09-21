export type CustomMcpSchema = 'standard_mcp_servers' | 'nested_mcp_servers' | 'opencode_mcp'

/** One projection contract for managed previews and user-owned imports. */
export function customMcpConfiguration(
  schemaKind: CustomMcpSchema,
  selectorKey: string,
  agentId: string,
  runtime: { shimPath: string; mcpServerPath: string },
  activityGenerationToken?: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(selectorKey)
    || ['__proto__', 'prototype', 'constructor'].includes(selectorKey)) {
    throw new Error('custom_mcp_selector_invalid')
  }
  const environment = {
    EB_AGENT_ID: agentId, EB_HOST_VARIANT: 'custom-local-mcp',
    ...(activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: activityGenerationToken } : {}),
  }
  const entry = { command: runtime.shimPath, args: [runtime.mcpServerPath], env: environment }
  let document: unknown
  if (schemaKind === 'standard_mcp_servers') document = { mcpServers: { [selectorKey]: entry } }
  else if (schemaKind === 'nested_mcp_servers') document = { mcp: { servers: { [selectorKey]: entry } } }
  else if (schemaKind === 'opencode_mcp') document = {
    mcp: { [selectorKey]: { type: 'local', command: [runtime.shimPath, runtime.mcpServerPath], enabled: true, environment } },
  }
  else throw new Error('custom_mcp_schema_invalid')
  return `${JSON.stringify(document, null, 2)}\n`
}

export function customGuidedProjection(profile: string): { schema: CustomMcpSchema; selectorKey: string } {
  const matched = /^custom-guided:(standard_mcp_servers|nested_mcp_servers|opencode_mcp):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/u.exec(profile)
  if (!matched || ['__proto__', 'prototype', 'constructor'].includes(matched[2])) {
    throw new Error('custom_guided_profile_invalid')
  }
  return { schema: matched[1] as CustomMcpSchema, selectorKey: matched[2] }
}
