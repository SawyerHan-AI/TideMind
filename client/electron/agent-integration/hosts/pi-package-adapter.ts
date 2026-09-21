import { execFile } from 'node:child_process'
import { nativeBrainToolContracts } from './native-tool-contracts'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyHostActivity, verifyMemoryReadWriteActivity } from '../host-activity-evidence'
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
  AgentHostAdapter,
  ComponentKey,
  ComponentVerificationResult,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

export interface PiCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface PiPackageAdapterDependencies {
  run(
    executableRealpath: string,
    args: readonly string[],
    options: { timeoutMs: number; env: Readonly<Record<string, string>>; cwd: string },
  ): Promise<PiCommandResult>
}

export interface PiPackageHostSpec {
  adapterVersion: string
  dependencies?: PiPackageAdapterDependencies
}

interface DesiredPackage {
  homeDir: string
  packageRoot: string
  settingsPath: string
  registrationSource: string
  packageName: string
  files: Readonly<Record<string, string>>
  bundleHash: string
  registrationHash: string
  aggregateHash: string
}

interface BundleInspection {
  state: 'absent' | 'exact' | 'other'
  fingerprint: string | null
  fileHashes: Readonly<Record<string, string | null>>
  diagnostics: readonly string[]
}

interface RegistrationInspection {
  state: 'absent' | 'exact' | 'conflict' | 'unknown'
  containerHash: string | null
  canonicalPath: string
  selectorHash: string | null
  remainderHash: string | null
  diagnostics: readonly string[]
}

interface AggregateInspection {
  bundle: BundleInspection
  registration: RegistrationInspection
  aggregateHash: string
  exact: boolean
  absent: boolean
  diagnostics: readonly string[]
}

interface PiMutationMetadata {
  kind: 'pi_package_aggregate'
  artifactType: 'plugin'
  reversible: true
  canonicalPath: string
  packageRoot: string
  settingsPath: string
  registrationSource: string
  packageName: string
  desiredFiles: Readonly<Record<string, string>>
  beforeFileHashes: Readonly<Record<string, string | null>>
  beforeBundleFingerprint: string | null
  beforeRegistrationSelectorHash: string | null
  settingsContainerPreconditionHash: string | null
  settingsRemainderPreconditionHash: string | null
  aggregatePreconditionHash: string
  remove: boolean
}

const execFileAsync = promisify(execFile)
const COMPONENTS = ['instruction', 'memory_tools', 'lifecycle'] as const satisfies readonly ComponentKey[]
export const PI_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start',
  'pre_compact',
  'post_compact',
  'session_end',
] as const)
// The maintained first-party runtime was renamed to Earendil and its current
// Extension API imports from @earendil-works/* plus `typebox`. The historical
// Mario package is still discoverable, but is not binary/API-equivalent and
// must remain observe-only until it has a separately versioned Adapter.
const OFFICIAL_PROVENANCE = 'npm_metadata:@earendil-works/pi-coding-agent'
const SELECTOR_SCHEMA_VERSION = 1
const COMMAND_TIMEOUT_MS = 30_000
const MAX_PACKAGE_ENTRIES = 64
const MAX_PACKAGE_FILE_BYTES = 1024 * 1024

/**
 * Pi local package identity is its resolved absolute source path, while the
 * persisted user-settings selector is normalized relative to the Pi agent
 * directory; `pi install` does not copy it. Tide Mind therefore owns a stable
 * package directory under applicationDataDir and treats that directory plus
 * Pi's settings selector as one journaled aggregate effect.
 */
