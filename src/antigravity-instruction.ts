import { createHash } from 'node:crypto';

/** Non-secret recognition phrase, never included in SessionStart output. */
export const ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE =
  'tidemind:antigravity:managed-instruction-loaded:v1';

export const ANTIGRAVITY_RULE_CONTENT = `---
trigger: always_on
---
# Tide Mind

At the start of each new conversation, call brain_prepare once with tool "Antigravity", detail_level "brief", and integration_probe "${ANTIGRAVITY_INSTRUCTION_PREPARE_PROBE}". Do this recognition call even if a SessionStart hook already supplied Tide Mind context; after this call, reuse the prepared context instead of repeatedly preparing it.
When an answer depends on prior decisions or user context, use brain_recall with a clear query and context.
Use brain_digest for important facts, preferences, corrections, or decisions worth remembering, not routine acknowledgements. Check the tool result before claiming anything was saved.
If Tide Mind tools are unavailable, say so; do not pretend to recall or save memory.
`;

export const ANTIGRAVITY_RULE_SHA256 = createHash('sha256')
  .update(ANTIGRAVITY_RULE_CONTENT).digest('hex');
