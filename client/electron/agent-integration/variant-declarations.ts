import type { CatalogId, ComponentKey } from './types'
import { CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS } from './release-manifest'

/**
 * Static per-variant physical composition (design §3.3.1, P0 Adapter matrix §2/§6).
 *
 * Every distribution variant that Tide Mind can write declares:
 *   - `logicalComponents`: the product components it projects;
 *   - `dependencies`: components whose fresh runtime activity proves another one;
 *   - `atomicGroups`: components delivered by one indivisible carrier (one plugin,
 *     one extension, one JSON document written in one CAS, …), each with the only
 *     deactivation method Tide Mind has for that carrier;
 *   - `supportedBundles`: the finite, verified connect combinations. A bundle is
 *     always a union of whole atomic groups; nothing else is inferred at runtime;
 *   - `physicalDomains`: stable shared-domain ids bound to their physical target
 *     templates. The same id on several variants means they write one physical
 *     artifact/container and are consumers of one shared domain;
 *   - `deactivationMethod`: the strongest mechanism any group needs.
 *
 * These are declarations, not runtime guesses. `tests/client/agent-integration-
 * variant-declarations.test.ts` binds them to the release manifest and the
 * concrete Adapter registry, so a missing or drifted declaration fails the build.
 * Path templates use `$HOME`, `$CONFIG_ROOT`, `$APP_DATA` and `$AGENT_ID`.
 */

export type DeactivationMethod =
  /** Tide Mind removes its own fragment/file after ownership + exact-bytes CAS; no host program runs. */
  | 'ownership_cas_file_fragment'
  /** Removal needs the host's own program (plugin manager / CLI); never run for an untrusted source. */
  | 'host_command'
  /** The user removes it in the host (GUI/import registry or a manual file removal) and confirms. */
  | 'guided_manual'
  /** No managed removal path exists (migration-only or no owned carrier). */
  | 'none'

export type VariantDisposition =
  | 'managed'
  | 'guided'
  | 'migration'
  | 'custom_inherited'
  | 'custom_managed'
  | 'custom_user_owned'

export interface AtomicGroupDeclaration {
  id: string
  components: readonly ComponentKey[]
  carrier: string
  deactivationMethod: DeactivationMethod
}

export interface PhysicalDomainDeclaration {
  /** Stable shared-domain id. Variants using the same id share the physical target. */
  id: string
  target: string
  components: readonly ComponentKey[]
  /** `artifact`: exact same owned artifact; `container`: same file, per-agent selectors. */
  sharing: 'dedicated' | 'artifact' | 'container'
}

export interface VariantDeclaration {
  /** P0 target identity: catalog + official distribution (or the Custom target key). */
  variantId: string
  catalogId: CatalogId | null
  distributionId: string | null
  disposition: VariantDisposition
  logicalComponents: readonly ComponentKey[]
  dependencies: Readonly<Partial<Record<ComponentKey, readonly ComponentKey[]>>>
  atomicGroups: readonly AtomicGroupDeclaration[]
  supportedBundles: readonly (readonly ComponentKey[])[]
  physicalDomains: readonly PhysicalDomainDeclaration[]
  deactivationMethod: DeactivationMethod
  /** C1 only: the declaration is the relocated source host's declaration. */
  inheritsFromSourceHost?: readonly CatalogId[]
}

const I = 'instruction' as const
const M = 'memory_tools' as const
const L = 'lifecycle' as const
const ALL = [I, M, L] as const

function strongest(groups: readonly AtomicGroupDeclaration[]): DeactivationMethod {
  const methods = new Set(groups.map(group => group.deactivationMethod))
  if (methods.has('host_command')) return 'host_command'
  if (methods.has('guided_manual')) return 'guided_manual'
  if (methods.has('ownership_cas_file_fragment')) return 'ownership_cas_file_fragment'
  return 'none'
}