export function createPiPackageHostAdapter(spec: PiPackageHostSpec): AgentHostAdapter {
  const dependencies = spec.dependencies ?? productionDependencies()

  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const desired = desiredPackage(context, spec.adapterVersion)
    const diagnostics: string[] = []
    let aggregate: AggregateInspection
    try {
      aggregate = inspectAggregate(context, desired)
      diagnostics.push(...aggregate.diagnostics)
    } catch (error) {
      aggregate = unknownAggregate(desired, errorMessage(error))
      diagnostics.push(errorMessage(error))
    }
    const manageable = manageableDistribution(context)
    if (!manageable.ok) diagnostics.push(manageable.reason)
    if (!runtimeAssetsPresent(context)) diagnostics.push('pi_package_runtime_assets_missing')
    const visibility = aggregate.exact ? 'dedicated' : aggregate.absent ? 'absent' : 'unknown'
    return {
      catalogId: 'pi-official-cli',
      detected: executableExists(context),
      distribution: { ...context.installation.distribution },
      components: COMPONENTS.map(componentKey => ({
        componentKey,
        visibility,
        verificationStatus: 'unverified',
        observedTarget: desired.packageRoot,
        observedFragmentHash: aggregate.aggregateHash,
        details: {
          implementation: 'pi_package',
          packageName: desired.packageName,
          packageSource: desired.packageRoot,
        },
      })),
      provenance: [desired.packageRoot, desired.settingsPath],
      diagnostics,
    }
  }

  const buildPlan = async (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    remove: boolean,
  ): Promise<AdapterPlan> => {
    const desired = desiredPackage(context, spec.adapterVersion)
    const diagnostics: string[] = []
    const mutations: PlannedMutation[] = []
    const manageable = manageableDistribution(context)
    if (!request.observed.detected) diagnostics.push('pi_host_not_detected')
    else if (!manageable.ok) diagnostics.push(manageable.reason)
    else if (!runtimeAssetsPresent(context)) diagnostics.push('pi_package_runtime_assets_missing')
    else {
      const current = inspectAggregate(context, desired)
      const baselines = ownedBaselines(request.ownedArtifacts, desired.packageRoot)
      const baseline = consistentAggregateBaseline(baselines)
      if (baselines.length > 0 && !baseline) {
        diagnostics.push('pi_package_aggregate_ownership_inconsistent')
      } else if (remove) {
        if (current.absent) {
          // Already disconnected; verification will persist the C0 outcome.
        } else if (!baseline) {
          diagnostics.push('pi_package_disconnect_requires_ownership')
        } else if (baseline.ownedFragmentHash !== current.aggregateHash) {
          diagnostics.push('pi_package_disconnect_ownership_baseline_mismatch')
        } else {
          mutations.push(packageMutation(context, desired, current, baseline, true))
        }
      } else if (current.exact) {
        // Exact pre-existing state without Ledger ownership is intentionally
        // not adopted as three components. The adoption schema is single-
        // component and cannot safely express this aggregate package.
        if (!baseline) diagnostics.push('pi_package_exact_state_requires_aggregate_ownership')
      } else if (current.registration.state === 'conflict' || current.registration.state === 'unknown') {
        diagnostics.push(...current.registration.diagnostics)
      } else if (current.bundle.state === 'other' && !baseline) {
        diagnostics.push('pi_package_source_exists_without_ownership')
      } else if (baseline && baseline.ownedFragmentHash !== current.aggregateHash) {
        diagnostics.push('pi_package_ownership_baseline_mismatch')
      } else if (current.registration.state === 'exact' && !baseline) {
        diagnostics.push('pi_package_registration_exists_without_ownership')
      } else {
        mutations.push(packageMutation(context, desired, current, baseline, false))
      }
    }
    return {
      catalogId: 'pi-official-cli',
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations,
      requiredUserActions: [],
      diagnostics,
    }
  }

  return {
    catalogId: 'pi-official-cli',
    adapterVersion: spec.adapterVersion,
    componentKeys: COMPONENTS,
    implementationTypes: {
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin'],
    },
    componentContracts: {
      instruction: { deliveryMode: 'managed', artifactTypes: ['plugin', 'skill'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      memory_tools: { deliveryMode: 'managed', artifactTypes: ['plugin'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['plugin'], mutationDomain: 'plugin_manager', reload: 'new_session' },
    },
    inspect,
    // Aggregate package adoption is deliberately unavailable until adoption
    // observations can bind all covered components in one atomic ledger row.
    inspectAdoptableArtifacts: async () => [],
    plan: (context, request) => buildPlan(context, request, false),
    disconnect: (context, request) => buildPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, true),
    async apply(context, mutation) {
      assertMutation(context, mutation)
      const metadata = parseMetadata(mutation)
      const desired = desiredFromMetadata(context, mutation, metadata)
      const before = await inspectAggregateWithList(context, mutation, desired, dependencies)
      if (before.matchesDesired) {
        return {
          operationId: mutation.operationId,
          effectObserved: false,
          postEffectFingerprint: before.observedFragmentHash,
          hostReceipt: {
            idempotentNoop: true,
            packageSource: desired.packageRoot,
          } as Readonly<Record<string, JsonValue>>,
        }
      }
      const safeResume = before.safeToResumeFrom
      if ((before.visibility === 'unknown' || before.diagnostics.length > 0) && !safeResume) {
        throw new Error(before.diagnostics.join(';') || 'pi_package_precondition_unknown')
      }
      const live = inspectAggregate(context, desired)
      if (live.aggregateHash !== metadata.aggregatePreconditionHash
        && live.aggregateHash !== safeResume?.fingerprint) {
        throw new Error('pi_package_aggregate_precondition_changed')
      }
      if (!safeResume || !metadata.remove) assertSettingsPrecondition(live.registration, metadata)

      if (metadata.remove) {
        if (!safeResume) {
          const result = await runPi(context, mutation, dependencies)
          if (result.exitCode !== 0) {
            throw new Error(`pi_package_remove_failed:${result.exitCode}:${boundedDiagnostic(result.stderr || result.stdout)}`)
          }
        }
        assertSettingsRemainderPreserved(context, desired, metadata)
        removeExactPackageBundle(context, desired, metadata)
      } else {
        applyPackageBundle(context, desired, metadata)
        const result = await runPi(context, mutation, dependencies)
        if (result.exitCode !== 0) {
          throw new Error(`pi_package_install_failed:${result.exitCode}:${boundedDiagnostic(result.stderr || result.stdout)}`)
        }
        assertSettingsRemainderPreserved(context, desired, metadata)
      }

      const after = await inspectAggregateWithList(context, mutation, desired, dependencies)
      if (!after.matchesDesired) {
        throw new Error(after.diagnostics.join(';') || 'pi_package_readback_mismatch')
      }
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.observedFragmentHash,
        hostReceipt: {
          packageSource: desired.packageRoot,
          settingsPath: desired.settingsPath,
          piListConfirmed: true,
        } as Readonly<Record<string, JsonValue>>,
      }
    },
    readBack: (context, mutation) => {
      const metadata = parseMetadata(mutation)
      return inspectAggregateWithList(context, mutation, desiredFromMetadata(context, mutation, metadata), dependencies)
    },
    verify: (context, request) => verifyPiPackage(
      context,
      request,
      desiredPackage(context, spec.adapterVersion),
      dependencies,
    ),
  }
}

function productionDependencies(): PiPackageAdapterDependencies {
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

function manageableDistribution(context: AdapterOperationContext): { ok: true } | { ok: false; reason: string } {
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable)) return { ok: false, reason: 'pi_executable_realpath_unproven' }
  if (!context.hostVersion?.trim()) return { ok: false, reason: 'pi_host_version_unproven' }
  if (context.installation.distribution.packageProvenance !== OFFICIAL_PROVENANCE) {
    return { ok: false, reason: 'pi_official_distribution_identity_unproven' }
  }
  return { ok: true }
}

function executableExists(context: AdapterOperationContext): boolean {
  const executable = context.installation.distribution.executableRealpath
  return Boolean(executable && path.isAbsolute(executable) && fs.existsSync(executable))
}

function runtimeAssetsPresent(context: AdapterOperationContext): boolean {
  return [
    context.runtime.shimPath,
    context.runtime.mcpServerPath,
    context.runtime.hookScriptPath,
    context.runtime.preCompactScriptPath,
    context.runtime.postCompactScriptPath,
    piLifecycleScript(context),
  ].every(asset => path.isAbsolute(asset) && fs.existsSync(asset))
}

