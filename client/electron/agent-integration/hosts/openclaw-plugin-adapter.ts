import { execFile } from 'node:child_process'
import { nativeBrainToolContracts } from './native-tool-contracts'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyHostActivity, verifyMemoryReadWriteActivity } from '../host-activity-evidence'
import { applyJsonProjection, inspectJsonProjection, type JsonProjectionInspection } from '../json-projection'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
} from '../safe-file'
import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdapterVerificationRequest,
  AdoptableArtifactObservation,
  AgentHostAdapter,
  ComponentKey,
  ComponentVerificationResult,
  FrozenHostCommand,
  FrozenIntermediateState,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

export const OPENCLAW_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'post_compact', 'session_end',
] as const)

export interface OpenClawCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface OpenClawPluginAdapterDependencies {
  run(
    executableRealpath: string,
    args: readonly string[],
    options: { timeoutMs: number; env: Readonly<Record<string, string>>; cwd: string },
  ): Promise<OpenClawCommandResult>
}

export interface OpenClawPluginHostSpec {
  adapterVersion: string
  dependencies?: OpenClawPluginAdapterDependencies
}

interface DesiredPlugin {
  pluginId: string
  pluginRoot: string
  configPath: string
  pluginVersion: string
  files: Readonly<Record<string, string>>
  payloadFiles: Readonly<Record<string, string>>
  fullBundleHash: string
  payloadBundleHash: string
  hostHash: string
  desiredHash: string
}

interface BundleInspection {
  state: 'absent' | 'payload' | 'exact' | 'other'
  fingerprint: string | null
  fileHashes: Readonly<Record<string, string | null>>
  entries: readonly string[]
  diagnostics: readonly string[]
}

interface PluginInspection {
  state: 'absent' | 'exact' | 'before' | 'disabled' | 'hooks_pending' | 'conflict' | 'unknown'
  fingerprint: string | null
  diagnostics: readonly string[]
}

interface AggregateInspection {
  bundle: BundleInspection
  plugin: PluginInspection
  fingerprint: string
  exact: boolean
  absent: boolean
  diagnostics: readonly string[]
}

interface OpenClawMutationMetadata {
  kind: 'openclaw_plugin_aggregate'
  direction: 'install' | 'remove'
  pluginId: string
  pluginRoot: string
  configPath: string
  pluginVersion: string
  desiredFiles: Readonly<Record<string, string>>
  payloadFiles: Readonly<Record<string, string>>
  beforeFileHashes: Readonly<Record<string, string | null>>
  beforeEntries: readonly string[]
  beforeBundleFingerprint: string | null
  beforePluginFingerprint: string | null
  beforeAggregateFingerprint: string
  commandStepIds: readonly string[]
  legacyTransfer?: {
    physicalTarget: string
    ownershipKey: string
    selector: readonly string[]
    fragmentHash: string
    containerPreconditionHash: string
    canonicalPath: string
  }
}

const execFileAsync = promisify(execFile)
const COMPONENTS = ['instruction', 'memory_tools', 'lifecycle'] as const satisfies readonly ComponentKey[]
const TOOLS = ['brain_prepare', 'brain_recall', 'brain_digest'] as const
const HOOKS = ['after_compaction', 'before_compaction', 'before_prompt_build', 'llm_input', 'session_end', 'session_start'] as const
const OFFICIAL_PROVENANCE = 'npm_metadata:openclaw'
const SELECTOR_SCHEMA_VERSION = 1
const COMMAND_TIMEOUT_MS = 45_000
const RESTART_TIMEOUT_MS = 5 * 60_000 + 15_000
const MAX_BUNDLE_ENTRIES = 64
const MAX_BUNDLE_FILE_BYTES = 1024 * 1024
const ACTIVATION_MARKER = '.tidemind-activated.json'