function variant(
  input: Omit<VariantDeclaration, 'deactivationMethod'>,
): VariantDeclaration {
  return Object.freeze({
    ...input,
    logicalComponents: Object.freeze([...input.logicalComponents]),
    atomicGroups: Object.freeze(input.atomicGroups.map(group => Object.freeze({
      ...group,
      components: Object.freeze([...group.components]),
    }))),
    supportedBundles: Object.freeze(input.supportedBundles.map(bundle => Object.freeze([...bundle]))),
    physicalDomains: Object.freeze(input.physicalDomains.map(domain => Object.freeze({
      ...domain,
      components: Object.freeze([...domain.components]),
    }))),
    deactivationMethod: strongest(input.atomicGroups),
  })
}

const AGENTS_SHARED_SKILL: PhysicalDomainDeclaration = {
  id: 'agents_shared_skill', target: '$HOME/.agents/skills/tidemind/SKILL.md', components: [I], sharing: 'artifact',
}
const hostSkill = (id: string, target = '$CONFIG_ROOT/skills/tidemind/SKILL.md', sharing: PhysicalDomainDeclaration['sharing'] = 'dedicated'): PhysicalDomainDeclaration => ({
  id, target, components: [I], sharing,
})
const skillGroup = (method: DeactivationMethod = 'guided_manual'): AtomicGroupDeclaration => ({
  id: 'skill_document', components: [I], carrier: 'SKILL.md managed text', deactivationMethod: method,
})
const fragment = (id: string, components: readonly ComponentKey[], carrier: string): AtomicGroupDeclaration => ({
  id, components, carrier, deactivationMethod: 'ownership_cas_file_fragment',
})

/** Separately delivered I/M/L where lifecycle may be omitted (instruction then stays unverified). */
function separable(input: {
  variantId: string
  catalogId: CatalogId
  distributionId: string
  disposition?: VariantDisposition
  groups: readonly AtomicGroupDeclaration[]
  domains: readonly PhysicalDomainDeclaration[]
}): VariantDeclaration {
  return variant({
    variantId: input.variantId,
    catalogId: input.catalogId,
    distributionId: input.distributionId,
    disposition: input.disposition ?? 'managed',
    logicalComponents: ALL,
    dependencies: { instruction: [L] },
    atomicGroups: input.groups,
    supportedBundles: [ALL, [I, M]],
    physicalDomains: input.domains,
  })
}

/** One plugin/extension/package carries all three components; only the full group is verified. */
function aggregatePlugin(input: {
  variantId: string
  catalogId: CatalogId
  distributionId: string
  carrier: string
  domains: readonly PhysicalDomainDeclaration[]
}): VariantDeclaration {
  return variant({
    variantId: input.variantId,
    catalogId: input.catalogId,
    distributionId: input.distributionId,
    disposition: 'managed',
    logicalComponents: ALL,
    dependencies: { instruction: [L] },
    atomicGroups: [{ id: 'host_plugin', components: ALL, carrier: input.carrier, deactivationMethod: 'host_command' }],
    supportedBundles: [ALL],
    physicalDomains: input.domains,
  })
}

const claudePlugin = (catalogId: 'claude-code-cli' | 'claude-code-native', distributionId: string) => aggregatePlugin({
  variantId: catalogId,
  catalogId,
  distributionId,
  carrier: 'Claude Code marketplace plugin (plugin/.mcp.json/hooks/skill)',
  domains: [
    { id: `claude_plugin_source:${catalogId}`, target: '$APP_DATA/agent-integration/claude-code-marketplaces/tidemind-$AGENT_ID-local', components: ALL, sharing: 'dedicated' },
    { id: 'claude_plugin_registry', target: '$CONFIG_ROOT/plugins', components: ALL, sharing: 'container' },
  ],
})