function piLifecycleScript(context: AdapterOperationContext): string {
  return path.join(path.dirname(context.runtime.hookScriptPath), 'hook-pi-lifecycle.cjs')
}

function desiredPackage(context: AdapterOperationContext, adapterVersion: string): DesiredPackage {
  const packageName = `@tidemind/pi-${safeSegment(context.agentId)}`
  const packageRoot = path.join(
    context.runtime.applicationDataDir,
    'agent-integration',
    'pi-packages',
    safeSegment(context.agentId),
  )
  const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
  const registrationSource = path.relative(context.installation.canonicalConfigRoot, packageRoot) || '.'
  const skillPath = path.join(packageRoot, 'skills', 'tidemind', 'SKILL.md')
  const files: Readonly<Record<string, string>> = Object.freeze({
    'package.json': jsonDocument({
      name: packageName,
      version: packageVersion(context, adapterVersion),
      private: true,
      description: 'Tide Mind external memory package for Pi',
      keywords: ['pi-package'],
      peerDependencies: {
        '@earendil-works/pi-coding-agent': '*',
        typebox: '*',
      },
      pi: {
        extensions: ['./extensions/tidemind.ts'],
        skills: ['./skills/tidemind'],
      },
      tidemind: {
        agentId: context.agentId,
        hostVariant: context.installation.hostVariant,
        hostVersion: context.hostVersion ?? null,
        tideMindVersion: context.runtime.tideMindVersion,
        adapterVersion,
        projectionVersion: context.runtime.projectionVersion,
      },
    }),
    'skills/tidemind/SKILL.md': renderSkill(context),
    'extensions/tidemind.ts': renderExtension(context, skillPath, adapterVersion),
  })
  const bundleHash = bundleFingerprint(files)
  const registrationHash = desiredRegistrationHash(packageRoot, registrationSource)
  return {
    homeDir: context.runtime.homeDir,
    packageRoot,
    settingsPath,
    registrationSource,
    packageName,
    files,
    bundleHash,
    registrationHash,
    aggregateHash: aggregateFingerprint(bundleHash, registrationHash),
  }
}

function packageVersion(context: AdapterOperationContext, adapterVersion: string): string {
  const base = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(context.runtime.tideMindVersion)
    ? context.runtime.tideMindVersion
    : '0.0.0'
  const identity = sha256Bytes(JSON.stringify([
    context.agentId,
    adapterVersion,
    context.runtime.projectionVersion,
    context.installation.hostVariant,
    context.hostVersion ?? 'unproven',
  ])).slice(0, 10)
  return `${base}+${identity}`
}

function renderSkill(context: AdapterOperationContext): string {
  return `---
name: tidemind
description: Tide Mind 外部记忆系统。准备上下文、检索历史并沉淀长期有价值的信息。
---

# Tide Mind

此 Package 绑定 Tide Mind 身份 \`${context.agentId}\`，并提供原生工具
\`brain_prepare\`、\`brain_recall\`、\`brain_digest\`。

- 新会话开始时优先调用 \`brain_prepare\` 获取用户上下文。
- 回答依赖历史背景、既往决策或用户偏好时调用 \`brain_recall\`。
- 对话产生重要决策、事实、偏好、纠正或后续行动时调用 \`brain_digest\`。
- 工具不可用时明确说明，不能假装已经查询或保存。
`
}

function renderExtension(context: AdapterOperationContext, skillPath: string, adapterVersion: string): string {
  const binding = JSON.stringify({
    agentId: context.agentId,
    activityGenerationToken: context.activityGenerationToken ?? '',
    hostVariant: context.installation.hostVariant,
    hostVersion: context.hostVersion ?? null,
    adapterVersion,
    shimPath: context.runtime.shimPath,
    mcpServerPath: context.runtime.mcpServerPath,
    sessionStartScript: context.runtime.hookScriptPath,
    preCompactScript: context.runtime.preCompactScriptPath,
    postCompactScript: context.runtime.postCompactScriptPath,
    lifecycleScript: piLifecycleScript(context),
    skillPath,
    expectedSkillSha256: sha256Bytes(renderSkill(context)),
  })
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const BINDING = ${binding} as const;
const TOOL_CONTRACTS = ${JSON.stringify(nativeBrainToolContracts())} as const;
const TIMEOUT_MS = 60_000;

type CommandResult = { code: number; stdout: string; stderr: string };

function run(command: string, args: string[], input = ""): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, EB_AGENT_ID: BINDING.agentId, EB_HOST_VARIANT: BINDING.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: BINDING.activityGenerationToken },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Tide Mind command timed out")); }, TIMEOUT_MS);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(input);
  });
}