/** Native OpenClaw plugin managed only through OpenClaw's official plugin CLI. */
export function createOpenClawPluginHostAdapter(spec: OpenClawPluginHostSpec): AgentHostAdapter {
  const dependencies = spec.dependencies ?? productionDependencies()

  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const desired = desiredPlugin(context)
    const diagnostics: string[] = []
    let aggregate: AggregateInspection
    try {
      aggregate = await inspectAggregate(context, desired, dependencies)
      diagnostics.push(...aggregate.diagnostics)
    } catch (error) {
      aggregate = unknownAggregate(errorMessage(error))
      diagnostics.push(errorMessage(error))
    }
    const manageable = manageableDistribution(context)
    if (!manageable.ok) diagnostics.push(manageable.reason)
    if (!runtimeAssetsPresent(context)) diagnostics.push('openclaw_plugin_runtime_assets_missing')
    const visibility = aggregate.exact ? 'dedicated' : aggregate.absent ? 'absent' : 'unknown'
    return {
      catalogId: 'openclaw-local',
      detected: executableExists(context),
      detectedVersion: context.hostVersion,
      distribution: { ...context.installation.distribution },
      components: COMPONENTS.map(componentKey => ({
        componentKey,
        visibility,
        verificationStatus: 'unverified',
        observedTarget: desired.pluginRoot,
        observedFragmentHash: aggregate.fingerprint,
        details: {
          implementation: 'openclaw_native_plugin',
          pluginId: desired.pluginId,
          pluginVersion: desired.pluginVersion,
        },
      })),
      provenance: [desired.pluginRoot, desired.configPath],
      diagnostics,
    }
  }

  const buildPlan = async (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    direction: OpenClawMutationMetadata['direction'],
  ): Promise<AdapterPlan> => {
    const desired = desiredPlugin(context)
    const diagnostics: string[] = []
    const mutations: PlannedMutation[] = []
    const manageable = manageableDistribution(context)
    if (!request.observed.detected) diagnostics.push('openclaw_host_not_detected')
    else if (!manageable.ok) diagnostics.push(manageable.reason)
    else if (!runtimeAssetsPresent(context)) diagnostics.push('openclaw_plugin_runtime_assets_missing')
    else {
      const current = await inspectAggregate(context, desired, dependencies)
      const baselines = ownedBaselines(request.ownedArtifacts, pluginPhysicalTarget(desired))
      const baseline = consistentAggregateBaseline(baselines)
      const legacy = legacyLooseBaselines(request.ownedArtifacts, desired, context)
      if (legacy.length > 0 && !baseline) {
        if (direction !== 'install' || legacy.length !== 1) {
          diagnostics.push('openclaw_legacy_mcp_ownership_ambiguous')
        } else if (!current.absent) {
          diagnostics.push('openclaw_legacy_mcp_plugin_target_occupied')
        } else {
          const transfer = inspectLegacyTransfer(context, desired, legacy[0])
          if (!transfer.ok) diagnostics.push(transfer.diagnostic)
          else mutations.push(pluginMutation(context, desired, current, undefined, direction, transfer.metadata, legacy[0]))
        }
      } else if (baselines.length > 0 && !baseline) {
        diagnostics.push('openclaw_plugin_aggregate_ownership_inconsistent')
      } else if (direction === 'remove') {
        if (current.absent) {
          // Already disconnected.
        } else if (!baseline) diagnostics.push('openclaw_plugin_disconnect_requires_ownership')
        else if (baseline.ownedFragmentHash !== current.fingerprint) {
          diagnostics.push('openclaw_plugin_disconnect_ownership_baseline_mismatch')
        } else mutations.push(pluginMutation(context, desired, current, baseline, direction))
      } else if (current.exact) {
        if (!baseline) diagnostics.push('openclaw_plugin_exact_state_requires_aggregate_ownership')
      } else if (current.plugin.state === 'conflict' || current.plugin.state === 'unknown') {
        diagnostics.push(...current.plugin.diagnostics)
      } else if (current.bundle.state === 'other' && !baseline) {
        diagnostics.push('openclaw_plugin_source_exists_without_ownership')
      } else if (baseline && baseline.ownedFragmentHash !== current.fingerprint) {
        diagnostics.push('openclaw_plugin_ownership_baseline_mismatch')
      } else if (current.plugin.state !== 'absent' && !baseline) {
        diagnostics.push('openclaw_plugin_registration_exists_without_ownership')
      } else mutations.push(pluginMutation(context, desired, current, baseline, direction))
    }
    return {
      catalogId: 'openclaw-local',
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations,
      requiredUserActions: [],
      diagnostics,
    }
  }

  return {
    catalogId: 'openclaw-local',
    adapterVersion: spec.adapterVersion,
    componentKeys: COMPONENTS,
    implementationTypes: {
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin', 'hook'],
    },
    componentContracts: {
      instruction: { deliveryMode: 'managed', artifactTypes: ['plugin', 'skill'], mutationDomain: 'plugin_manager', reload: 'restart_host' },
      memory_tools: { deliveryMode: 'managed', artifactTypes: ['plugin'], mutationDomain: 'plugin_manager', reload: 'restart_host' },
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['plugin', 'hook'], mutationDomain: 'plugin_manager', reload: 'restart_host' },
    },
    inspect,
    inspectAdoptableArtifacts: async context => inspectLegacyOpenClawArtifacts(context),
    plan: (context, request) => buildPlan(context, request, 'install'),
    disconnect: (context, request) => buildPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, 'remove'),
    async apply(context, mutation) {
      assertMutation(context, mutation)
      const metadata = parseMetadata(mutation)
      const desired = desiredFromMetadata(context, mutation, metadata)
      const before = await inspectAggregate(context, desired, dependencies)
      if (matchesDirection(before, metadata.direction)) return {
        operationId: mutation.operationId,
        effectObserved: false,
        postEffectFingerprint: before.absent ? undefined : before.fingerprint,
        hostReceipt: { idempotentNoop: true, pluginId: desired.pluginId } as Readonly<Record<string, JsonValue>>,
      }
      const safeResume = findSafeResume(mutation, before.fingerprint)
      if ((before.plugin.state === 'conflict' || before.plugin.state === 'unknown'
        || (before.bundle.state === 'other' && mutation.preconditionHash === undefined)) && !safeResume) {
        throw new Error(before.diagnostics.join(';') || 'openclaw_plugin_precondition_unknown')
      }
      if (before.fingerprint !== metadata.beforeAggregateFingerprint && !safeResume) {
        throw new Error('openclaw_plugin_aggregate_precondition_changed')
      }

      if (metadata.direction === 'install') {
        if (metadata.legacyTransfer) removeLegacyMcp(context, metadata)
        applyPayloadBundle(context, desired, metadata)
        let host = await inspectPlugin(context, desired, dependencies)
        if (host.state === 'absent' || host.state === 'before') {
          await runFrozenCommand(context, mutation, metadata, dependencies, 'plugin_install')
          host = await inspectPlugin(context, desired, dependencies)
        }
        if (host.state !== 'exact') {
          if (host.state !== 'disabled' && host.state !== 'hooks_pending') throw new Error(host.diagnostics.join(';') || 'openclaw_plugin_install_readback_failed')
          await runFrozenCommand(context, mutation, metadata, dependencies, 'plugin_prompt_permission')
          await runFrozenCommand(context, mutation, metadata, dependencies, 'plugin_delivery_permission')
          await runFrozenCommand(context, mutation, metadata, dependencies, 'plugin_enable')
          host = await inspectPlugin(context, desired, dependencies)
        }
        if (host.state !== 'exact') throw new Error(host.diagnostics.join(';') || 'openclaw_plugin_enable_readback_failed')
        await runFrozenCommand(context, mutation, metadata, dependencies, 'gateway_restart')
        writeActivationMarker(context, desired, metadata)
      } else {
        if (before.plugin.state !== 'absent') {
          await runFrozenCommand(context, mutation, metadata, dependencies, 'plugin_uninstall')
          const removed = await inspectPlugin(context, desired, dependencies)
          if (removed.state !== 'absent') throw new Error(removed.diagnostics.join(';') || 'openclaw_plugin_uninstall_readback_failed')
        }
        await runFrozenCommand(context, mutation, metadata, dependencies, 'gateway_restart')
        removeOwnedBundle(context, desired, metadata)
      }

      const after = await inspectAggregate(context, desired, dependencies)
      if (!matchesDirection(after, metadata.direction)) {
        throw new Error(after.diagnostics.join(';') || 'openclaw_plugin_readback_mismatch')
      }
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.absent ? undefined : after.fingerprint,
        hostReceipt: {
          pluginId: desired.pluginId,
          pluginRoot: desired.pluginRoot,
          runtimeInspectConfirmed: metadata.direction === 'install',
          gatewayRestarted: true,
        } as Readonly<Record<string, JsonValue>>,
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      try {
        assertMutation(context, mutation)
        const metadata = parseMetadata(mutation)
        const desired = desiredFromMetadata(context, mutation, metadata)
        const aggregate = await inspectAggregate(context, desired, dependencies)
        const matchesDesired = matchesDirection(aggregate, metadata.direction)
        if (metadata.legacyTransfer && !matchesDesired) {
          const legacy = inspectLegacyMcp(context, metadata.legacyTransfer)
          if (legacy.fragmentHash === metadata.legacyTransfer.fragmentHash && aggregate.absent) {
            return {
              operationId: mutation.operationId,
              observed: true,
              matchesDesired: false,
              observedFragmentHash: legacy.fragmentHash ?? undefined,
              visibility: 'dedicated',
              diagnostics: ['openclaw_legacy_mcp_pending_plugin_migration'],
            }
          }
          if (!legacy.fragmentExists) {
            const fingerprint = aggregate.absent ? migrationClearedFingerprint() : aggregate.fingerprint
            return {
              operationId: mutation.operationId,
              observed: true,
              matchesDesired: false,
              observedFragmentHash: fingerprint,
              visibility: aggregate.absent ? 'absent' : 'unknown',
              safeToResumeFrom: findSafeResume(mutation, fingerprint),
              diagnostics: ['openclaw_legacy_mcp_removed_plugin_migration_incomplete'],
            }
          }
          return unknownReadBack(mutation, 'openclaw_legacy_mcp_transfer_source_changed')
        }
        return {
          operationId: mutation.operationId,
          observed: !aggregate.absent,
          matchesDesired,
          observedFragmentHash: aggregate.absent ? undefined : aggregate.fingerprint,
          visibility: aggregate.exact ? 'dedicated' : aggregate.absent ? 'absent' : 'unknown',
          safeToResumeFrom: matchesDesired ? undefined : findSafeResume(mutation, aggregate.fingerprint),
          diagnostics: aggregate.diagnostics,
        }
      } catch (error) {
        return unknownReadBack(mutation, errorMessage(error))
      }
    },
    verify: (context, request) => verifyPlugin(context, request, desiredPlugin(context), dependencies),
  }
}