const codex = (catalogId: 'codex-cli' | 'codex-desktop', distributionId: string) => separable({
  variantId: catalogId,
  catalogId,
  distributionId,
  groups: [
    skillGroup(),
    fragment('codex_mcp_table', [M], 'config.toml [mcp_servers.tidemind-<agentId>]'),
    fragment('codex_hooks_entry', [L], 'hooks.json hooks.tidemind-<agentId>'),
  ],
  domains: [
    AGENTS_SHARED_SKILL,
    { id: 'codex_config_toml', target: '$CONFIG_ROOT/config.toml', components: [M], sharing: 'container' },
    { id: 'codex_hooks_json', target: '$CONFIG_ROOT/hooks.json', components: [L], sharing: 'container' },
  ],
})

const kimi = (catalogId: 'kimi-code-cli' | 'kimi-code-native', distributionId: string) => separable({
  variantId: catalogId,
  catalogId,
  distributionId,
  groups: [
    // The Kimi instruction Adapter removes its own exact-hash document itself.
    skillGroup('ownership_cas_file_fragment'),
    fragment('kimi_mcp_entry', [M], 'mcp.json mcpServers.tidemind-<agentId>'),
    fragment('kimi_hook_blocks', [L], 'config.toml five [[hooks]] blocks as one fragment'),
  ],
  domains: [
    hostSkill('kimi_skill', '$CONFIG_ROOT/skills/tidemind/SKILL.md', 'artifact'),
    { id: 'kimi_mcp_json', target: '$CONFIG_ROOT/mcp.json', components: [M], sharing: 'container' },
    { id: 'kimi_config_toml', target: '$CONFIG_ROOT/config.toml', components: [L], sharing: 'container' },
  ],
})

const openclaw = (distributionId: string, suffix: string) => aggregatePlugin({
  variantId: `openclaw-local:${suffix}`,
  catalogId: 'openclaw-local',
  distributionId,
  carrier: 'OpenClaw native plugin + ordered host commands',
  domains: [
    { id: 'openclaw_plugin_source', target: '$APP_DATA/agent-integration/openclaw-plugins/$AGENT_ID', components: ALL, sharing: 'dedicated' },
    { id: 'openclaw_state_root', target: '$CONFIG_ROOT/openclaw.json', components: ALL, sharing: 'container' },
  ],
})

const qwen = (distributionId: string, suffix: string) => variant({
  variantId: `qwen-code-cli:${suffix}`,
  catalogId: 'qwen-code-cli',
  distributionId,
  disposition: 'managed',
  logicalComponents: ALL,
  dependencies: { instruction: [L] },
  atomicGroups: [
    skillGroup(),
    fragment('qwen_settings_aggregate', [M, L], 'settings.json mcpServers + hooks in one CAS'),
  ],
  supportedBundles: [ALL],
  physicalDomains: [
    hostSkill('qwen_skill', '$CONFIG_ROOT/skills/tidemind/SKILL.md', 'artifact'),
    { id: 'qwen_settings_json', target: '$CONFIG_ROOT/settings.json', components: [M, L], sharing: 'container' },
  ],
})

const opencodeV1 = (distributionId: string, suffix: string) => separable({
  variantId: `opencode-v1-cli:${suffix}`,
  catalogId: 'opencode-v1-cli',
  distributionId,
  groups: [
    skillGroup(),
    fragment('opencode_mcp_entry', [M], 'opencode.json(c) mcp.tidemind-<agentId>'),
    { id: 'opencode_v1_plugin_file', components: [L], carrier: 'plugins/tidemind-v1.ts', deactivationMethod: 'guided_manual' },
  ],
  domains: [
    AGENTS_SHARED_SKILL,
    { id: 'opencode_json', target: '$CONFIG_ROOT/opencode.json', components: [M], sharing: 'container' },
    { id: 'opencode_v1_plugin', target: '$CONFIG_ROOT/plugins/tidemind-v1.ts', components: [L], sharing: 'dedicated' },
  ],
})

