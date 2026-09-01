BEGIN IMMEDIATE;

INSERT INTO agents (
  id, name, tool_type, archived, last_active, created
) VALUES (
  'legacy-agent-cursor', 'Legacy Cursor Work', 'cursor', 0,
  '2026-07-29T09:30:00.000Z', '2026-07-01T00:00:00.000Z'
);

INSERT INTO model_connections (
  id, name, provider_type, credentials, status, available_models, last_checked,
  status_reason, cli_path, cli_version, auth_method, auth_fingerprint,
  environment_checked_at, candidate_models, validation_fingerprint,
  model_validation_json, last_tested_at, last_test_summary, archived, created
) VALUES (
  'legacy-model-codex', 'Codex Subscription', 'codex-cli', '{}', 'ready',
  '["gpt-5"]', '2026-07-29T09:31:00.000Z', NULL, '/fixture/bin/codex',
  '0.145.0', 'chatgpt', 'fixture-account', '2026-07-29T09:31:00.000Z',
  '["gpt-5"]', 'fixture-validation', '{"gpt-5":{"ok":true}}',
  '2026-07-29T09:32:00.000Z', '{"ok":true}', 0,
  '2026-07-01T00:00:00.000Z'
);

INSERT INTO pending_digests (
  id, trace_id, input_json, status, error_message, retry_count, created,
  next_retry_at, completed_at, processing_started_at, ambiguous_invocation_id
) VALUES (
  'legacy-queue-digest', 'trace-v33', '{"content":"fixture memory"}',
  'ambiguous', 'fixture interrupted invocation', 2,
  '2026-07-29T09:33:00.000Z', '2026-07-29T09:34:00.000Z',
  NULL, NULL, 'legacy-invocation-1'
);

INSERT INTO cli_invocations (
  id, connection_id, provider_type, account_scope, task_id, operation_name,
  model_alias, actual_model, prompt_committed, outcome, resolution, started_at,
  finished_at, error_kind
) VALUES (
  'legacy-invocation-1', 'legacy-model-codex', 'codex-cli', 'codex:fixture',
  'task-v33', 'digest', 'gpt-5', NULL, 1, 'ambiguous',
  'process_exit_after_prompt', '2026-07-29T09:32:30.000Z',
  '2026-07-29T09:33:00.000Z', 'process_exit'
);

COMMIT;

PRAGMA journal_mode = DELETE;
VACUUM;