function inspectLegacyOpenClawArtifacts(context: AdapterOperationContext): readonly AdoptableArtifactObservation[] {
  const configPath = openClawConfigFile(context)
  const hookRoot = path.join(context.installation.canonicalConfigRoot, 'hooks', `tidemind-${context.agentId}`)
  try {
    assertContained(configPath, context.installation.canonicalConfigRoot)
    assertContained(hookRoot, context.installation.canonicalConfigRoot)
    const configFile = inspectRegularFileWithinRoot(configPath, context.installation.canonicalConfigRoot)
    if (!configFile.exists || !configFile.containerHash) return []
    const config = JSON.parse(fs.readFileSync(configFile.canonicalPath, 'utf8')) as Record<string, unknown>
    const ownershipKey = `mcp.servers.tidemind-${context.agentId}`
    const entry = (((config.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined)?.[`tidemind-${context.agentId}`])
    const expectedEntry = {
      command: context.runtime.shimPath,
      args: [context.runtime.mcpServerPath],
      env: { EB_AGENT_ID: context.agentId },
    }
    if (sha256Json(entry) !== sha256Json(expectedEntry)) return []
    if (!fs.existsSync(hookRoot) || fs.lstatSync(hookRoot).isSymbolicLink() || !fs.lstatSync(hookRoot).isDirectory()) return []
    const entries = fs.readdirSync(hookRoot, { withFileTypes: true })
    if (entries.length !== 2 || entries.some(item => item.isSymbolicLink() || !item.isFile())
      || entries.map(item => item.name).sort().join(',') !== 'HOOK.md,handler.ts') return []
    const hookFile = inspectRegularFileWithinRoot(path.join(hookRoot, 'HOOK.md'), context.installation.canonicalConfigRoot)
    const handlerFile = inspectRegularFileWithinRoot(path.join(hookRoot, 'handler.ts'), context.installation.canonicalConfigRoot)
    if (!hookFile.containerHash || !handlerFile.containerHash) return []
    const hook = fs.readFileSync(hookFile.canonicalPath, 'utf8')
    const handler = fs.readFileSync(handlerFile.canonicalPath, 'utf8')
    const skillPath = path.join(context.runtime.applicationDataDir, 'skill', 'openclaw-skill.md')
    if (!legacyOpenClawHookMatches(hook, context.agentId)
      || handler !== renderLegacyOpenClawHandler(context, skillPath)) return []
    const hookHash = sha256Json({ 'HOOK.md': hookFile.containerHash, 'handler.ts': handlerFile.containerHash })
    return [
      {
        componentKey: 'memory_tools',
        artifactType: 'mcp',
        domainKind: 'file_fragment',
        physicalTarget: configPath,
        ownershipKey,
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        projectionVersion: context.runtime.projectionVersion,
        containerHash: configFile.containerHash,
        fragmentHash: sha256Json(entry),
        identityAssertion: context.agentId,
        discoverReachability: 'shared_visible',
      },
      ...(['instruction', 'lifecycle'] as const).map(componentKey => ({
        componentKey,
        artifactType: componentKey === 'instruction' ? 'skill' as const : 'hook' as const,
        domainKind: 'directory' as const,
        physicalTarget: hookRoot,
        ownershipKey: `legacy-openclaw-hook:tidemind-${context.agentId}:${componentKey}`,
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        projectionVersion: context.runtime.projectionVersion,
        fragmentHash: hookHash,
        identityAssertion: context.agentId,
        discoverReachability: 'dedicated' as const,
      })),
    ] satisfies readonly AdoptableArtifactObservation[]
  } catch {
    return []
  }
}

function legacyOpenClawHookMatches(content: string, agentId: string): boolean {
  return content === [
    '---',
    `name: tidemind-${agentId}`,
    'description: "Tide Mind — 自动加载外脑上下文"',
    'metadata:',
    '  openclaw:',
    '    emoji: "🧠"',
    '    events: ["agent:bootstrap"]',
    '---',
    '',
    '在 Agent Bootstrap 时自动调用 Tide Mind 的 prepare 接口，将用户画像、记忆索引和行为指导注入为 MEMORY.md。',
  ].join('\n')
}

function renderLegacyOpenClawHandler(context: AdapterOperationContext, skillPath: string): string {
  return [
    "import { spawnSync } from 'child_process'",
    '',
    `const SHIM = ${JSON.stringify(context.runtime.shimPath)}`,
    `const HOOK_SCRIPT = ${JSON.stringify(context.runtime.hookScriptPath)}`,
    `const SKILL_PATH = ${JSON.stringify(skillPath)}`,
    `const AGENT_ID = ${JSON.stringify(context.agentId)}`,
    '',
    'const handler = async (event: any) => {',
    "  if (event.type !== 'agent' || event.action !== 'bootstrap') return",
    '  try {',
    `    const result = spawnSync(SHIM, [HOOK_SCRIPT, '--agent-id', AGENT_ID, '--skill-path', SKILL_PATH, '--tool', 'openclaw'], {`,
    '      timeout: 15000,',
    "      encoding: 'utf-8',",
    '    })',
    "    const output = result.stdout ?? ''",
    '    if (output.trim() && event.context.bootstrapFiles) {',
    "      event.context.bootstrapFiles.push({ name: 'MEMORY.md', content: output })",
    '    }',
    '  } catch { /* prepare 失败不阻断启动 */ }',
    '}',
    '',
    'export default handler',
    '',
  ].join('\n')
}

function productionDependencies(): OpenClawPluginAdapterDependencies {
  return {
    async run(executableRealpath, args, options) {
      try {
        const result = await execFileAsync(executableRealpath, [...args], {
          timeout: options.timeoutMs,
          env: { ...options.env },
          cwd: options.cwd,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        })
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? failure.message,
        }
      }
    },
  }
}

function openClawConfigFile(context: AdapterOperationContext): string {
  const target = context.installation.componentConfigFiles?.memory_tools
    ?? path.join(context.installation.canonicalConfigRoot, 'openclaw.json')
  if (path.dirname(target) !== context.installation.canonicalConfigRoot) {
    throw new Error('openclaw_config_outside_state_domain')
  }
  return target
}

function desiredPlugin(context: AdapterOperationContext): DesiredPlugin {
  const pluginId = `tidemind-${safeKebab(context.agentId)}`
  const pluginRoot = path.join(context.runtime.applicationDataDir, 'agent-integration', 'openclaw-plugins', safeKebab(context.agentId))
  const pluginVersion = packageVersion(context)
  const configPath = openClawConfigFile(context)
  const skillPath = path.join(pluginRoot, 'skills', 'tidemind', 'SKILL.md')
  const payloadFiles: Readonly<Record<string, string>> = Object.freeze({
    'package.json': jsonDocument({
      name: `@tidemind/openclaw-${safeKebab(context.agentId)}`,
      version: pluginVersion,
      private: true,
      type: 'module',
      description: 'Tide Mind native memory plugin for OpenClaw',
      openclaw: {
        extensions: ['./index.js'],
        install: { minHostVersion: '>=2026.8.1' },
        compat: { pluginApi: '>=2026.8.1' },
      },
    }),
    'openclaw.plugin.json': jsonDocument({
      id: pluginId,
      name: 'Tide Mind',
      description: 'Cross-session Tide Mind memory tools and lifecycle integration.',
      version: pluginVersion,
      activation: { onStartup: true, onCapabilities: ['tool', 'hook'] },
      contracts: { tools: [...TOOLS] },
      toolMetadata: Object.fromEntries(TOOLS.map(tool => [tool, { profiles: ['minimal', 'coding', 'messaging', 'full'] }])),
      skills: ['./skills'],
      configSchema: { type: 'object', additionalProperties: false, properties: {} },
    }),
    'skills/tidemind/SKILL.md': renderSkill(context),
    'index.js': renderPlugin(context, pluginId, skillPath),
  })
  const marker = JSON.stringify({ pluginId, pluginVersion, hostVersion: context.hostVersion ?? null }) + '\n'
  const files = Object.freeze({ ...payloadFiles, [ACTIVATION_MARKER]: marker })
  const payloadBundleHash = bundleFingerprint(payloadFiles)
  const fullBundleHash = bundleFingerprint(files)
  const hostHash = expectedHostHash(pluginId, pluginRoot, pluginVersion)
  return {
    pluginId,
    pluginRoot,
    configPath,
    pluginVersion,
    files,
    payloadFiles,
    fullBundleHash,
    payloadBundleHash,
    hostHash,
    desiredHash: aggregateFingerprint(fullBundleHash, hostHash),
  }
}

function renderSkill(context: AdapterOperationContext): string {
  return `---\nname: tidemind\ndescription: Tide Mind 外部记忆系统。准备上下文、检索历史并沉淀长期有价值的信息。\n---\n\n# Tide Mind\n\n此 Plugin 绑定 Tide Mind 身份 \`${context.agentId}\`，提供原生工具 \`brain_prepare\`、\`brain_recall\`、\`brain_digest\`。\n\n- 新会话开始时优先调用 \`brain_prepare\`。\n- 依赖历史背景、既往决策或用户偏好时调用 \`brain_recall\`。\n- 产生重要决策、事实、偏好、纠正或后续行动时调用 \`brain_digest\`。\n- 工具不可用时明确说明，不能假装已经查询或保存。\n`
}