const opencodeV2 = (distributionId: string, suffix: string) => variant({
  variantId: `opencode-v2-beta-cli:${suffix}`,
  catalogId: 'opencode-v2-beta-cli',
  distributionId,
  disposition: 'guided',
  logicalComponents: [I, M],
  dependencies: { instruction: [M] },
  atomicGroups: [
    skillGroup(),
    fragment('opencode_mcp_entry', [M], 'opencode.json(c) mcp.tidemind-<agentId>'),
  ],
  supportedBundles: [[I, M]],
  physicalDomains: [
    AGENTS_SHARED_SKILL,
    { id: 'opencode_json', target: '$CONFIG_ROOT/opencode.json', components: [M], sharing: 'container' },
  ],
})

/** The six Custom acceptance targets: C1 inherits its source host, C2 is managed JSON, C3–C5 user-owned. */
const customGuided = (schemaKind: string, selectorKey: string) => variant({
  variantId: `manual_mcp_client:${schemaKind}:${selectorKey}`,
  catalogId: 'custom-local-mcp',
  distributionId: null,
  disposition: 'custom_user_owned',
  logicalComponents: [M],
  dependencies: {},
  atomicGroups: [{ id: 'user_owned_mcp_import', components: [M], carrier: 'user-maintained MCP import', deactivationMethod: 'guided_manual' }],
  supportedBundles: [[M]],
  physicalDomains: [],
})

