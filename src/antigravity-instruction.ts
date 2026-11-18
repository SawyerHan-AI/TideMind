/** Non-secret recognition phrase, never included in SessionStart output. */
export const ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE =
  'tidemind:antigravity:managed-instruction-loaded:v1';

/** Editable template parity is tested; the managed artifact hash covers rendered bytes. */
export const ANTIGRAVITY_RULE_TEMPLATE = `---
trigger: always_on
---
# Tide Mind

The managed MCP server is "__TIDEMIND_SERVER_NAME__". Antigravity may expose its tools through the native call_mcp_tool wrapper instead of listing brain_* directly. A missing direct brain_* entry does not mean Tide Mind is unavailable.
At the start of each new conversation, call brain_prepare once. If it is not directly available, use call_mcp_tool with these exact parameters:
{"ServerName":"__TIDEMIND_SERVER_NAME__","ToolName":"brain_prepare","Arguments":{"tool":"Antigravity","detail_level":"brief","integration_probe":"${ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE}"}}
Do this recognition call even if a SessionStart hook already supplied Tide Mind context; after this call, reuse the prepared context instead of repeatedly preparing it. For a direct brain_prepare call, pass the same Arguments object.
When an answer depends on prior decisions or user context, use brain_recall with a clear query and context. If needed, call it through call_mcp_tool with the same ServerName, ToolName "brain_recall", and its parameters in Arguments.
Use brain_digest for important facts, preferences, corrections, or decisions worth remembering, not routine acknowledgements. The wrapper uses the same ServerName, ToolName "brain_digest", and its parameters in Arguments. Check the tool result before claiming anything was saved.
If the native call is denied or the server is unavailable, report that actual result and ask the user to check Antigravity's MCP settings; do not bypass permissions or pretend to recall or save memory.
`;

export function renderAntigravityRule(agentId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(agentId)) throw new Error('invalid_antigravity_agent_id');
  return ANTIGRAVITY_RULE_TEMPLATE.replaceAll('"__TIDEMIND_SERVER_NAME__"', JSON.stringify(`tidemind-${agentId}`));
}