function renderPlugin(context: AdapterOperationContext, pluginId: string, skillPath: string): string {
  const binding = JSON.stringify({
    pluginId,
    agentId: context.agentId,
    activityGenerationToken: context.activityGenerationToken ?? '',
    hostVariant: context.installation.hostVariant,
    shimPath: context.runtime.shimPath,
    mcpServerPath: context.runtime.mcpServerPath,
    sessionStartScript: context.runtime.hookScriptPath,
    preCompactScript: context.runtime.preCompactScriptPath,
    postCompactScript: context.runtime.postCompactScriptPath,
    lifecycleScript: openClawLifecycleScript(context),
    skillPath,
    expectedSkillSha256: sha256Bytes(renderSkill(context)),
  })
  return `import { spawn } from "node:child_process";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const BINDING = ${binding};
const TOOL_TIMEOUT_MS = 60_000;

function spawnBound(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, EB_AGENT_ID: BINDING.agentId, EB_HOST_VARIANT: BINDING.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: BINDING.activityGenerationToken },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(stdout);
    };
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 1_048_576) { child.kill("SIGTERM"); finish(new Error("Tide Mind context exceeds output limit")); }
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
    child.on("error", error => finish(error));
    child.on("close", code => code === 0 ? finish(undefined, 0) : finish(new Error("Tide Mind hook failed: " + stderr), code ?? 1));
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("Tide Mind hook timed out")); }, timeoutMs);
  });
}

function callMcp(tool, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(BINDING.shimPath, [BINDING.mcpServerPath], {
      env: { ...process.env, EB_AGENT_ID: BINDING.agentId, EB_HOST_VARIANT: BINDING.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: BINDING.activityGenerationToken },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      error ? reject(error) : resolve(value);
    };
    const send = message => child.stdin.write(JSON.stringify(message) + "\\n");
    const request = (method, params) => new Promise(done => {
      const id = nextId++;
      pending.set(id, done);
      send({ jsonrpc: "2.0", id, method, params });
    });
    const abort = () => finish(new Error("Tide Mind tool call aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    child.on("error", error => finish(error));
    child.on("close", code => { if (!settled) finish(new Error("Tide Mind MCP exited " + String(code) + ": " + stderr)); });
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf("\\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.id === "number" && pending.has(message.id)) {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done(message);
        } else if (typeof message.id === "number" && typeof message.method === "string") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client request unsupported" } });
        }
      }
    });
    const timer = setTimeout(() => finish(new Error("Tide Mind MCP timed out: " + stderr)), TOOL_TIMEOUT_MS);
    void (async () => {
      const initialized = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tidemind-openclaw-plugin", version: "1" },
      });
      if (initialized.error) throw new Error(initialized.error.message ?? "MCP initialize failed");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const response = await request("tools/call", { name: tool, arguments: args });
      if (response.error) throw new Error(response.error.message ?? "MCP tool failed");
      finish(undefined, response.result);
    })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function result(value) {
  return {
    content: Array.isArray(value?.content) ? value.content : [{ type: "text", text: JSON.stringify(value ?? null) }],
    details: { tideMind: true, agentId: BINDING.agentId },
    isError: value?.isError === true,
  };
}

function tool(name, description, parameters) {
  return {
    name,
    label: "Tide Mind: " + name,
    description,
    parameters,
    async execute(_id, params, signal) { return result(await callMcp(name, params, signal)); },
  };
}

export default definePluginEntry({
  id: BINDING.pluginId,
  name: "Tide Mind",
  description: "Tide Mind memory tools and lifecycle integration.",
  register(api) {
    const contracts = ${JSON.stringify(nativeBrainToolContracts())};
    for (const [name, contract] of Object.entries(contracts)) api.registerTool(tool(name, contract.description, contract.parameters));
    const sessions = new Map();
    const sessionId = (event, ctx) => {
      const id = ctx?.sessionId ?? event?.sessionId;
      return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
    };
    const prepareContext = async (script, extra = []) => {
      try {
        const output = await spawnBound(BINDING.shimPath, [script, "--agent-id", BINDING.agentId, "--tool", "openclaw", "--activity-generation-token", BINDING.activityGenerationToken, ...extra], 10_000);
        const payload = JSON.parse(output);
        if (payload.protocol !== "tidemind-openclaw-context-v1" || payload.evidenceEligible !== true
          || typeof payload.content !== "string" || !payload.content.trim()) return null;
        return payload.content;
      } catch { return null; }
    };
    const stateFor = id => {
      let state = sessions.get(id);
      if (!state) {
        state = { start: null, restored: null, delivered: new Set(), recording: new Set() };
        sessions.set(id, state);
        if (sessions.size > 256) sessions.delete(sessions.keys().next().value);
      }
      return state;
    };
    const record = (signal, timeout = 10_000) => spawnBound(BINDING.shimPath, [BINDING.lifecycleScript,
      "--agent-id", BINDING.agentId, "--signal", signal, "--activity-generation-token", BINDING.activityGenerationToken], timeout);
    api.on("session_start", (event, ctx) => {
      const id = sessionId(event, ctx);
      if (id) sessions.delete(id);
    });
    api.on("before_prompt_build", async (_event, ctx) => {
      const id = sessionId(null, ctx);
      if (!id) return;
      const state = stateFor(id);
      state.start ??= prepareContext(BINDING.sessionStartScript, ["--skill-path", BINDING.skillPath,
        "--expected-skill-sha256", BINDING.expectedSkillSha256]);
      const start = await state.start;
      if (!start) state.start = null;
      const restored = state.restored ? await state.restored : null;
      const content = [start, restored].filter(Boolean).join("\\n\\n");
      // This is OpenClaw's documented prompt mutation contract. Returning a
      // value does not yet prove delivery: llm_input acknowledges exact bytes.
      return content ? { prependSystemContext: content } : undefined;
    });
    api.on("llm_input", async (event, ctx) => {
      const id = sessionId(event, ctx);
      const state = id ? sessions.get(id) : null;
      if (!state || typeof event.systemPrompt !== "string") return;
      // Match only our already prepared block. Never inspect or retain prompt,
      // historyMessages, tool payloads, or any other conversation fields.
      for (const [signal, pending] of [["session_start", state.start], ["post_compact", state.restored]]) {
        const content = pending ? await pending : null;
        if (!content || !event.systemPrompt.includes(content) || state.delivered.has(signal) || state.recording.has(signal)) continue;
        state.recording.add(signal);
        try { await record(signal); state.delivered.add(signal); } catch { /* retry on a later acknowledged input */ }
        finally { state.recording.delete(signal); }
      }
    });
    api.on("before_compaction", async () => {
      // OpenClaw's compaction hook is observational; it cannot inject a
      // pre-compaction model turn. This evidence proves the event only.
      try { await record("pre_compact"); } catch { /* best effort */ }
    });
    api.on("after_compaction", (event, ctx) => {
      const id = sessionId(event, ctx);
      if (!id) return;
      const state = stateFor(id);
      state.delivered.delete("post_compact");
      state.restored = prepareContext(BINDING.postCompactScript);
    });
    api.on("session_end", async (event, ctx) => {
      const id = sessionId(event, ctx);
      if (id) sessions.delete(id);
      try { await record("session_end", 1_200); } catch { /* best effort */ }
    });
  },
});
`
}

function pluginMutation(
  context: AdapterOperationContext,
  desired: DesiredPlugin,
  current: AggregateInspection,
  baseline: OwnedArtifactBaseline | undefined,
  direction: OpenClawMutationMetadata['direction'],
  legacyTransfer?: NonNullable<OpenClawMutationMetadata['legacyTransfer']>,
  transferBaseline?: OwnedArtifactBaseline,
): PlannedMutation {
  const commands = commandSequence(context.installation.distribution.executableRealpath!, desired, direction)
  const metadata: OpenClawMutationMetadata = {
    kind: 'openclaw_plugin_aggregate',
    direction,
    pluginId: desired.pluginId,
    pluginRoot: desired.pluginRoot,
    configPath: desired.configPath,
    pluginVersion: desired.pluginVersion,
    desiredFiles: desired.files,
    payloadFiles: desired.payloadFiles,
    beforeFileHashes: current.bundle.fileHashes,
    beforeEntries: current.bundle.entries,
    beforeBundleFingerprint: current.bundle.fingerprint,
    beforePluginFingerprint: current.plugin.fingerprint,
    beforeAggregateFingerprint: current.fingerprint,
    commandStepIds: commands.map(command => command.stepId),
    ...(legacyTransfer ? { legacyTransfer } : {}),
  }
  return {
    operationId: `${context.operationId}:openclaw-plugin:${direction}`,
    componentKey: legacyTransfer ? 'memory_tools' : 'instruction',
    coveredComponentKeys: COMPONENTS,
    operation: 'host_command',
    domainKind: 'plugin_manager',
    physicalTarget: pluginPhysicalTarget(desired),
    ownershipKey: desired.pluginId,
    selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
    additionalFenceTargets: [
      { domainKind: 'directory', physicalTarget: desired.pluginRoot },
      { domainKind: 'file_fragment', physicalTarget: desired.configPath },
      { domainKind: 'directory', physicalTarget: context.installation.canonicalConfigRoot },
    ],
    risk: 'elevated',
    reload: 'restart_host',
    frozenCommands: commands.map(({ stepId: _stepId, ...command }) => command),
    safeResumeStates: safeResumeStates(desired, current, direction, legacyTransfer !== undefined),
    ...(legacyTransfer && transferBaseline ? {
      ownershipTransferFrom: {
        physicalTarget: transferBaseline.physicalTarget,
        ownershipKey: transferBaseline.ownershipKey,
        ownedFragmentHash: transferBaseline.ownedFragmentHash,
        selectorSchemaVersion: transferBaseline.selectorSchemaVersion ?? 1,
      },
    } : {}),
    preconditionHash: legacyTransfer ? transferBaseline?.ownedFragmentHash : baseline?.ownedFragmentHash,
    desiredFragmentHash: direction === 'remove' ? undefined : desired.desiredHash,
    idempotent: true,
    metadata: {
      ...(metadata as unknown as Readonly<Record<string, JsonValue>>),
      artifactKey: `openclaw-plugin:${desired.pluginId}`,
      artifactType: 'plugin',
      migrationSummary: '旧 MCP 升级为原生 Plugin',
      previewDescription: '安装 Tide Mind 原生工具并重启 OpenClaw；允许此插件注入自有上下文，并在模型输入中匹配该文本以确认交付。插件不读取用户 prompt 或历史消息，不保存会话正文。',
    },
  }
}