export const AGENT_VARIANT_DECLARATIONS: readonly VariantDeclaration[] = Object.freeze([
  claudePlugin('claude-code-cli', 'cli:claude-code-cli'),
  claudePlugin('claude-code-native', 'cli:claude-code-native'),
  variant({
    variantId: 'claude-desktop-legacy',
    catalogId: 'claude-desktop-legacy',
    distributionId: 'com.anthropic.claudefordesktop',
    disposition: 'migration',
    logicalComponents: [M],
    dependencies: {},
    // Read-only adoption: no connect bundle and no managed removal path.
    atomicGroups: [{ id: 'legacy_mcp_selector', components: [M], carrier: 'claude_desktop_config.json mcpServers.tidemind-<agentId>', deactivationMethod: 'none' }],
    supportedBundles: [],
    physicalDomains: [
      { id: 'claude_desktop_config_json', target: '$CONFIG_ROOT/claude_desktop_config.json', components: [M], sharing: 'container' },
    ],
  }),
  codex('codex-cli', 'cli:codex-cli'),
  codex('codex-desktop', 'com.openai.codex'),
  separable({
    variantId: 'cursor-desktop',
    catalogId: 'cursor-desktop',
    distributionId: 'com.todesktop.230313mzl4w4u92',
    groups: [
      skillGroup(),
      fragment('cursor_mcp_entry', [M], 'mcp.json mcpServers.tidemind-<agentId>'),
      fragment('cursor_hooks_entry', [L], 'hooks.json version:1 lifecycle entries'),
    ],
    domains: [
      hostSkill('cursor_skill'),
      { id: 'cursor_mcp_json', target: '$CONFIG_ROOT/mcp.json', components: [M], sharing: 'dedicated' },
      { id: 'cursor_hooks_json', target: '$CONFIG_ROOT/hooks.json', components: [L], sharing: 'dedicated' },
    ],
  }),
  separable({
    variantId: 'windsurf-desktop',
    catalogId: 'windsurf-desktop',
    distributionId: 'com.exafunction.windsurf',
    groups: [
      skillGroup(),
      fragment('windsurf_mcp_entry', [M], 'mcp_config.json mcpServers.tidemind-<agentId>'),
      fragment('windsurf_hooks_entry', [L], 'config.json lifecycle hooks'),
    ],
    domains: [
      hostSkill('windsurf_skill'),
      { id: 'windsurf_mcp_config_json', target: '$CONFIG_ROOT/mcp_config.json', components: [M], sharing: 'dedicated' },
      { id: 'windsurf_config_json', target: '$CONFIG_ROOT/config.json', components: [L], sharing: 'dedicated' },
    ],
  }),
  aggregatePlugin({
    variantId: 'gemini-cli',
    catalogId: 'gemini-cli',
    distributionId: 'cli:gemini-cli',
    carrier: 'Gemini CLI extension directory',
    domains: [
      { id: 'gemini_extension', target: '$CONFIG_ROOT/extensions/tidemind-$AGENT_ID', components: ALL, sharing: 'dedicated' },
    ],
  }),
  kimi('kimi-code-cli', 'cli:kimi-code-cli'),
  kimi('kimi-code-native', 'cli:kimi-code-native'),
  openclaw('cli:openclaw-local:portable-wrapper', 'portable-wrapper'),
  openclaw('cli:openclaw-local:npm-global', 'npm-global'),
  qwen('cli:qwen-code-cli:standalone', 'standalone'),
  qwen('cli:qwen-code-cli:npm-global', 'npm-global'),
  variant({
    variantId: 'zcode-desktop',
    catalogId: 'zcode-desktop',
    distributionId: 'dev.zcode.app',
    disposition: 'managed',
    logicalComponents: ALL,
    dependencies: { instruction: [L] },
    atomicGroups: [
      skillGroup(),
      fragment('zcode_config_aggregate', [M, L], 'config.json mcp.servers + hooks.events in one CAS'),
    ],
    supportedBundles: [ALL],
    physicalDomains: [
      hostSkill('zcode_skill', '$HOME/.zcode/skills/tidemind/SKILL.md'),
      // Same root as the observe-only zcode-cli, which is never a write consumer.
      { id: 'zcode_cli_config_json', target: '$CONFIG_ROOT/config.json', components: [M, L], sharing: 'container' },
    ],
  }),
  opencodeV1('cli:opencode-v1-cli:darwin-arm64', 'darwin-arm64'),
  opencodeV1('cli:opencode-v1-cli:darwin-x64', 'darwin-x64'),
  opencodeV2('cli:opencode-v2-beta-cli:darwin-arm64', 'darwin-arm64'),
  opencodeV2('cli:opencode-v2-beta-cli:darwin-x64', 'darwin-x64'),
  opencodeV2('cli:opencode-v2-beta-cli:darwin-x64-baseline', 'darwin-x64-baseline'),
  aggregatePlugin({
    variantId: 'pi-official-cli',
    catalogId: 'pi-official-cli',
    distributionId: 'pi-official:@earendil-works/pi-coding-agent',
    carrier: 'Pi package + settings.json packages selector',
    domains: [
      { id: 'pi_package_source', target: '$APP_DATA/agent-integration/pi-packages/$AGENT_ID', components: ALL, sharing: 'dedicated' },
      { id: 'pi_settings_json', target: '$CONFIG_ROOT/settings.json', components: ALL, sharing: 'container' },
    ],
  }),
  separable({
    variantId: 'omp-cli',
    catalogId: 'omp-cli',
    distributionId: 'omp:oh-my-pi',
    groups: [
      skillGroup(),
      fragment('omp_mcp_entry', [M], 'mcp.json mcpServers.tidemind-<agentId>'),
      { id: 'omp_extension_file', components: [L], carrier: 'extensions/tidemind.ts', deactivationMethod: 'guided_manual' },
    ],
    domains: [
      hostSkill('omp_skill'),
      { id: 'omp_mcp_json', target: '$CONFIG_ROOT/mcp.json', components: [M], sharing: 'dedicated' },
      { id: 'omp_extension', target: '$CONFIG_ROOT/extensions/tidemind.ts', components: [L], sharing: 'dedicated' },
    ],
  }),
  separable({
    variantId: 'qwenwork-desktop',
    catalogId: 'qwenwork-desktop',
    distributionId: 'cn.qwenwork.desktop.mac',
    groups: [
      skillGroup(),
      { id: 'qwenwork_gui_connector', components: [M], carrier: 'QwenWork GUI connector (no readable registry)', deactivationMethod: 'guided_manual' },
      fragment('qwenwork_hooks_entry', [L], 'settings.json lifecycle hooks'),
    ],
    domains: [
      hostSkill('qwenwork_skill'),
      { id: 'qwenwork_settings_json', target: '$CONFIG_ROOT/settings.json', components: [L], sharing: 'dedicated' },
    ],
  }),
  variant({
    variantId: 'claude-cowork-local',
    catalogId: 'claude-cowork-local',
    distributionId: 'com.anthropic.claudefordesktop',
    disposition: 'guided',
    logicalComponents: [I, M],
    dependencies: {},
    atomicGroups: [{ id: 'cowork_plugin_archive', components: [I, M], carrier: 'Tide Mind-owned .plugin export imported by the user', deactivationMethod: 'guided_manual' }],
    supportedBundles: [[I, M]],
    physicalDomains: [
      { id: 'cowork_plugin_export', target: '$APP_DATA/agent-integration/claude-cowork/<installationId>/tidemind-cowork.plugin', components: [I, M], sharing: 'dedicated' },
    ],
  }),
  // ---- Custom (design §1.2) ----
  Object.freeze({
    variantId: 'nonstandard_config_root',
    catalogId: null,
    distributionId: null,
    disposition: 'custom_inherited' as const,
    logicalComponents: Object.freeze([]),
    dependencies: Object.freeze({}),
    atomicGroups: Object.freeze([]),
    supportedBundles: Object.freeze([]),
    physicalDomains: Object.freeze([]),
    deactivationMethod: 'none' as const,
    inheritsFromSourceHost: Object.freeze([...CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS] as CatalogId[]),
  }),
  variant({
    variantId: 'manual_mcp_client',
    catalogId: 'custom-local-mcp',
    distributionId: null,
    disposition: 'custom_managed',
    logicalComponents: [M],
    dependencies: {},
    atomicGroups: [fragment('custom_json_selector', [M], 'user-selected JSON/JSONC selector')],
    supportedBundles: [[M]],
    physicalDomains: [
      { id: 'custom_selected_json', target: '<user selected JSON file>', components: [M], sharing: 'dedicated' },
    ],
  }),
  customGuided('standard_mcp_servers', 'tidemind'),
  customGuided('nested_mcp_servers', 'tidemind_nested'),
  customGuided('opencode_mcp', 'tidemind_opencode'),
])

