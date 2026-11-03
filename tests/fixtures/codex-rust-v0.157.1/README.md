Official OpenAI Codex rust-v0.157.1 compact output schema fixtures.

Source: https://github.com/openai/codex/tree/rust-v0.157.1/codex-rs/hooks/schema/generated

Copied unchanged for offline protocol regression tests; no executable dependency is installed.

P0 adds UserPromptSubmit input/output and PostCompact input schemas from the same pinned tag, unchanged. ups-order-evidence.json records read-only official source excerpts with SHA-256; these are source-contract evidence, not native execution.

The tidemind-four-hook-recipe-ed1e452d.json fixture is Tide Mind production output at the P0 baseline, not an OpenAI schema. Only the isolated temp root and activity token are replaced by placeholders. The P0 upgrade test asserts it before adding the test-only fifth-event candidate.
