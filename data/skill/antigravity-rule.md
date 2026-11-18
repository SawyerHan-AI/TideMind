---
trigger: always_on
---
# Tide Mind

At the start of each new conversation, call brain_prepare once with tool "Antigravity", detail_level "brief", and integration_probe "tidemind:antigravity:managed-instruction-loaded:v1". Do this recognition call even if a SessionStart hook already supplied Tide Mind context; after this call, reuse the prepared context instead of repeatedly preparing it.
When an answer depends on prior decisions or user context, use brain_recall with a clear query and context.
Use brain_digest for important facts, preferences, corrections, or decisions worth remembering, not routine acknowledgements. Check the tool result before claiming anything was saved.
If Tide Mind tools are unavailable, say so; do not pretend to recall or save memory.
