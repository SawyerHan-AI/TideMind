import type { CliProviderType } from './types.js';

export const CLAUDE_MODEL_ALIASES = ['default', 'haiku', 'sonnet', 'opus', 'fable'] as const;
export const CODEX_MODEL_ALIASES = [
  'default',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.2',
] as const;

export const CLI_MODEL_CATALOGS: Readonly<Record<CliProviderType, readonly string[]>> = {
  'claude-cli': CLAUDE_MODEL_ALIASES,
  'codex-cli': CODEX_MODEL_ALIASES,
};

/**
 * Codex capability snapshots are deliberately exact. An unknown version or
 * feature is unsupported until its help/features fixtures are reviewed.
 */
export interface CodexCapabilityManifest {
  version: string;
  requiredExecHelp: readonly string[];
  requiredPromptInputHelp: readonly string[];
  knownFeatures: Readonly<Record<string, Readonly<{ stage: string; enabled: boolean }>>>;
  disableFeatures: readonly string[];
}

function featureSnapshot(
  rows: readonly [name: string, stage: string, enabled: boolean][],
): Readonly<Record<string, Readonly<{ stage: string; enabled: boolean }>>> {
  return Object.fromEntries(
    rows.map(([name, stage, enabled]) => [name, { stage, enabled }]),
  );
}

const CODEX_0145_FEATURES = featureSnapshot([
  ['apply_patch_freeform', 'removed', false],
  ['apply_patch_streaming_events', 'under development', false],
  ['apps', 'stable', true],
  ['apps_mcp_path_override', 'removed', false],
  ['artifact', 'under development', false],
  ['auth_elicitation', 'stable', true],
  ['browser_use', 'stable', true],
  ['browser_use_external', 'stable', true],
  ['browser_use_full_cdp_access', 'stable', true],
  ['chronicle', 'under development', false],
  ['code_mode', 'under development', false],
  ['code_mode_host', 'stable', true],
  ['code_mode_only', 'under development', false],
  ['codex_git_commit', 'removed', false],
  ['collaboration_modes', 'removed', true],
  ['computer_use', 'stable', true],
  ['concurrent_reasoning_summaries', 'under development', false],
  ['current_time_reminder', 'under development', false],
  ['default_mode_request_user_input', 'under development', false],
  ['deferred_executor', 'under development', false],
  ['elevated_windows_sandbox', 'removed', false],
  ['enable_fanout', 'under development', false],
  ['enable_mcp_apps', 'under development', false],
  ['enable_request_compression', 'stable', true],
  ['exec_permission_approvals', 'under development', false],
  ['experimental_windows_sandbox', 'removed', false],
  ['external_agent_memory_import', 'under development', false],
  ['external_migration', 'removed', false],
  ['fast_mode', 'stable', true],
  ['goals', 'stable', true],
  ['guardian_approval', 'stable', true],
  ['hooks', 'stable', true],
  ['image_detail_original', 'removed', false],
  ['image_generation', 'stable', true],
  ['in_app_browser', 'stable', true],
  ['item_ids', 'under development', false],
  ['js_repl', 'removed', false],
  ['js_repl_tools_only', 'removed', false],
  ['local_thread_store_compression', 'under development', false],
  ['memories', 'stable', true],
  ['mentions_v2', 'stable', true],
  ['multi_agent', 'stable', true],
  ['multi_agent_mode', 'removed', false],
  ['multi_agent_v2', 'under development', false],
  ['network_proxy', 'experimental', false],
  ['non_prefixed_mcp_tool_names', 'under development', false],
  ['personality', 'stable', true],
  ['plugin_hooks', 'removed', false],
  ['plugin_sharing', 'stable', true],
  ['plugins', 'stable', true],
  ['prevent_idle_sleep', 'experimental', false],
  ['realtime_conversation', 'under development', false],
  ['remote_compaction_v2', 'stable', true],
  ['remote_control', 'removed', false],
  ['remote_models', 'removed', false],
  ['remote_plugin', 'stable', true],
  ['request_permissions_tool', 'under development', false],
  ['request_rule', 'removed', false],
  ['resize_all_images', 'removed', true],
  ['respect_system_proxy', 'under development', false],
  ['responses_websockets', 'removed', false],
  ['responses_websockets_v2', 'removed', false],
  ['rollout_budget', 'under development', false],
  ['runtime_metrics', 'under development', false],
  ['search_tool', 'removed', false],
  ['secret_auth_storage', 'stable', false],
  ['shell_snapshot', 'stable', true],
  ['shell_tool', 'stable', true],
  ['shell_zsh_fork', 'under development', false],
  ['skill_env_var_dependency_prompt', 'removed', false],
  ['skill_mcp_dependency_install', 'stable', true],
  ['skill_search', 'stable', true],
  ['sqlite', 'removed', true],
  ['standalone_web_search', 'under development', false],
  ['steer', 'removed', true],
  ['terminal_resize_reflow', 'removed', true],
  ['terminal_visualization_instructions', 'under development', false],
  ['token_budget', 'under development', false],
  ['tool_call_mcp_elicitation', 'stable', true],
  ['tool_search', 'removed', false],
  ['tool_search_always_defer_mcp_tools', 'removed', true],
  ['tool_suggest', 'stable', true],
  ['tui_app_server', 'removed', true],
  ['unavailable_dummy_tools', 'removed', false],
  ['undo', 'removed', false],
  ['unified_exec', 'stable', true],
  ['unified_exec_zsh_fork', 'under development', false],
  ['use_agent_identity', 'under development', false],
  ['use_legacy_landlock', 'deprecated', false],
  ['use_linux_sandbox_bwrap', 'removed', false],
  ['web_search_cached', 'deprecated', false],
  ['web_search_request', 'deprecated', false],
  ['workspace_dependencies', 'stable', true],
  ['workspace_owner_usage_nudge', 'removed', false],
]);

// The account-backed CLI is used as a text-only model transport. Disable every
// feature that the reviewed binary reports as enabled; retaining a subjective
// "dangerous" subset would let newly understood remote/tool behavior execute
// before the output parser can reject it.
const DISABLED_CODEX_FEATURES = Object.freeze(
  Object.entries(CODEX_0145_FEATURES)
    .filter(([, state]) => state.enabled)
    .map(([name]) => name),
);

export const CODEX_CAPABILITY_MANIFESTS: readonly CodexCapabilityManifest[] = [
  {
    version: '0.145.0-alpha.18',
    requiredExecHelp: [
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--json',
      '--skip-git-repo-check',
      '--strict-config',
    ],
    requiredPromptInputHelp: ['prompt-input'],
    knownFeatures: CODEX_0145_FEATURES,
    disableFeatures: DISABLED_CODEX_FEATURES,
  },
];