function commandSequence(
  executableRealpath: string,
  desired: DesiredPlugin,
  direction: OpenClawMutationMetadata['direction'],
): Array<FrozenHostCommand & { stepId: string }> {
  if (direction === 'remove') return [
    { stepId: 'plugin_uninstall', category: 'plugin_install', executableRealpath, args: ['plugins', 'uninstall', desired.pluginId, '--force'] },
    { stepId: 'gateway_restart', category: 'host_cli', executableRealpath, args: ['gateway', 'restart', '--safe', '--json'] },
  ]
  return [
    { stepId: 'plugin_install', category: 'plugin_install', executableRealpath, args: ['plugins', 'install', desired.pluginRoot, '--link', '--force', '--accept-capabilities'] },
    { stepId: 'plugin_prompt_permission', category: 'host_cli', executableRealpath, args: ['config', 'set', `plugins.entries.${desired.pluginId}.hooks.allowPromptInjection`, 'true', '--strict-json'] },
    { stepId: 'plugin_delivery_permission', category: 'host_cli', executableRealpath, args: ['config', 'set', `plugins.entries.${desired.pluginId}.hooks.allowConversationAccess`, 'true', '--strict-json'] },
    { stepId: 'plugin_enable', category: 'plugin_install', executableRealpath, args: ['plugins', 'enable', desired.pluginId, '--accept-capabilities'] },
    { stepId: 'gateway_restart', category: 'host_cli', executableRealpath, args: ['gateway', 'restart', '--safe', '--json'] },
  ]
}

function safeResumeStates(
  desired: DesiredPlugin,
  current: AggregateInspection,
  direction: OpenClawMutationMetadata['direction'],
  migratingLegacy = false,
): FrozenIntermediateState[] {
  const states: FrozenIntermediateState[] = []
  const add = (fingerprint: string, completedStepIds: string[]) => {
    if (!states.some(state => state.fingerprint === fingerprint)) states.push({ fingerprint, completedStepIds })
  }
  if (direction === 'install') {
    if (migratingLegacy) add(migrationClearedFingerprint(), ['legacy_mcp_removed'])
    add(aggregateFingerprint(desired.payloadBundleHash, null), ['plugin_source_written'])
    add(
      aggregateFingerprint(desired.payloadBundleHash, disabledHostHash(desired.pluginId, desired.pluginRoot, desired.pluginVersion)),
      ['plugin_source_written', 'plugin_install'],
    )
    add(aggregateFingerprint(desired.payloadBundleHash, hooksPendingHostHash(desired)), ['plugin_source_written', 'plugin_install'])
    add(aggregateFingerprint(desired.payloadBundleHash, desired.hostHash), ['plugin_source_written', 'plugin_install', 'plugin_enable'])
  } else {
    if (current.bundle.fingerprint) add(aggregateFingerprint(current.bundle.fingerprint, null), ['plugin_uninstall'])
  }
  return states
}

async function inspectAggregate(
  context: AdapterOperationContext,
  desired: DesiredPlugin,
  dependencies: OpenClawPluginAdapterDependencies,
): Promise<AggregateInspection> {
  const bundle = inspectBundle(context, desired)
  const plugin = await inspectPlugin(context, desired, dependencies)
  const diagnostics = [...bundle.diagnostics, ...plugin.diagnostics]
  return {
    bundle,
    plugin,
    fingerprint: aggregateFingerprint(bundle.fingerprint, plugin.fingerprint),
    exact: bundle.state === 'exact' && plugin.state === 'exact',
    absent: bundle.state === 'absent' && plugin.state === 'absent',
    diagnostics,
  }
}

function inspectBundle(context: AdapterOperationContext, desired: DesiredPlugin): BundleInspection {
  assertContained(desired.pluginRoot, context.runtime.applicationDataDir)
  if (!fs.existsSync(desired.pluginRoot)) return {
    state: 'absent',
    fingerprint: null,
    fileHashes: Object.fromEntries(Object.keys(desired.files).map(relative => [relative, null])),
    entries: [],
    diagnostics: [],
  }
  const stat = fs.lstatSync(desired.pluginRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('openclaw_plugin_root_not_safe_directory')
  const entries = listBundleEntries(desired.pluginRoot)
  const fileHashes: Record<string, string | null> = {}
  const diagnostics: string[] = []
  for (const relative of Object.keys(desired.files)) {
    const inspected = inspectRegularFileWithinRoot(path.join(desired.pluginRoot, relative), context.runtime.applicationDataDir)
    if (inspected.size !== null && inspected.size > MAX_BUNDLE_FILE_BYTES) diagnostics.push('openclaw_plugin_file_too_large')
    fileHashes[relative] = inspected.containerHash
  }
  if (entries.some(relative => !Object.hasOwn(desired.files, relative))) diagnostics.push('openclaw_plugin_contains_unexpected_entry')
  const fullExact = diagnostics.length === 0
    && entries.length === Object.keys(desired.files).length
    && Object.entries(desired.files).every(([relative, content]) => fileHashes[relative] === sha256Bytes(content))
  const payloadExact = diagnostics.length === 0
    && entries.length === Object.keys(desired.payloadFiles).length
    && Object.entries(desired.payloadFiles).every(([relative, content]) => fileHashes[relative] === sha256Bytes(content))
    && fileHashes[ACTIVATION_MARKER] === null
  const fingerprint = fullExact
    ? desired.fullBundleHash
    : payloadExact
      ? desired.payloadBundleHash
      : sha256Json(entries.map(relativePath => ({
          relativePath,
          hash: fileHashes[relativePath] ?? hashExistingFile(desired.pluginRoot, relativePath),
        })))
  return { state: fullExact ? 'exact' : payloadExact ? 'payload' : 'other', fingerprint, fileHashes, entries, diagnostics }
}

async function inspectPlugin(
  context: AdapterOperationContext,
  desired: DesiredPlugin,
  dependencies: OpenClawPluginAdapterDependencies,
): Promise<PluginInspection> {
  const executable = context.installation.distribution.executableRealpath
  if (!executable) return unknownPlugin('openclaw_executable_missing')
  const options = commandOptions(context, executable, COMMAND_TIMEOUT_MS)
  const listed = await dependencies.run(executable, ['plugins', 'list', '--json'], options)
  if (listed.exitCode !== 0) return unknownPlugin(`openclaw_plugins_list_failed:${listed.exitCode}:${boundedDiagnostic(listed.stderr || listed.stdout)}`)
  const parsed = parseJson(listed.stdout)
  if (!parsed.ok) return unknownPlugin('openclaw_plugins_list_json_invalid')
  const records = pluginRecords(parsed.value).filter(record => record.id === desired.pluginId)
  if (records.length === 0) return { state: 'absent', fingerprint: null, diagnostics: [] }
  if (records.length !== 1) return conflictPlugin('openclaw_plugin_duplicate_id')
  const cold = normalizePluginRecord(records[0])
  if (!cold || cold.root !== path.resolve(desired.pluginRoot)) {
    return conflictPlugin('openclaw_plugin_registration_conflict', records[0])
  }
  const permissions = inspectJsonProjection(desired.configPath, ['plugins', 'entries', desired.pluginId, 'hooks'], context.installation.canonicalConfigRoot)
  const hooksPolicy = permissions.fragmentExists ? permissions.fragment : {}
  if (!isRecord(hooksPolicy) || hooksPolicy.allowPromptInjection === false || hooksPolicy.allowConversationAccess === false) {
    return conflictPlugin('openclaw_prompt_hooks_explicitly_disabled')
  }
  if (!cold.enabled) return { state: 'disabled', fingerprint: cold.fingerprint, diagnostics: ['openclaw_plugin_disabled'] }
  if (hooksPolicy.allowPromptInjection !== true || hooksPolicy.allowConversationAccess !== true) {
    return { state: 'hooks_pending', fingerprint: hooksPendingHostHash(desired), diagnostics: ['openclaw_prompt_hooks_permission_pending'] }
  }
  const runtime = await dependencies.run(executable, ['plugins', 'inspect', desired.pluginId, '--runtime', '--json'], options)
  if (runtime.exitCode !== 0) return unknownPlugin(`openclaw_plugin_runtime_inspect_failed:${runtime.exitCode}:${boundedDiagnostic(runtime.stderr || runtime.stdout)}`)
  const runtimeJson = parseJson(runtime.stdout)
  if (!runtimeJson.ok) return unknownPlugin('openclaw_plugin_runtime_inspect_json_invalid')
  const runtimeRecords = pluginRecords(runtimeJson.value).filter(record => record.id === desired.pluginId)
  if (runtimeRecords.length !== 1) return conflictPlugin('openclaw_plugin_runtime_identity_ambiguous')
  const loaded = normalizePluginRecord(runtimeRecords[0])
  if (!loaded || loaded.root !== path.resolve(desired.pluginRoot) || !loaded.enabled || loaded.version !== cold.version) {
    return conflictPlugin('openclaw_plugin_runtime_binding_conflict', runtimeRecords[0])
  }
  const tools = stringArray(runtimeRecords[0].toolNames ?? runtimeRecords[0].tools)
  const hooks = stringArray(runtimeRecords[0].hookNames ?? runtimeRecords[0].hooks)
  if (!sameStrings(tools, TOOLS) || !sameStrings(hooks, HOOKS)) {
    return conflictPlugin('openclaw_plugin_runtime_contract_mismatch', runtimeRecords[0])
  }
  if (loaded.version !== desired.pluginVersion) {
    return {
      state: 'before',
      fingerprint: expectedHostHash(desired.pluginId, desired.pluginRoot, loaded.version),
      diagnostics: [],
    }
  }
  return { state: 'exact', fingerprint: desired.hostHash, diagnostics: [] }
}

function normalizePluginRecord(record: Record<string, unknown>): { root: string; version: string; enabled: boolean; fingerprint: string } | null {
  const root = firstString(record.rootDir, record.root, record.source, isRecord(record.install) ? record.install.sourcePath : undefined)
  const version = firstString(record.version, isRecord(record.manifest) ? record.manifest.version : undefined)
  const enabled = record.enabled === true || record.status === 'loaded' || record.status === 'enabled'
  if (!root || !path.isAbsolute(root) || !version) return null
  return { root: path.resolve(root), version, enabled, fingerprint: sha256Json({ id: record.id, root: path.resolve(root), version, enabled }) }
}

function pluginRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  if (typeof value.id === 'string') return [value]
  if (Array.isArray(value.plugins)) return value.plugins.filter(isRecord)
  if (isRecord(value.plugin)) return [value.plugin]
  if (isRecord(value.details)) return [value.details]
  return []
}

