import type { CliCatalogModel, CliProviderType } from './types.js';

/**
 * 模型选择与执行合同的静态部分。
 *
 * 这里不再是模型权限名单（design §5）：
 * - Codex 的模型目录来自所选 CLI 的 app-server model/list；
 * - Claude Code 在 SDK 认证准入未被证明前（design §5.1 / B5）只提供官方 family alias
 *   作为选择建议，并允许用户手动输入模型 ID，UI 标注“别名/自定义、待验证”。
 */

/** Tide Mind selection mode meaning "use the CLI's own default model". Not a real model. */
export const FOLLOW_DEFAULT_MODEL = 'default';

/** Official Claude Code family aliases offered as suggestions (not an allowlist). */
export const CLAUDE_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export function claudeAliasCatalog(): CliCatalogModel[] {
  return CLAUDE_FAMILY_ALIASES.map((alias) => ({
    id: alias,
    invocationId: alias,
    displayName: alias.charAt(0).toUpperCase() + alias.slice(1),
    kind: 'alias' as const,
    isDefault: false,
    hidden: false,
    upgrade: null,
    retirementAt: null,
    reasoningEfforts: [],
  }));
}

export type ModelSelectionMode = 'follow_default' | 'alias' | 'pinned_id';

/**
 * Derive the selection mode from a persisted route value. Claude family aliases are
 * lowercase words (optionally with a `[1m]` context suffix); anything else is a pinned id.
 */
export function selectionModeFor(providerType: string, modelId: string): ModelSelectionMode {
  if (modelId === FOLLOW_DEFAULT_MODEL) return 'follow_default';
  if (providerType === 'claude-cli' && /^[a-z]+(?:\[1m\])?$/.test(modelId)) return 'alias';
  return 'pinned_id';
}

/**
 * Whether an actual model reported by the CLI can be proven equivalent to a pinned id.
 * Only identity or a dated snapshot suffix of the same id qualifies; everything else is a
 * mismatch (design §5.3). Callers must treat `actual === null` as unknown, not equal.
 */
export function pinnedModelMatches(requested: string, actual: string): boolean {
  if (actual === requested) return true;
  return actual.startsWith(`${requested}-`) && /^-\d{8}$/.test(actual.slice(requested.length));
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/** Manual model ids are passed as an independent argv element; still bound them. */
export function isValidManualModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

export const CLI_PROVIDER_TYPES: readonly CliProviderType[] = ['claude-cli', 'codex-cli'];

/**
 * Codex execution contract (design §4). Replaces the exact version + full feature
 * snapshot equality. Evidence: P0 CLI evidence doc §3.
 *
 * Every listed feature is passed as `--disable`, then the *effective* feature list is
 * read back with the same overrides. A feature that remains enabled must appear here
 * with the external boundary that constrains it; any other residual (in particular an
 * unreviewed name) blocks the inference channel as `unknown_active_feature`.
 */
export const CODEX_EXECUTION_CONTRACT_VERSION = 2;

export const CODEX_REQUIRED_EXEC_HELP = [
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--json',
  '--skip-git-repo-check',
  '--strict-config',
] as const;

export const CODEX_REQUIRED_PROMPT_INPUT_HELP = ['prompt-input'] as const;

export const CODEX_FORCED_FEATURE_BOUNDARIES: Readonly<Record<string, string>> = Object.freeze({
  // Removed-stage flags whose behavior is folded into core and cannot be disabled.
  item_ids: 'event item identifiers only',
  resize_all_images: 'image input scaling; no image input is sent',
  terminal_resize_reflow: 'interactive TUI only; exec is non-interactive',
  tui_app_server: 'interactive TUI only; exec is non-interactive',
  tool_search_always_defer_mcp_tools: 'MCP deferral; mcp_servers={} leaves no MCP tools',
  collaboration_modes: 'mode prompts disabled by include_collaboration_mode_instructions=false',
  steer: 'interactive steering only; stdin prompt is committed once',
  sqlite: 'local state store; --ephemeral keeps no session',
  // Official rust-v0.157.1 tools/spec_plan.rs:add_shell_tools returns before any
  // registration when ShellTool is false. gate-codex requires that effective state.
  unified_exec: 'shell_tool=false prevents registering exec_command/write_stdin',
  unified_exec_zsh_fork: 'shell_tool=false prevents shell registration',

});

/** Static `-c` overrides shared by inference and contract verification. */
export const CODEX_EXEC_CONFIG_OVERRIDES = [
  '-c', 'approval_policy="never"',
  '-c', 'tools.experimental_request_user_input.enabled=false',
  '-c', 'tools.update_plan.enabled=false',
  '-c', 'skills.include_instructions=false',
  '-c', 'mcp_servers={}',
  '-c', 'hooks={}',
  '-c', 'notify=[]',
  '-c', 'marketplaces={}',
  '-c', 'plugins={}',
  '-c', 'apps={}',
  '-c', 'web_search="disabled"',
  '-c', 'include_environment_context=false',
  '-c', 'include_permissions_instructions=false',
  '-c', 'include_apps_instructions=false',
  '-c', 'include_collaboration_mode_instructions=false',
] as const;