async function callMcp(tool: string, args: unknown, signal?: AbortSignal): Promise<any> {
  return await new Promise((resolve, reject) => {
    const child = spawn(BINDING.shimPath, [BINDING.mcpServerPath], {
      env: { ...process.env, EB_AGENT_ID: BINDING.agentId, EB_HOST_VARIANT: BINDING.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: BINDING.activityGenerationToken },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, (value: any) => void>();
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      error ? reject(error) : resolve(value);
    };
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\\n");
    const request = (method: string, params: unknown) => new Promise<any>(done => {
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
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.id === "number" && pending.has(message.id)) {
          const done = pending.get(message.id)!;
          pending.delete(message.id);
          done(message);
        } else if (typeof message.id === "number" && typeof message.method === "string") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client request unsupported" } });
        }
      }
    });
    const timer = setTimeout(() => finish(new Error("Tide Mind MCP timed out: " + stderr)), TIMEOUT_MS);
    void (async () => {
      const initialized = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tidemind-pi-package", version: "1" },
      });
      if (initialized.error) throw new Error(initialized.error.message ?? "MCP initialize failed");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const response = await request("tools/call", { name: tool, arguments: args });
      if (response.error) throw new Error(response.error.message ?? "MCP tool failed");
      finish(undefined, response.result);
    })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function result(value: any) {
  return {
    content: Array.isArray(value?.content) ? value.content : [{ type: "text", text: JSON.stringify(value ?? null) }],
    details: { tideMind: true, agentId: BINDING.agentId },
    isError: value?.isError === true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "brain_prepare",
    label: "Tide Mind: Prepare",
    description: TOOL_CONTRACTS.brain_prepare.description,
    parameters: TOOL_CONTRACTS.brain_prepare.parameters,
    async execute(_id, params, signal) { return result(await callMcp("brain_prepare", params, signal)); },
  });
  pi.registerTool({
    name: "brain_recall",
    label: "Tide Mind: Recall",
    description: TOOL_CONTRACTS.brain_recall.description,
    parameters: TOOL_CONTRACTS.brain_recall.parameters,
    async execute(_id, params, signal) { return result(await callMcp("brain_recall", params, signal)); },
  });
  pi.registerTool({
    name: "brain_digest",
    label: "Tide Mind: Digest",
    description: TOOL_CONTRACTS.brain_digest.description,
    parameters: TOOL_CONTRACTS.brain_digest.parameters,
    async execute(_id, params, signal) { return result(await callMcp("brain_digest", params, signal)); },
  });

  pi.on("session_start", async () => {
    try {
      const response = await run(BINDING.shimPath, [BINDING.sessionStartScript, "--agent-id", BINDING.agentId, "--skill-path", BINDING.skillPath, "--tool", "pi", "--activity-generation-token", BINDING.activityGenerationToken, "--expected-skill-sha256", BINDING.expectedSkillSha256]);
      if (response.code === 0 && response.stdout.trim()) {
        pi.sendMessage({ customType: "tidemind-context", content: response.stdout.trim(), display: false }, { deliverAs: "nextTurn", triggerTurn: false });
      }
    } catch { /* Tide Mind failure must not block the Pi session. */ }
  });
  pi.on("session_before_compact", async () => {
    try { await run(BINDING.shimPath, [BINDING.preCompactScript, "--agent-id", BINDING.agentId, "--tool", "pi", "--activity-generation-token", BINDING.activityGenerationToken]); } catch { /* best effort */ }
  });
  pi.on("session_compact", async (event) => {
    try {
      const response = await run(BINDING.shimPath, [BINDING.postCompactScript, "--agent-id", BINDING.agentId, "--tool", "pi", "--activity-generation-token", BINDING.activityGenerationToken]);
      if (response.code === 0 && response.stdout.trim()) {
        const delivery = event.willRetry
          ? { deliverAs: "steer" as const, triggerTurn: true }
          : { deliverAs: "nextTurn" as const, triggerTurn: false };
        pi.sendMessage({ customType: "tidemind-context", content: response.stdout.trim(), display: false }, delivery);
      }
    } catch { /* best effort */ }
  });
  pi.on("session_shutdown", async () => {
    try { await run(BINDING.shimPath, [BINDING.lifecycleScript, "--agent-id", BINDING.agentId, "--signal", "session_end", "--activity-generation-token", BINDING.activityGenerationToken]); } catch { /* best effort */ }
  });
}
`
}

function inspectAggregate(context: AdapterOperationContext, desired: DesiredPackage): AggregateInspection {
  const bundle = inspectPackageBundle(desired, context.runtime.applicationDataDir)
  const registration = inspectRegistration(desired, context.installation.canonicalConfigRoot)
  const diagnostics = [...bundle.diagnostics, ...registration.diagnostics]
  return {
    bundle,
    registration,
    aggregateHash: aggregateFingerprint(bundle.fingerprint, registration.selectorHash),
    exact: bundle.state === 'exact' && registration.state === 'exact',
    absent: bundle.state === 'absent' && registration.state === 'absent',
    diagnostics,
  }
}

function inspectPackageBundle(desired: DesiredPackage, allowedRoot: string): BundleInspection {
  assertContained(desired.packageRoot, allowedRoot)
  if (!fs.existsSync(desired.packageRoot)) {
    return {
      state: 'absent',
      fingerprint: null,
      fileHashes: Object.fromEntries(Object.keys(desired.files).map(relative => [relative, null])),
      diagnostics: [],
    }
  }
  const rootStat = fs.lstatSync(desired.packageRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('pi_package_root_not_safe_directory')
  const actual = listPackageEntries(desired.packageRoot)
  const expected = Object.keys(desired.files).sort()
  const diagnostics: string[] = []
  if (actual.directories.some(directory => !expected.some(file => file.startsWith(`${directory}/`)))) {
    diagnostics.push('pi_package_contains_unexpected_directory')
  }
  if (actual.files.some(file => !Object.hasOwn(desired.files, file))) diagnostics.push('pi_package_contains_unexpected_file')
  const fileHashes: Record<string, string | null> = {}
  for (const relative of expected) {
    const inspected = inspectRegularFileWithinRoot(path.join(desired.packageRoot, relative), allowedRoot)
    if (inspected.size !== null && inspected.size > MAX_PACKAGE_FILE_BYTES) diagnostics.push('pi_package_file_too_large')
    fileHashes[relative] = inspected.containerHash
  }
  const fingerprint = sha256Json({
    files: actual.files.map(relativePath => ({ relativePath, hash: fileHashes[relativePath] ?? 'unexpected' })),
    directories: actual.directories,
  })
  const exact = diagnostics.length === 0
    && expected.length === actual.files.length
    && expected.every(relative => fileHashes[relative] === sha256Bytes(desired.files[relative]))
  return { state: exact ? 'exact' : 'other', fingerprint: exact ? desired.bundleHash : fingerprint, fileHashes, diagnostics }
}

function inspectRegistration(desired: DesiredPackage, allowedRoot: string): RegistrationInspection {
  const file = inspectRegularFileWithinRoot(desired.settingsPath, allowedRoot)
  if (!file.exists) {
    return {
      state: 'absent', containerHash: null, canonicalPath: file.canonicalPath,
      selectorHash: null, remainderHash: settingsRemainderHash({}, desired), diagnostics: [],
    }
  }
  let document: unknown
  try {
    document = JSON.parse(fs.readFileSync(file.canonicalPath, 'utf8'))
  } catch {
    return unknownRegistration(file.canonicalPath, file.containerHash, 'pi_settings_json_invalid')
  }
  if (!isRecord(document)) return unknownRegistration(file.canonicalPath, file.containerHash, 'pi_settings_root_invalid')
  const packages = document.packages
  if (packages !== undefined && !Array.isArray(packages)) {
    return unknownRegistration(file.canonicalPath, file.containerHash, 'pi_settings_packages_invalid')
  }
  const matches = (packages ?? []).filter(entry => {
    const source = packageSource(entry)
    return source !== null
      && resolveConfiguredSource(source, desired.homeDir, desired.settingsPath) === path.resolve(desired.packageRoot)
  })
  const remainderHash = settingsRemainderHash(document, desired)
  if (matches.length === 0) {
    return {
      state: 'absent', containerHash: file.containerHash, canonicalPath: file.canonicalPath,
      selectorHash: null, remainderHash, diagnostics: [],
    }
  }
  if (matches.length !== 1 || typeof matches[0] !== 'string' || matches[0] !== desired.registrationSource) {
    return {
      state: 'conflict', containerHash: file.containerHash, canonicalPath: file.canonicalPath,
      selectorHash: sha256Json(matches as JsonValue), remainderHash, diagnostics: ['pi_package_registration_selector_conflict'],
    }
  }
  return {
    state: 'exact', containerHash: file.containerHash, canonicalPath: file.canonicalPath,
    selectorHash: desired.registrationHash, remainderHash, diagnostics: [],
  }
}

function settingsRemainderHash(
  document: Record<string, unknown>,
  desired: Pick<DesiredPackage, 'homeDir' | 'packageRoot' | 'settingsPath'>,
): string {
  const clone: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(document)) {
    if (key !== 'packages') clone[key] = value as JsonValue
  }
  if (Array.isArray(document.packages)) {
    const remaining = document.packages.filter(entry => {
      const source = packageSource(entry)
      return source === null
        || resolveConfiguredSource(source, desired.homeDir, desired.settingsPath)
          !== path.resolve(desired.packageRoot)
    }) as JsonValue[]
    // Pi materializes `packages: []` while adding/removing the only package.
    // Treat the empty array like an omitted optional field so that the
    // selector-only command is not misclassified as unrelated user drift.
    if (remaining.length > 0) clone.packages = remaining
  }
  return sha256Json(clone)
}

function packageSource(value: unknown): string | null {
  if (typeof value === 'string' && isLocalPath(value)) return value
  if (isRecord(value) && typeof value.source === 'string' && isLocalPath(value.source)) return value.source
  return null
}

function isLocalPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~')
}

function resolveConfiguredSource(source: string, homeDir: string, settingsPath: string): string {
  if (source === '~') return path.resolve(homeDir)
  if (source.startsWith(`~${path.sep}`)) return path.resolve(homeDir, source.slice(2))
  return path.resolve(path.isAbsolute(source) ? source : path.join(path.dirname(settingsPath), source))
}

function packageMutation(
  context: AdapterOperationContext,
  desired: DesiredPackage,
  current: AggregateInspection,
  baseline: OwnedArtifactBaseline | undefined,
  remove: boolean,
): PlannedMutation {
  const metadata: PiMutationMetadata = {
    kind: 'pi_package_aggregate',
    artifactType: 'plugin',
    reversible: true,
    canonicalPath: desired.packageRoot,
    packageRoot: desired.packageRoot,
    settingsPath: desired.settingsPath,
    registrationSource: desired.registrationSource,
    packageName: desired.packageName,
    desiredFiles: desired.files,
    beforeFileHashes: current.bundle.fileHashes,
    beforeBundleFingerprint: current.bundle.fingerprint,
    beforeRegistrationSelectorHash: current.registration.selectorHash,
    settingsContainerPreconditionHash: current.registration.containerHash,
    settingsRemainderPreconditionHash: current.registration.remainderHash,
    aggregatePreconditionHash: current.aggregateHash,
    remove,
  }
  return {
    operationId: `${context.operationId}:pi-package:${remove ? 'remove' : 'install'}`,
    componentKey: 'instruction',
    coveredComponentKeys: COMPONENTS,
    operation: 'host_command',
    domainKind: 'plugin_manager',
    physicalTarget: desired.packageRoot,
    ownershipKey: desired.packageRoot,
    selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
    additionalFenceTargets: [{ domainKind: 'file_fragment', physicalTarget: desired.settingsPath }],
    risk: 'elevated',
    reload: 'new_session',
    commandCategory: 'plugin_install',
    executableRealpath: context.installation.distribution.executableRealpath,
    args: [remove ? 'remove' : 'install', desired.packageRoot, '--no-approve'],
    preconditionHash: baseline?.ownedFragmentHash,
    desiredFragmentHash: remove ? absentAggregateHash() : desired.aggregateHash,
    safeResumeStates: [{
      fingerprint: aggregateFingerprint(desired.bundleHash, null),
      completedStepIds: [remove ? 'pi_registration_removed' : 'pi_package_written'],
    }],
    idempotent: true,
    metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
  }
}

function applyPackageBundle(context: AdapterOperationContext, desired: DesiredPackage, metadata: PiMutationMetadata): void {
  const current = inspectPackageBundle(desired, context.runtime.applicationDataDir)
  if (current.state === 'exact') return
  if (!repairableBundleState(current, metadata, desired.files)) throw new Error('pi_package_bundle_cas_conflict')
  for (const [relative, content] of Object.entries(desired.files).sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(desired.packageRoot, relative)
    const observed = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    const desiredHash = sha256Bytes(content)
    if (observed.containerHash === desiredHash) continue
    const beforeHash = metadata.beforeFileHashes[relative] ?? null
    if (observed.containerHash !== beforeHash) throw new Error('pi_package_file_cas_conflict')
    ensureSafeParentDirectoryWithinRoot(target, context.runtime.applicationDataDir)
    writeRegularFileAtomicCas(target, content, {
      expectedContainerHash: beforeHash,
      expectedCanonicalPath: inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir).canonicalPath,
      createMode: 0o600,
    })
  }
  const after = inspectPackageBundle(desired, context.runtime.applicationDataDir)
  if (after.state !== 'exact' || after.fingerprint !== desired.bundleHash) throw new Error('pi_package_bundle_readback_mismatch')
}

function removeExactPackageBundle(
  context: AdapterOperationContext,
  desired: DesiredPackage,
  metadata: PiMutationMetadata,
): void {
  const current = inspectPackageBundle(desired, context.runtime.applicationDataDir)
  if (current.state === 'absent') return
  if (current.fingerprint !== metadata.beforeBundleFingerprint || current.state !== 'exact') {
    throw new Error('pi_package_remove_bundle_precondition_changed')
  }
  const entries = listPackageEntries(desired.packageRoot)
  if (entries.files.length !== Object.keys(desired.files).length
    || entries.files.some(relative => sha256Bytes(fs.readFileSync(path.join(desired.packageRoot, relative)))
      !== sha256Bytes(desired.files[relative]))) {
    throw new Error('pi_package_remove_bundle_cas_conflict')
  }
  for (const relative of entries.files) {
    const target = path.join(desired.packageRoot, relative)
    const inspected = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    if (inspected.containerHash !== sha256Bytes(desired.files[relative])) throw new Error('pi_package_remove_file_changed')
    fs.unlinkSync(inspected.canonicalPath)
  }
  for (const relative of entries.directories.sort((a, b) => b.length - a.length)) {
    const target = path.join(desired.packageRoot, relative)
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('pi_package_remove_symlink_rejected')
    fs.rmdirSync(target)
  }
  fs.rmdirSync(desired.packageRoot)
}

async function inspectAggregateWithList(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  desired: DesiredPackage,
  dependencies: PiPackageAdapterDependencies,
): Promise<MutationReadBack> {
  try {
    assertMutation(context, mutation)
    const metadata = parseMetadata(mutation)
    const aggregate = inspectAggregate(context, desired)
    const list = await dependencies.run(mutation.executableRealpath!, ['list', '--no-approve'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: piCliEnvironment(context, mutation.executableRealpath!),
      cwd: context.runtime.homeDir,
    })
    if (list.exitCode !== 0) return unknownReadBack(mutation, 'pi_package_list_failed', aggregate.aggregateHash)
    const listed = listContainsExactSource(list.stdout, desired.registrationSource)
    const matchesDesired = metadata.remove
      ? aggregate.absent && !listed
      : aggregate.exact && listed
    const diagnostics = [...aggregate.diagnostics]
    if (!metadata.remove && aggregate.exact && !listed) diagnostics.push('pi_package_not_visible_in_list')
    if (metadata.remove && aggregate.absent && listed) diagnostics.push('pi_package_still_visible_in_list')
    const intermediate = aggregate.bundle.state === 'exact'
      && aggregate.registration.state === 'absent'
      && !listed
      ? mutation.safeResumeStates?.find(state => state.fingerprint === aggregate.aggregateHash)
      : undefined
    return {
      operationId: mutation.operationId,
      observed: !aggregate.absent || listed,
      matchesDesired,
      observedFragmentHash: aggregate.aggregateHash,
      visibility: aggregate.exact && listed ? 'dedicated' : aggregate.absent && !listed ? 'absent' : 'unknown',
      safeToResumeFrom: intermediate,
      diagnostics,
    }
  } catch (error) {
    return unknownReadBack(mutation, errorMessage(error))
  }
}

async function verifyPiPackage(
  context: AdapterOperationContext,
  request: AdapterVerificationRequest,
  desired: DesiredPackage,
  dependencies: PiPackageAdapterDependencies,
): Promise<readonly ComponentVerificationResult[]> {
  const requested = COMPONENTS.filter(component => request.componentKeys.includes(component))
  const executable = context.installation.distribution.executableRealpath
  const manageable = manageableDistribution(context)
  if (!manageable.ok || !executable) return requested.map(component => failedVerification(component, manageable.ok ? 'pi_executable_missing' : manageable.reason))
  const aggregate = inspectAggregate(context, desired)
  const list = await dependencies.run(executable, ['list', '--no-approve'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: piCliEnvironment(context, executable),
    cwd: context.runtime.homeDir,
  })
  if (list.exitCode !== 0) return requested.map(component => failedVerification(component, 'pi_package_list_failed'))
  const listed = listContainsExactSource(list.stdout, desired.registrationSource)
  if (request.expectedCapability === 0 && aggregate.absent && !listed) {
    return requested.map(componentKey => ({
      componentKey,
      status: 'verified',
      verifiedCapability: 0,
      identityAssertion: context.agentId,
      invalidationKeys: ['host_version', 'adapter_version', 'projection_version'],
      diagnostics: ['disconnect_package_and_registration_absent'],
    }))
  }
  if (!aggregate.exact || !listed) {
    const diagnostic = aggregate.diagnostics[0] ?? (!listed ? 'pi_package_not_visible_in_list' : 'pi_package_static_readback_failed')
    return requested.map(component => failedVerification(component, diagnostic))
  }

  const results: ComponentVerificationResult[] = []
  const instructionActivity = await verifyHostActivity(context, request, {
    componentKey: 'lifecycle',
    signalNames: ['session_start'],
    require: 'all',
  })
  const lifecycle = await verifyHostActivity(context, request, {
    componentKey: 'lifecycle',
    signalNames: PI_REQUIRED_LIFECYCLE_SIGNALS,
    require: 'all',
  })
  if (requested.includes('instruction')) {
    results.push(instructionActivity.status === 'verified'
      ? {
          ...instructionActivity,
          componentKey: 'instruction',
          verifiedCapability: 1,
          diagnostics: ['pi_package_extension_loaded', ...instructionActivity.diagnostics],
        }
      : unverifiedStatic('instruction', aggregate.aggregateHash, instructionActivity.diagnostics))
  }
  if (requested.includes('memory_tools')) {
    const memory = await verifyMemoryReadWriteActivity(context, request)
    results.push(memory.status === 'verified' ? memory : unverifiedStatic('memory_tools', aggregate.aggregateHash, memory.diagnostics))
  }
  if (requested.includes('lifecycle')) {
    results.push(lifecycle.status === 'verified' ? lifecycle : unverifiedStatic('lifecycle', aggregate.aggregateHash, lifecycle.diagnostics))
  }
  return results
}

function runPi(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  dependencies: PiPackageAdapterDependencies,
): Promise<PiCommandResult> {
  return dependencies.run(mutation.executableRealpath!, mutation.args!, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: piCliEnvironment(context, mutation.executableRealpath!),
    cwd: context.runtime.homeDir,
  })
}

function piCliEnvironment(context: AdapterOperationContext, executable: string): Readonly<Record<string, string>> {
  const directories = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(context.runtime.homeDir, '.local', 'bin')])
  const nvm = executable.match(/^(.*\/\.nvm\/versions\/node\/[^/]+)\/lib\/node_modules\//u)?.[1]
  if (nvm) directories.add(path.join(nvm, 'bin'))
  const env: Record<string, string> = {
    HOME: context.runtime.homeDir,
    PI_CODING_AGENT_DIR: context.installation.canonicalConfigRoot,
    NO_COLOR: '1',
    PATH: [...directories].join(path.delimiter),
  }
  for (const key of ['LANG', 'LC_ALL', 'TERM', 'TMPDIR'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function assertSettingsPrecondition(registration: RegistrationInspection, metadata: PiMutationMetadata): void {
  if (registration.containerHash !== metadata.settingsContainerPreconditionHash
    || registration.selectorHash !== metadata.beforeRegistrationSelectorHash
    || registration.remainderHash !== metadata.settingsRemainderPreconditionHash) {
    throw new Error('pi_settings_precondition_changed')
  }
}

function assertSettingsRemainderPreserved(
  context: AdapterOperationContext,
  desired: DesiredPackage,
  metadata: PiMutationMetadata,
): void {
  const after = inspectRegistration(desired, context.installation.canonicalConfigRoot)
  if (after.remainderHash !== metadata.settingsRemainderPreconditionHash) throw new Error('pi_settings_unrelated_content_changed')
  if (metadata.remove ? after.state !== 'absent' : after.state !== 'exact') throw new Error('pi_settings_selector_readback_mismatch')
}

function repairableBundleState(
  current: BundleInspection,
  metadata: PiMutationMetadata,
  desiredFiles: Readonly<Record<string, string>>,
): boolean {
  if (current.diagnostics.length > 0) return false
  return Object.keys(desiredFiles).every(relative => {
    const live = current.fileHashes[relative] ?? null
    return live === (metadata.beforeFileHashes[relative] ?? null) || live === sha256Bytes(desiredFiles[relative])
  })
}

function ownedBaselines(artifacts: readonly OwnedArtifactBaseline[], ownershipKey: string): OwnedArtifactBaseline[] {
  return artifacts.filter(artifact => artifact.ownershipKey === ownershipKey && COMPONENTS.includes(artifact.componentKey))
}

function consistentAggregateBaseline(baselines: readonly OwnedArtifactBaseline[]): OwnedArtifactBaseline | undefined {
  if (baselines.length === 0) return undefined
  const first = baselines[0]
  return baselines.every(item => item.physicalTarget === first.physicalTarget
    && item.ownedFragmentHash === first.ownedFragmentHash
    && (item.selectorSchemaVersion ?? SELECTOR_SCHEMA_VERSION) === (first.selectorSchemaVersion ?? SELECTOR_SCHEMA_VERSION))
    ? first
    : undefined
}

function desiredFromMetadata(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: PiMutationMetadata,
): DesiredPackage {
  const bundleHash = bundleFingerprint(metadata.desiredFiles)
  const registrationHash = desiredRegistrationHash(metadata.packageRoot, metadata.registrationSource)
  const desired: DesiredPackage = {
    homeDir: context.runtime.homeDir,
    packageRoot: metadata.packageRoot,
    settingsPath: metadata.settingsPath,
    registrationSource: metadata.registrationSource,
    packageName: metadata.packageName,
    files: metadata.desiredFiles,
    bundleHash,
    registrationHash,
    aggregateHash: aggregateFingerprint(bundleHash, registrationHash),
  }
  const expected = metadata.remove ? absentAggregateHash() : desired.aggregateHash
  if (mutation.desiredFragmentHash !== expected) throw new Error('pi_package_desired_hash_invalid')
  return desired
}

function parseMetadata(mutation: PlannedMutation): PiMutationMetadata {
  const value = mutation.metadata as unknown as Partial<PiMutationMetadata> | undefined
  if (!value || value.kind !== 'pi_package_aggregate'
    || value.artifactType !== 'plugin'
    || value.reversible !== true
    || typeof value.canonicalPath !== 'string'
    || typeof value.packageRoot !== 'string'
    || typeof value.settingsPath !== 'string'
    || typeof value.registrationSource !== 'string'
    || typeof value.packageName !== 'string'
    || !isStringRecord(value.desiredFiles)
    || !isNullableStringRecord(value.beforeFileHashes)
    || (value.beforeBundleFingerprint !== null && typeof value.beforeBundleFingerprint !== 'string')
    || (value.beforeRegistrationSelectorHash !== null && typeof value.beforeRegistrationSelectorHash !== 'string')
    || (value.settingsContainerPreconditionHash !== null && typeof value.settingsContainerPreconditionHash !== 'string')
    || (value.settingsRemainderPreconditionHash !== null && typeof value.settingsRemainderPreconditionHash !== 'string')
    || typeof value.aggregatePreconditionHash !== 'string'
    || typeof value.remove !== 'boolean') {
    throw new Error('pi_package_mutation_metadata_invalid')
  }
  return value as PiMutationMetadata
}

function assertMutation(context: AdapterOperationContext, mutation: PlannedMutation): void {
  const frozen = context.installation.distribution.executableRealpath
  if (mutation.operation !== 'host_command'
    || mutation.domainKind !== 'plugin_manager'
    || !frozen
    || !path.isAbsolute(frozen)
    || mutation.executableRealpath !== frozen
    || mutation.commandCategory !== 'plugin_install'
    || !mutation.args
    || mutation.args.length !== 3
    || !['install', 'remove'].includes(mutation.args[0])
    || mutation.args[1] !== mutation.physicalTarget
    || mutation.args[2] !== '--no-approve') {
    throw new Error('pi_package_mutation_not_frozen')
  }
  if (mutation.componentKey !== 'instruction'
    || COMPONENTS.some(component => !mutation.coveredComponentKeys?.includes(component))) {
    throw new Error('pi_package_aggregate_components_invalid')
  }
  const metadata = parseMetadata(mutation)
  if (metadata.packageRoot !== mutation.physicalTarget
    || metadata.canonicalPath !== metadata.packageRoot
    || path.resolve(metadata.settingsPath) !== path.resolve(context.installation.canonicalConfigRoot, 'settings.json')
    || metadata.registrationSource !== (path.relative(context.installation.canonicalConfigRoot, metadata.packageRoot) || '.')
    || mutation.additionalFenceTargets?.length !== 1
    || mutation.additionalFenceTargets[0]?.domainKind !== 'file_fragment'
    || mutation.additionalFenceTargets[0]?.physicalTarget !== metadata.settingsPath) {
    throw new Error('pi_package_aggregate_targets_invalid')
  }
  assertContained(metadata.packageRoot, context.runtime.applicationDataDir)
}

function listPackageEntries(root: string): { files: string[]; directories: string[] } {
  const files: string[] = []
  const directories: string[] = []
  const queue = ['']
  let count = 0
  while (queue.length > 0) {
    const relativeRoot = queue.shift()!
    for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
      if (++count > MAX_PACKAGE_ENTRIES) throw new Error('pi_package_too_many_entries')
      const relative = path.join(relativeRoot, entry.name)
      if (entry.isSymbolicLink()) throw new Error('pi_package_symlink_rejected')
      if (entry.isDirectory()) { directories.push(relative); queue.push(relative) }
      else if (entry.isFile()) files.push(relative)
      else throw new Error('pi_package_non_regular_entry')
    }
  }
  return { files: files.sort(), directories: directories.sort() }
}

function bundleFingerprint(files: Readonly<Record<string, string>>): string {
  return sha256Json(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, content]) => ({ relativePath, hash: sha256Bytes(content) })))
}

function desiredRegistrationHash(packageRoot: string, registrationSource: string): string {
  return sha256Json({
    scope: 'user',
    source: registrationSource,
    resolvedIdentity: path.resolve(packageRoot),
    filtered: false,
  })
}

function aggregateFingerprint(bundleHash: string | null, registrationHash: string | null): string {
  return sha256Json({ packageTree: bundleHash, registrationSelector: registrationHash })
}

function absentAggregateHash(): string {
  return aggregateFingerprint(null, null)
}

function listContainsExactSource(output: string, packageRoot: string): boolean {
  const ansi = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'gu',
  )
  return output.replace(ansi, '').split(/\r?\n/u).some(line => line.trim() === packageRoot)
}

function unknownAggregate(desired: DesiredPackage, diagnostic: string): AggregateInspection {
  return {
    bundle: { state: 'other', fingerprint: null, fileHashes: {}, diagnostics: [diagnostic] },
    registration: unknownRegistration(desired.settingsPath, null, diagnostic),
    aggregateHash: aggregateFingerprint(null, null),
    exact: false,
    absent: false,
    diagnostics: [diagnostic],
  }
}

function unknownRegistration(canonicalPath: string, containerHash: string | null, diagnostic: string): RegistrationInspection {
  return {
    state: 'unknown', containerHash, canonicalPath, selectorHash: null, remainderHash: null, diagnostics: [diagnostic],
  }
}

function unknownReadBack(mutation: PlannedMutation, diagnostic: string, fingerprint?: string): MutationReadBack {
  return {
    operationId: mutation.operationId,
    observed: false,
    matchesDesired: false,
    observedFragmentHash: fingerprint,
    visibility: 'unknown',
    diagnostics: [diagnostic],
  }
}

function failedVerification(componentKey: ComponentKey, diagnostic: string): ComponentVerificationResult {
  return {
    componentKey,
    status: 'failed',
    verifiedCapability: null,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version'],
    diagnostics: [diagnostic],
  }
}

function unverifiedStatic(componentKey: ComponentKey, evidenceHash: string, diagnostics: readonly string[]): ComponentVerificationResult {
  return {
    componentKey,
    status: 'unverified',
    verifiedCapability: null,
    evidenceHash,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version', 'tide_mind_version', 'activity_freshness'],
    diagnostics: ['static_package_and_pi_list_readback_passed', ...diagnostics],
  }
}

function jsonDocument(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function safeSegment(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!result) throw new Error('pi_package_agent_identity_invalid')
  return result.slice(0, 96)
}

function assertContained(target: string, root: string): void {
  if (!path.isAbsolute(target) || !path.isAbsolute(root)) throw new Error('pi_package_path_not_absolute')
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('pi_package_path_outside_application_data')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

function isNullableStringRecord(value: unknown): value is Readonly<Record<string, string | null>> {
  return isRecord(value) && Object.values(value).every(item => item === null || typeof item === 'string')
}

function boundedDiagnostic(value: string): string { return value.trim().replace(/\s+/gu, ' ').slice(0, 512) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