function applyPayloadBundle(context: AdapterOperationContext, desired: DesiredPlugin, metadata: OpenClawMutationMetadata): void {
  const current = inspectBundle(context, desired)
  if (current.state === 'payload' || current.state === 'exact') return
  if (current.state === 'other' && metadata.beforeBundleFingerprint === null) throw new Error('openclaw_plugin_bundle_cas_conflict')
  if (current.fingerprint !== metadata.beforeBundleFingerprint) throw new Error('openclaw_plugin_bundle_precondition_changed')
  for (const relative of metadata.beforeEntries) {
    if (Object.hasOwn(desired.payloadFiles, relative)) continue
    const target = path.join(desired.pluginRoot, relative)
    const inspected = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    if (inspected.containerHash !== (metadata.beforeFileHashes[relative] ?? null)) throw new Error('openclaw_plugin_stale_file_changed')
    fs.unlinkSync(inspected.canonicalPath)
  }
  for (const [relative, content] of Object.entries(desired.payloadFiles)) {
    const target = path.join(desired.pluginRoot, relative)
    const observed = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    const desiredHash = sha256Bytes(content)
    if (observed.containerHash === desiredHash) continue
    const beforeHash = metadata.beforeFileHashes[relative] ?? null
    if (observed.containerHash !== beforeHash) throw new Error('openclaw_plugin_file_cas_conflict')
    ensureSafeParentDirectoryWithinRoot(target, context.runtime.applicationDataDir)
    writeRegularFileAtomicCas(target, content, {
      expectedContainerHash: beforeHash,
      expectedCanonicalPath: inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir).canonicalPath,
      createMode: 0o600,
    })
  }
  const after = inspectBundle(context, desired)
  if (after.state !== 'payload') throw new Error('openclaw_plugin_payload_readback_mismatch')
}

function writeActivationMarker(context: AdapterOperationContext, desired: DesiredPlugin, metadata: OpenClawMutationMetadata): void {
  const target = path.join(desired.pluginRoot, ACTIVATION_MARKER)
  const observed = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
  const content = desired.files[ACTIVATION_MARKER]
  if (observed.containerHash !== null && observed.containerHash !== sha256Bytes(content)) {
    throw new Error('openclaw_plugin_activation_marker_conflict')
  }
  if (observed.containerHash === null) {
    writeRegularFileAtomicCas(target, content, {
      expectedContainerHash: null,
      expectedCanonicalPath: observed.canonicalPath,
      createMode: 0o600,
    })
  }
  if (inspectBundle(context, desired).state !== 'exact') throw new Error('openclaw_plugin_activation_marker_readback_mismatch')
}

function removeOwnedBundle(context: AdapterOperationContext, desired: DesiredPlugin, metadata: OpenClawMutationMetadata): void {
  const current = inspectBundle(context, desired)
  if (current.state === 'absent') return
  if (current.fingerprint !== metadata.beforeBundleFingerprint) throw new Error('openclaw_plugin_remove_bundle_precondition_changed')
  for (const relative of current.entries) {
    const inspected = inspectRegularFileWithinRoot(path.join(desired.pluginRoot, relative), context.runtime.applicationDataDir)
    if (inspected.containerHash !== (metadata.beforeFileHashes[relative] ?? null)) throw new Error('openclaw_plugin_remove_file_changed')
    fs.unlinkSync(inspected.canonicalPath)
  }
  removeEmptyDirectories(desired.pluginRoot)
}

async function runFrozenCommand(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: OpenClawMutationMetadata,
  dependencies: OpenClawPluginAdapterDependencies,
  stepId: string,
): Promise<void> {
  const index = metadata.commandStepIds.indexOf(stepId)
  if (index < 0) throw new Error(`openclaw_plugin_command_step_missing:${stepId}`)
  const command = mutation.frozenCommands?.[index]
  if (!command) throw new Error(`openclaw_plugin_frozen_command_missing:${stepId}`)
  const timeoutMs = stepId === 'gateway_restart' ? RESTART_TIMEOUT_MS : COMMAND_TIMEOUT_MS
  const result = await dependencies.run(command.executableRealpath, command.args, commandOptions(context, command.executableRealpath, timeoutMs))
  if (result.exitCode !== 0) throw new Error(`openclaw_${stepId}_failed:${result.exitCode}:${boundedDiagnostic(result.stderr || result.stdout)}`)
}

async function verifyPlugin(
  context: AdapterOperationContext,
  request: AdapterVerificationRequest,
  desired: DesiredPlugin,
  dependencies: OpenClawPluginAdapterDependencies,
): Promise<readonly ComponentVerificationResult[]> {
  const requested = COMPONENTS.filter(component => request.componentKeys.includes(component))
  const aggregate = await inspectAggregate(context, desired, dependencies)
  if (request.expectedCapability === 0 && aggregate.absent) return requested.map(componentKey => ({
    componentKey,
    status: 'verified',
    verifiedCapability: 0,
    identityAssertion: context.agentId,
    invalidationKeys: ['host_version', 'adapter_version', 'projection_version'],
    diagnostics: ['openclaw_plugin_and_source_absent'],
  }))
  if (!aggregate.exact) return requested.map(component => unverifiedStatic(component, aggregate.fingerprint, aggregate.diagnostics))

  const instructionActivity = await verifyHostActivity(context, request, {
    componentKey: 'lifecycle', signalNames: ['session_start'], require: 'all',
  })
  const memoryActivity = await verifyMemoryReadWriteActivity(context, request)
  const lifecycleActivity = await verifyHostActivity(context, request, {
    componentKey: 'lifecycle', signalNames: OPENCLAW_REQUIRED_LIFECYCLE_SIGNALS, require: 'all',
  })
  return requested.map(component => {
    const activity = component === 'instruction' ? instructionActivity : component === 'memory_tools' ? memoryActivity : lifecycleActivity
    if (activity.status !== 'verified') return unverifiedStatic(component, aggregate.fingerprint, activity.diagnostics)
    return {
      ...activity,
      componentKey: component,
      verifiedCapability: component === 'instruction' ? 1 : component === 'memory_tools' ? 2 : 4,
      diagnostics: ['openclaw_native_plugin_runtime_registered', ...activity.diagnostics],
    }
  })
}