const BY_DISTRIBUTION = new Map(AGENT_VARIANT_DECLARATIONS
  .filter(declaration => declaration.catalogId && declaration.distributionId)
  .map(declaration => [`${declaration.catalogId}\u0000${declaration.distributionId}`, declaration]))

/** Exact declaration for an official distribution variant, or undefined when none exists. */
export function variantDeclarationFor(
  catalogId: CatalogId,
  distributionId: string | null | undefined,
): VariantDeclaration | undefined {
  if (distributionId) {
    const exact = BY_DISTRIBUTION.get(`${catalogId}\u0000${distributionId}`)
    if (exact) return exact
  }
  // Variants of one catalog that differ only by distribution share the same
  // components, groups and deactivation; use them when the row's distribution
  // id is not yet authoritative (e.g. a fixture or pre-scan row).
  return AGENT_VARIANT_DECLARATIONS.find(declaration => declaration.catalogId === catalogId
    && declaration.disposition !== 'custom_user_owned'
    && declaration.disposition !== 'custom_managed')
}

export function variantDeclarationById(variantId: string): VariantDeclaration | undefined {
  return AGENT_VARIANT_DECLARATIONS.find(declaration => declaration.variantId === variantId)
}

/** Deactivation methods of the atomic groups touched by the given components. */
export function deactivationMethodsForComponents(
  declaration: VariantDeclaration,
  componentKeys: readonly ComponentKey[],
): readonly DeactivationMethod[] {
  return [...new Set(declaration.atomicGroups
    .filter(group => group.components.some(component => componentKeys.includes(component)))
    .map(group => group.deactivationMethod))]
}