function assertMutation(context: AdapterOperationContext, mutation: PlannedMutation): void {
  const metadata = parseMetadata(mutation)
  const desired = desiredFromMetadata(context, mutation, metadata)
  const executable = context.installation.distribution.executableRealpath
  const expected = commandSequence(executable ?? '', desired, metadata.direction).map(({ stepId: _stepId, ...command }) => command)
  if (!executable || !path.isAbsolute(executable)
    || mutation.operation !== 'host_command'
    || mutation.domainKind !== 'plugin_manager'
    || mutation.componentKey !== (metadata.legacyTransfer ? 'memory_tools' : 'instruction')
    || !sameStrings(mutation.coveredComponentKeys ?? [], COMPONENTS)
    || mutation.physicalTarget !== pluginPhysicalTarget(desired)
    || mutation.ownershipKey !== desired.pluginId
    || mutation.selectorSchemaVersion !== SELECTOR_SCHEMA_VERSION
    || mutation.reload !== 'restart_host'
    || sha256Json(mutation.frozenCommands) !== sha256Json(expected)) {
    throw new Error('openclaw_plugin_mutation_not_frozen')
  }
  if (metadata.legacyTransfer) {
    const transfer = mutation.ownershipTransferFrom
    if (!transfer
      || transfer.physicalTarget !== metadata.legacyTransfer.physicalTarget
      || transfer.ownershipKey !== metadata.legacyTransfer.ownershipKey
      || transfer.ownedFragmentHash !== metadata.legacyTransfer.fragmentHash
      || mutation.preconditionHash !== transfer.ownedFragmentHash) {
      throw new Error('openclaw_plugin_legacy_transfer_not_frozen')
    }
  } else if (mutation.ownershipTransferFrom !== undefined) {
    throw new Error('openclaw_plugin_unexpected_ownership_transfer')
  }
  const fences = mutation.additionalFenceTargets ?? []
  if (fences.length !== 3
    || !fences.some(target => target.domainKind === 'directory' && target.physicalTarget === desired.pluginRoot)
    || !fences.some(target => target.domainKind === 'file_fragment' && target.physicalTarget === desired.configPath)
    || !fences.some(target => target.domainKind === 'directory' && target.physicalTarget === context.installation.canonicalConfigRoot)) {
    throw new Error('openclaw_plugin_fence_targets_invalid')
  }
  assertContained(desired.pluginRoot, context.runtime.applicationDataDir)
  if (desired.configPath !== openClawConfigFile(context)) {
    throw new Error('openclaw_plugin_config_root_not_frozen')
  }
}

function desiredFromMetadata(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: OpenClawMutationMetadata,
): DesiredPlugin {
  const expected = desiredPlugin(context)
  if (metadata.pluginId !== expected.pluginId
    || metadata.pluginRoot !== expected.pluginRoot
    || metadata.configPath !== expected.configPath
    || metadata.pluginVersion !== expected.pluginVersion
    || sha256Json(metadata.desiredFiles) !== sha256Json(expected.files)
    || sha256Json(metadata.payloadFiles) !== sha256Json(expected.payloadFiles)) {
    throw new Error('openclaw_plugin_metadata_projection_mismatch')
  }
  if (metadata.direction === 'install' && mutation.desiredFragmentHash !== expected.desiredHash) {
    throw new Error('openclaw_plugin_desired_hash_invalid')
  }
  if (metadata.direction === 'remove' && mutation.desiredFragmentHash !== undefined) {
    throw new Error('openclaw_plugin_remove_hash_invalid')
  }
  if (metadata.legacyTransfer && (
    metadata.legacyTransfer.physicalTarget !== expected.configPath
    || metadata.legacyTransfer.ownershipKey !== `mcp.servers.tidemind-${context.agentId}`
    || sha256Json(metadata.legacyTransfer.selector) !== sha256Json(metadata.legacyTransfer.ownershipKey.split('.'))
  )) throw new Error('openclaw_plugin_legacy_transfer_projection_mismatch')
  return expected
}

function parseMetadata(mutation: PlannedMutation): OpenClawMutationMetadata {
  const value = mutation.metadata as unknown as Partial<OpenClawMutationMetadata> | undefined
  if (!value || value.kind !== 'openclaw_plugin_aggregate'
    || !['install', 'remove'].includes(value.direction ?? '')
    || typeof value.pluginId !== 'string'
    || typeof value.pluginRoot !== 'string'
    || typeof value.configPath !== 'string'
    || typeof value.pluginVersion !== 'string'
    || !isStringRecord(value.desiredFiles)
    || !isStringRecord(value.payloadFiles)
    || !isNullableStringRecord(value.beforeFileHashes)
    || !Array.isArray(value.beforeEntries) || !value.beforeEntries.every(item => typeof item === 'string')
    || (value.beforeBundleFingerprint !== null && typeof value.beforeBundleFingerprint !== 'string')
    || (value.beforePluginFingerprint !== null && typeof value.beforePluginFingerprint !== 'string')
    || typeof value.beforeAggregateFingerprint !== 'string'
    || !Array.isArray(value.commandStepIds) || !value.commandStepIds.every(item => typeof item === 'string')
    || (value.legacyTransfer !== undefined && !validLegacyTransfer(value.legacyTransfer))) {
    throw new Error('openclaw_plugin_mutation_metadata_invalid')
  }
  return value as OpenClawMutationMetadata
}

function validLegacyTransfer(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.physicalTarget === 'string'
    && typeof value.ownershipKey === 'string'
    && Array.isArray(value.selector) && value.selector.every(item => typeof item === 'string')
    && typeof value.fragmentHash === 'string' && /^[a-f0-9]{64}$/u.test(value.fragmentHash)
    && typeof value.containerPreconditionHash === 'string' && /^[a-f0-9]{64}$/u.test(value.containerPreconditionHash)
    && typeof value.canonicalPath === 'string'
}

function commandOptions(context: AdapterOperationContext, executable: string, timeoutMs: number) {
  return {
    timeoutMs,
    cwd: context.runtime.homeDir,
    env: openClawEnvironment(context, executable),
  }
}

function openClawEnvironment(context: AdapterOperationContext, executable: string): Readonly<Record<string, string>> {
  const directories = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.dirname(executable)])
  return {
    HOME: context.runtime.homeDir,
    OPENCLAW_STATE_DIR: context.installation.canonicalConfigRoot,
    OPENCLAW_CONFIG_PATH: openClawConfigFile(context),
    NO_COLOR: '1',
    PATH: [...directories].join(path.delimiter),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  }
}

function manageableDistribution(context: AdapterOperationContext): { ok: true } | { ok: false; reason: string } {
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable)) return { ok: false, reason: 'openclaw_executable_realpath_unproven' }
  if (context.installation.distribution.packageProvenance !== OFFICIAL_PROVENANCE) {
    return { ok: false, reason: 'openclaw_official_distribution_identity_unproven' }
  }
  return { ok: true }
}

function runtimeAssetsPresent(context: AdapterOperationContext): boolean {
  return [
    context.runtime.shimPath,
    context.runtime.mcpServerPath,
    context.runtime.hookScriptPath,
    context.runtime.preCompactScriptPath,
    context.runtime.postCompactScriptPath,
    openClawLifecycleScript(context),
  ].every(asset => path.isAbsolute(asset) && fs.existsSync(asset))
}

function openClawLifecycleScript(context: AdapterOperationContext): string {
  return path.join(path.dirname(context.runtime.hookScriptPath), 'hook-openclaw-lifecycle.cjs')
}

function executableExists(context: AdapterOperationContext): boolean {
  const executable = context.installation.distribution.executableRealpath
  return Boolean(executable && path.isAbsolute(executable) && fs.existsSync(executable))
}

function packageVersion(context: AdapterOperationContext): string {
  const base = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(context.runtime.tideMindVersion)
    ? context.runtime.tideMindVersion
    : '0.0.0'
  return `${base}+${sha256Bytes(JSON.stringify([context.agentId, context.runtime.projectionVersion, context.hostVersion])).slice(0, 10)}`
}

function pluginPhysicalTarget(desired: DesiredPlugin): string {
  return `openclaw:user:${desired.pluginId}`
}

function expectedHostHash(pluginId: string, pluginRoot: string, pluginVersion: string): string {
  return sha256Json({
    pluginId,
    pluginRoot: path.resolve(pluginRoot),
    pluginVersion,
    enabled: true,
    tools: [...TOOLS].sort(),
    hooks: [...HOOKS].sort(),
  })
}

function disabledHostHash(pluginId: string, pluginRoot: string, pluginVersion: string): string {
  return sha256Json({ id: pluginId, root: path.resolve(pluginRoot), version: pluginVersion, enabled: false })
}

function hooksPendingHostHash(desired: DesiredPlugin): string {
  return sha256Json({ pluginId: desired.pluginId, root: desired.pluginRoot, version: desired.pluginVersion, promptHooksPending: true })
}

function bundleFingerprint(files: Readonly<Record<string, string>>): string {
  return sha256Json(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, content]) => ({ relativePath, hash: sha256Bytes(content) })))
}

function aggregateFingerprint(bundleHash: string | null, pluginHash: string | null): string {
  return sha256Json({ pluginBundle: bundleHash, pluginRegistration: pluginHash })
}

function absentAggregateHash(): string {
  return aggregateFingerprint(null, null)
}

function migrationClearedFingerprint(): string {
  return sha256Json({ legacyMcp: null, nativePlugin: null, migration: 'in_progress' })
}

function matchesDirection(aggregate: AggregateInspection, direction: OpenClawMutationMetadata['direction']): boolean {
  return direction === 'install' ? aggregate.exact : aggregate.absent
}

function findSafeResume(mutation: PlannedMutation, fingerprint: string): FrozenIntermediateState | undefined {
  return mutation.safeResumeStates?.find(state => state.fingerprint === fingerprint)
}

function ownedBaselines(artifacts: readonly OwnedArtifactBaseline[], physicalTarget: string): OwnedArtifactBaseline[] {
  return artifacts.filter(artifact => artifact.physicalTarget === physicalTarget && COMPONENTS.includes(artifact.componentKey))
}

function legacyLooseBaselines(
  artifacts: readonly OwnedArtifactBaseline[],
  desired: DesiredPlugin,
  context: AdapterOperationContext,
): OwnedArtifactBaseline[] {
  return artifacts.filter(artifact => artifact.componentKey === 'memory_tools'
    && path.resolve(artifact.physicalTarget) === path.resolve(desired.configPath)
    && artifact.ownershipKey === `mcp.servers.tidemind-${context.agentId}`)
}

function inspectLegacyTransfer(
  context: AdapterOperationContext,
  desired: DesiredPlugin,
  baseline: OwnedArtifactBaseline,
): { ok: true; metadata: NonNullable<OpenClawMutationMetadata['legacyTransfer']> } | { ok: false; diagnostic: string } {
  if (!/^[a-f0-9]{64}$/u.test(baseline.ownedFragmentHash)) {
    return { ok: false, diagnostic: 'openclaw_legacy_mcp_ownership_hash_invalid' }
  }
  const selector = baseline.ownershipKey.split('.')
  if (selector.length !== 3 || selector[0] !== 'mcp' || selector[1] !== 'servers') {
    return { ok: false, diagnostic: 'openclaw_legacy_mcp_selector_unrecognized' }
  }
  try {
    const inspected = inspectJsonProjection(baseline.physicalTarget, selector, context.installation.canonicalConfigRoot)
    if (!inspected.fragmentExists || inspected.fragmentHash !== baseline.ownedFragmentHash || !inspected.file.containerHash) {
      return { ok: false, diagnostic: 'openclaw_legacy_mcp_owned_fragment_changed' }
    }
    return {
      ok: true,
      metadata: {
        physicalTarget: baseline.physicalTarget,
        ownershipKey: baseline.ownershipKey,
        selector,
        fragmentHash: baseline.ownedFragmentHash,
        containerPreconditionHash: inspected.file.containerHash,
        canonicalPath: inspected.file.canonicalPath,
      },
    }
  } catch {
    return { ok: false, diagnostic: 'openclaw_legacy_mcp_container_unreadable' }
  }
}

function inspectLegacyMcp(
  context: AdapterOperationContext,
  transfer: NonNullable<OpenClawMutationMetadata['legacyTransfer']>,
): JsonProjectionInspection {
  return inspectJsonProjection(transfer.physicalTarget, transfer.selector, context.installation.canonicalConfigRoot)
}

function removeLegacyMcp(context: AdapterOperationContext, metadata: OpenClawMutationMetadata): void {
  const transfer = metadata.legacyTransfer
  if (!transfer) return
  const current = inspectLegacyMcp(context, transfer)
  if (!current.fragmentExists) return
  if (current.file.canonicalPath !== transfer.canonicalPath
    || current.file.containerHash !== transfer.containerPreconditionHash
    || current.fragmentHash !== transfer.fragmentHash) {
    throw new Error('openclaw_legacy_mcp_transfer_cas_conflict')
  }
  applyJsonProjection({
    targetPath: transfer.physicalTarget,
    canonicalPath: transfer.canonicalPath,
    selector: transfer.selector,
    action: 'remove',
    containerPreconditionHash: transfer.containerPreconditionHash,
    liveFragmentHash: transfer.fragmentHash,
    ownedFragmentHash: transfer.fragmentHash,
    desiredFragment: undefined,
    desiredFragmentHash: null,
    conflictReason: null,
  }, context.installation.canonicalConfigRoot)
}

function consistentAggregateBaseline(baselines: readonly OwnedArtifactBaseline[]): OwnedArtifactBaseline | undefined {
  if (baselines.length !== COMPONENTS.length) return undefined
  const first = baselines[0]
  return COMPONENTS.every(component => baselines.some(item => item.componentKey === component
    && item.physicalTarget === first.physicalTarget
    && item.ownershipKey === first.ownershipKey
    && item.ownedFragmentHash === first.ownedFragmentHash
    && (item.selectorSchemaVersion ?? SELECTOR_SCHEMA_VERSION) === (first.selectorSchemaVersion ?? SELECTOR_SCHEMA_VERSION)))
    ? first
    : undefined
}

function listBundleEntries(root: string): string[] {
  const files: string[] = []
  const queue = ['']
  let count = 0
  while (queue.length > 0) {
    const relativeRoot = queue.shift()!
    for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
      if (++count > MAX_BUNDLE_ENTRIES) throw new Error('openclaw_plugin_too_many_entries')
      const relative = path.join(relativeRoot, entry.name)
      if (entry.isSymbolicLink()) throw new Error('openclaw_plugin_symlink_rejected')
      if (entry.isDirectory()) queue.push(relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error('openclaw_plugin_non_regular_entry')
    }
  }
  return files.sort()
}

function removeEmptyDirectories(root: string): void {
  const directories: string[] = []
  const queue = ['']
  while (queue.length > 0) {
    const relativeRoot = queue.shift()!
    for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const relative = path.join(relativeRoot, entry.name)
        directories.push(relative)
        queue.push(relative)
      }
    }
  }
  for (const relative of directories.sort((a, b) => b.length - a.length)) fs.rmdirSync(path.join(root, relative))
  fs.rmdirSync(root)
}

function hashExistingFile(root: string, relative: string): string {
  const target = path.join(root, relative)
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BUNDLE_FILE_BYTES) return 'unsafe'
  return sha256Bytes(fs.readFileSync(target))
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(value) } } catch { return { ok: false } }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : isRecord(item) ? firstString(item.name, item.id) : null).filter((item): item is string => Boolean(item))
  if (isRecord(value)) return Object.keys(value)
  return []
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return sha256Json([...left].sort()) === sha256Json([...right].sort())
}

function conflictPlugin(diagnostic: string, value?: unknown): PluginInspection {
  return { state: 'conflict', fingerprint: value === undefined ? null : sha256Json(value as JsonValue), diagnostics: [diagnostic] }
}

function unknownPlugin(diagnostic: string): PluginInspection {
  return { state: 'unknown', fingerprint: null, diagnostics: [diagnostic] }
}

function unknownAggregate(diagnostic: string): AggregateInspection {
  return {
    bundle: { state: 'other', fingerprint: null, fileHashes: {}, entries: [], diagnostics: [diagnostic] },
    plugin: unknownPlugin(diagnostic),
    fingerprint: absentAggregateHash(),
    exact: false,
    absent: false,
    diagnostics: [diagnostic],
  }
}

function unknownReadBack(mutation: PlannedMutation, diagnostic: string): MutationReadBack {
  return { operationId: mutation.operationId, observed: false, matchesDesired: false, visibility: 'unknown', diagnostics: [diagnostic] }
}

function unverifiedStatic(
  componentKey: ComponentKey,
  fingerprint: string,
  diagnostics: readonly string[],
): ComponentVerificationResult {
  return {
    componentKey,
    status: 'unverified',
    verifiedCapability: null,
    evidenceHash: fingerprint,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version', 'tide_mind_version', 'activity_freshness'],
    diagnostics: diagnostics.length > 0 ? [...diagnostics] : ['fresh_host_activity_evidence_missing'],
  }
}

function jsonDocument(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function safeKebab(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!safe) throw new Error('openclaw_plugin_identity_invalid')
  return safe.slice(0, 80)
}

function assertContained(target: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('openclaw_plugin_target_outside_managed_root')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isNullableStringRecord(value: unknown): value is Readonly<Record<string, string | null>> {
  return isRecord(value) && Object.values(value).every(item => item === null || typeof item === 'string')
}

function boundedDiagnostic(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 512)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
