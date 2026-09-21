import { execFile } from 'node:child_process'
import { shellArgument } from '../shell-argument'
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
  AdoptableArtifactObservation,
  AgentHostAdapter,
  ComponentKey,
  ComponentVerificationResult,
  FrozenHostCommand,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

export const GEMINI_REQUIRED_LIFECYCLE_SIGNALS = Object.freeze([
  'session_start', 'pre_compact', 'session_end',
] as const)

export interface GeminiExtensionCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface GeminiExtensionAdapterDependencies {
  run(
    executableRealpath: string,
    args: readonly string[],
    options: { timeoutMs: number; cwd: string; env: Readonly<Record<string, string>> },
  ): Promise<GeminiExtensionCommandResult>
}

export interface GeminiExtensionAdapterOptions {
  adapterVersion?: string
  dependencies?: GeminiExtensionAdapterDependencies
}

interface DesiredExtension {
  name: string
  version: string
  stagingRoot: string
  installedRoot: string
  files: Readonly<Record<string, string>>
  packageHash: string
  desiredHash: string
  absentHash: string
}

type ExtensionState = 'absent' | 'exact' | 'disabled' | 'stale' | 'conflict' | 'unknown'

interface ExtensionInspection {
  state: ExtensionState
  observed: boolean
  fingerprint: string | null
  diagnostics: string[]
}

interface GeminiMutationMetadata {
  artifactType: 'plugin'
  kind: 'install' | 'repair' | 'enable' | 'uninstall'
  extensionName: string
  extensionVersion: string
  stagingRoot: string
  installedRoot: string
  desiredFiles: Readonly<Record<string, string>>
  packageHash: string
  beforeHash: string | null
  desiredHash: string | null
  absentHash: string
  previewTitle: string
  previewDescription: string
  reversal: string
}

interface ListedExtension {
  name: string
  version?: string
  path?: string
  isActive?: boolean
}

const COMPONENTS = ['instruction', 'memory_tools', 'lifecycle'] as const satisfies readonly ComponentKey[]
const OFFICIAL_PROVENANCE = 'npm_metadata:@google/gemini-cli'
const COMMAND_TIMEOUT_MS = 60_000
const SELECTOR_SCHEMA_VERSION = 1
const INSTALL_METADATA = '.gemini-extension-install.json'
const MAX_ENTRIES = 32
const MAX_FILE_BYTES = 1024 * 1024
const execFileAsync = promisify(execFile)

/**
 * Installs one official Gemini CLI Extension that carries context/Skill, MCP
 * and the supported lifecycle Hooks together. The official CLI owns copy/registration;
 * Tide Mind never edits ~/.gemini/extensions directly.
 */
export function createGeminiExtensionHostAdapter(
  options: GeminiExtensionAdapterOptions = {},
): AgentHostAdapter {
  const adapterVersion = options.adapterVersion ?? '1'
  const dependencies = options.dependencies ?? productionDependencies()

  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const desired = desiredExtension(context)
    const manageable = manageableDistribution(context)
    const current = manageable.ok
      ? await inspectExtension(context, desired, dependencies)
      : { state: 'unknown' as const, observed: false, fingerprint: null, diagnostics: [manageable.reason] }
    const visibility = current.state === 'exact' ? 'dedicated'
      : current.state === 'absent' ? 'absent'
        : current.observed ? 'shared_visible' : 'unknown'
    return {
      catalogId: 'gemini-cli',
      detected: executableExists(context),
      detectedVersion: context.hostVersion,
      distribution: { ...context.installation.distribution },
      components: COMPONENTS.map(componentKey => ({
        componentKey,
        visibility,
        verificationStatus: 'unverified',
        observedTarget: desired.installedRoot,
        observedFragmentHash: current.fingerprint ?? undefined,
        details: {
          implementation: 'gemini_official_extension',
          extensionName: desired.name,
          extensionVersion: desired.version,
          extensionState: current.state,
        },
      })),
      provenance: [desired.installedRoot],
      diagnostics: current.diagnostics,
    }
  }

  const buildPlan = async (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    remove: boolean,
  ): Promise<AdapterPlan> => {
    const desired = desiredExtension(context)
    const base: Omit<AdapterPlan, 'mutations' | 'diagnostics'> = {
      catalogId: 'gemini-cli',
      installationKey: context.installation.installKey,
      adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      requiredUserActions: [],
    }
    if (COMPONENTS.some(component => !request.desiredComponents.includes(component))) {
      return { ...base, mutations: [], diagnostics: ['gemini_extension_requires_all_components'] }
    }
    const manageable = manageableDistribution(context)
    if (!request.observed.detected) {
      return {
        ...base,
        mutations: [],
        diagnostics: ['gemini_host_not_detected'],
      }
    }
    if (!manageable.ok) return { ...base, mutations: [], diagnostics: [manageable.reason] }
    const current = await inspectExtension(context, desired, dependencies)
    if (current.state === 'unknown' || current.state === 'conflict') {
      return { ...base, mutations: [], diagnostics: current.diagnostics.length ? current.diagnostics : ['gemini_extension_conflict'] }
    }
    const ownershipKey = extensionOwnershipKey(desired)
    const baselines = COMPONENTS.map(componentKey => baselineFor(
      request.ownedArtifacts,
      componentKey,
      desired.installedRoot,
      ownershipKey,
    ))
    const ownedHash = exactAggregateBaseline(baselines)
    if (baselines.some(Boolean) && ownedHash === null) {
      return { ...base, mutations: [], diagnostics: ['gemini_extension_ownership_baselines_incomplete'] }
    }

    let kind: GeminiMutationMetadata['kind']
    if (remove) {
      if (current.state === 'absent') return { ...base, mutations: [], diagnostics: [] }
      if (ownedHash === null || current.fingerprint !== ownedHash) {
        return { ...base, mutations: [], diagnostics: ['gemini_extension_uninstall_requires_exact_ownership'] }
      }
      kind = 'uninstall'
    } else if (current.state === 'absent') {
      kind = 'install'
    } else if (ownedHash === null) {
      return { ...base, mutations: [], diagnostics: ['gemini_extension_name_exists_without_ownership'] }
    } else if (current.fingerprint !== ownedHash) {
      return { ...base, mutations: [], diagnostics: ['gemini_extension_changed_outside_tidemind'] }
    } else if (current.state === 'disabled') {
      kind = 'enable'
    } else if (current.fingerprint !== desired.desiredHash) {
      kind = 'repair'
    } else {
      return { ...base, mutations: [], diagnostics: [] }
    }

    const metadata = mutationMetadata(kind, desired, current.fingerprint)
    const commands = commandsFor(kind, context, desired)
    const mutation: PlannedMutation = {
      operationId: `${context.operationId}:gemini-extension:${kind}`,
      componentKey: 'instruction',
      coveredComponentKeys: COMPONENTS,
      operation: 'host_command',
      domainKind: 'plugin_manager',
      physicalTarget: desired.installedRoot,
      ownershipKey,
      selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
      additionalFenceTargets: kind === 'install' || kind === 'repair'
        ? [{ domainKind: 'directory', physicalTarget: desired.stagingRoot }]
        : undefined,
      risk: kind === 'uninstall' || kind === 'repair' ? 'elevated' : 'low',
      reload: 'new_session',
      commandCategory: commands.some(command => command.category === 'plugin_install')
        ? 'plugin_install'
        : 'host_cli',
      ...(commands.length === 1
        ? { executableRealpath: commands[0].executableRealpath, args: commands[0].args }
        : { frozenCommands: commands }),
      safeResumeStates: kind === 'repair'
        ? [{ fingerprint: desired.absentHash, completedStepIds: ['uninstall'] }]
        : undefined,
      preconditionHash: current.fingerprint ?? undefined,
      desiredFragmentHash: kind === 'uninstall' ? undefined : desired.desiredHash,
      idempotent: true,
      metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
    }
    return { ...base, mutations: [mutation], diagnostics: [] }
  }

  return {
    catalogId: 'gemini-cli',
    adapterVersion,
    componentKeys: COMPONENTS,
    implementationTypes: {
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin', 'mcp'],
      lifecycle: ['plugin', 'hook'],
    },
    componentContracts: {
      instruction: { deliveryMode: 'managed', artifactTypes: ['plugin', 'skill'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      memory_tools: { deliveryMode: 'managed', artifactTypes: ['plugin', 'mcp'], mutationDomain: 'plugin_manager', reload: 'new_session' },
      lifecycle: { deliveryMode: 'managed', artifactTypes: ['plugin', 'hook'], mutationDomain: 'plugin_manager', reload: 'new_session' },
    },
    inspect,
    inspectAdoptableArtifacts: context => inspectLegacyGeminiExtension(context, dependencies),
    plan: (context, request) => buildPlan(context, request, false),
    disconnect: (context, request) => buildPlan(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, true),
    async apply(context, mutation) {
      const desired = desiredExtension(context)
      const metadata = parseMetadata(mutation)
      assertFrozenMutation(context, mutation, metadata, desired)
      const before = await inspectExtension(context, desired, dependencies)
      const safeAbsentResume = metadata.kind === 'repair'
        && before.state === 'absent'
        && mutation.safeResumeStates?.some(state => state.fingerprint === desired.absentHash)
      if (!safeAbsentResume && before.fingerprint !== metadata.beforeHash) {
        throw new Error('gemini_extension_live_precondition_changed')
      }
      if (before.state === 'conflict' || before.state === 'unknown') {
        throw new Error(before.diagnostics.join(';') || 'gemini_extension_precondition_unknown')
      }

      if (metadata.kind === 'install' || metadata.kind === 'repair') stagePackage(context, desired)
      const commands = frozenCommands(mutation)
      const startIndex = safeAbsentResume ? 1 : 0
      try {
        for (const command of commands.slice(startIndex)) {
          const result = await dependencies.run(command.executableRealpath, command.args, {
            timeoutMs: COMMAND_TIMEOUT_MS,
            cwd: context.runtime.homeDir,
            env: geminiEnvironment(context, command.executableRealpath),
          })
          if (result.exitCode !== 0) {
            throw new Error(`gemini_extension_command_failed:${result.exitCode}:${bounded(result.stderr || result.stdout)}`)
          }
        }
        const after = await inspectExtension(context, desired, dependencies)
        const desiredFingerprint = metadata.kind === 'uninstall' ? null : metadata.desiredHash
        if ((metadata.kind === 'uninstall' && after.state !== 'absent')
          || (metadata.kind !== 'uninstall' && (after.state !== 'exact' || after.fingerprint !== desiredFingerprint))) {
          throw new Error(after.diagnostics.join(';') || 'gemini_extension_command_readback_mismatch')
        }
        return {
          operationId: mutation.operationId,
          effectObserved: true,
          postEffectFingerprint: after.fingerprint ?? undefined,
          hostReceipt: {
            extensionName: desired.name,
            extensionVersion: desired.version,
            completedCommands: commands.length,
            reload: 'new_session',
          },
        }
      } finally {
        if (metadata.kind === 'install' || metadata.kind === 'repair') cleanupStaging(context, desired)
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      try {
        const desired = desiredExtension(context)
        const metadata = parseMetadata(mutation)
        assertFrozenMutation(context, mutation, metadata, desired)
        const current = await inspectExtension(context, desired, dependencies)
        const removing = metadata.kind === 'uninstall'
        if (metadata.kind === 'repair' && current.state === 'absent') {
          return {
            operationId: mutation.operationId,
            observed: true,
            matchesDesired: false,
            observedFragmentHash: desired.absentHash,
            visibility: 'absent',
            safeToResumeFrom: { fingerprint: desired.absentHash, completedStepIds: ['uninstall'] },
            diagnostics: ['gemini_extension_repair_uninstall_completed'],
          }
        }
        return {
          operationId: mutation.operationId,
          observed: current.observed,
          matchesDesired: removing
            ? current.state === 'absent'
            : current.state === 'exact' && current.fingerprint === metadata.desiredHash,
          observedFragmentHash: current.fingerprint ?? undefined,
          visibility: current.state === 'exact' ? 'dedicated'
            : current.state === 'absent' ? 'absent'
              : current.observed ? 'shared_visible' : 'unknown',
          diagnostics: current.diagnostics,
        }
      } catch (error) {
        return {
          operationId: mutation.operationId,
          observed: false,
          matchesDesired: false,
          visibility: 'unknown',
          diagnostics: [errorMessage(error)],
        }
      }
    },
    verify: (context, request) => verifyGeminiExtension(context, request, desiredExtension(context), dependencies),
  }
}

async function inspectLegacyGeminiExtension(
  context: AdapterOperationContext,
  dependencies: GeminiExtensionAdapterDependencies,
): Promise<readonly AdoptableArtifactObservation[]> {
  const name = `tidemind-${context.agentId}`
  const root = path.join(context.installation.canonicalConfigRoot, 'extensions', name)
  const legacyStaging = path.join(context.runtime.applicationDataDir, 'plugins', `gemini-${context.agentId}`)
  try {
    assertContained(root, path.join(context.installation.canonicalConfigRoot, 'extensions'))
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) return []
    const entries = listEntries(root)
    const allowedFiles = new Set([
      INSTALL_METADATA,
      'gemini-extension.json',
      'GEMINI.md',
      'hooks/hooks.json',
      'commands/brain-recall.toml',
      'commands/brain-digest.toml',
      'commands/brain-forget.toml',
    ])
    if (entries.files.some(file => !allowedFiles.has(file))
      || !['gemini-extension.json', 'GEMINI.md', 'hooks/hooks.json'].every(file => entries.files.includes(file))) return []
    const expectedDirectories = new Set(entries.files.flatMap(relative => {
      const segments = relative.split(path.sep)
      return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join(path.sep))
    }))
    if (entries.directories.some(directory => !expectedDirectories.has(directory))) return []
    const manifestFile = inspectRegularFileWithinRoot(path.join(root, 'gemini-extension.json'), root)
    const hookFile = inspectRegularFileWithinRoot(path.join(root, 'hooks', 'hooks.json'), root)
    const installedContext = inspectRegularFileWithinRoot(path.join(root, 'GEMINI.md'), root)
    const sourceContext = inspectRegularFileWithinRoot(
      path.join(context.runtime.applicationDataDir, 'skill', 'gemini-skill.md'),
      context.runtime.applicationDataDir,
    )
    if (!manifestFile.containerHash || !hookFile.containerHash || !installedContext.containerHash || !sourceContext.exists) return []
    const manifest = JSON.parse(fs.readFileSync(manifestFile.canonicalPath, 'utf8')) as Record<string, unknown>
    const hooks = JSON.parse(fs.readFileSync(hookFile.canonicalPath, 'utf8')) as Record<string, unknown>
    const expectedMcp = {
      command: context.runtime.shimPath,
      args: [context.runtime.mcpServerPath],
      env: { EB_AGENT_ID: context.agentId },
    }
    const mcp = (manifest.mcpServers as Record<string, unknown> | undefined)?.tidemind
    const metadata = readInstallMetadata(path.join(root, INSTALL_METADATA))
    if (manifest.name !== name
      || manifest.version !== '1.0.0'
      || manifest.contextFileName !== 'GEMINI.md'
      || sha256Json(mcp) !== sha256Json(expectedMcp)
      || !metadata
      || metadata.type !== 'local'
      || path.resolve(metadata.source) !== path.resolve(legacyStaging)
      || fs.readFileSync(installedContext.canonicalPath, 'utf8') !== stripLegacyFrontmatter(fs.readFileSync(sourceContext.canonicalPath, 'utf8'))
      || !legacyGeminiHooksMatch(hooks, context, root)) return []
    for (const command of ['brain-recall.toml', 'brain-digest.toml', 'brain-forget.toml']) {
      const installedRelative = path.join('commands', command)
      const installed = entries.files.includes(installedRelative)
        ? inspectRegularFileWithinRoot(path.join(root, installedRelative), root)
        : null
      const source = inspectRegularFileWithinRoot(
        path.join(context.runtime.applicationDataDir, 'skill', 'gemini-commands', command),
        context.runtime.applicationDataDir,
      )
      if (source.exists !== Boolean(installed)
        || (source.exists && installed && source.containerHash !== installed.containerHash)) return []
    }
    const executable = context.installation.distribution.executableRealpath
    if (!executable) return []
    const listResult = await dependencies.run(executable, ['extensions', 'list', '--output-format', 'json'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
      cwd: context.runtime.homeDir,
      env: geminiEnvironment(context, executable),
    })
    const listed = listResult.exitCode === 0 ? parseExtensionList(listResult.stdout) : null
    if (!listed || !listed.ok) return []
    const matches = listed.extensions.filter(extension => extension.name === name)
    if (matches.length !== 1 || matches[0].version !== '1.0.0'
      || matches[0].isActive !== true || path.resolve(matches[0].path ?? '') !== path.resolve(root)) return []
    const fingerprint = sha256Json(entries.files.map(relative => ({
      relative,
      hash: inspectRegularFileWithinRoot(path.join(root, relative), root).containerHash,
    })))
    return COMPONENTS.map(componentKey => ({
      componentKey,
      artifactType: componentKey === 'instruction' ? 'skill' : componentKey === 'memory_tools' ? 'mcp' : 'hook',
      domainKind: 'directory',
      physicalTarget: root,
      ownershipKey: `legacy-gemini-extension:${name}:${componentKey}`,
      selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
      projectionVersion: context.runtime.projectionVersion,
      fragmentHash: fingerprint,
      identityAssertion: context.agentId,
      discoverReachability: 'dedicated',
    }))
  } catch {
    return []
  }
}

function stripLegacyFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body
  const end = body.indexOf('---', 3)
  if (end === -1) return body
  return body.slice(end + 3).replace(/^\r?\n/, '')
}

function legacyGeminiHooksMatch(
  document: Record<string, unknown>,
  context: AdapterOperationContext,
  installedRoot: string,
): boolean {
  const hooks = document.hooks as Record<string, unknown> | undefined
  if (!hooks || Object.keys(hooks).join(',') !== 'SessionStart') return false
  const groups = hooks.SessionStart
  if (!Array.isArray(groups) || groups.length !== 1 || (groups[0] as { matcher?: unknown }).matcher !== 'startup|resume') return false
  const nested = (groups[0] as { hooks?: unknown }).hooks
  if (!Array.isArray(nested) || nested.length !== 1) return false
  const hook = nested[0] as { type?: unknown; command?: unknown; timeout?: unknown }
  const command = [
    JSON.stringify(context.runtime.shimPath),
    JSON.stringify(context.runtime.hookScriptPath),
    '--agent-id', JSON.stringify(context.agentId),
    '--skill-path', JSON.stringify(path.join(installedRoot, 'GEMINI.md')),
    '--tool', JSON.stringify('gemini'),
  ].join(' ')
  return hook.type === 'command' && hook.command === command && hook.timeout === 15000
}

function productionDependencies(): GeminiExtensionAdapterDependencies {
  return {
    async run(executableRealpath, args, options) {
      try {
        const result = await execFileAsync(executableRealpath, [...args], {
          timeout: options.timeoutMs,
          cwd: options.cwd,
          env: { ...options.env },
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        })
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? failure.message,
        }
      }
    },
  }
}

function desiredExtension(context: AdapterOperationContext): DesiredExtension {
  const name = extensionName(context.agentId)
  const stagingRoot = path.join(
    context.runtime.applicationDataDir,
    'agent-integration-staging',
    'gemini',
    name,
  )
  const installedRoot = path.join(context.installation.canonicalConfigRoot, 'extensions', name)
  const contextDocument = renderContext(context)
  const skill = renderSkill()
  const sessionStartCommand = [
    context.runtime.shimPath,
    context.runtime.hookScriptPath,
    '--agent-id', context.agentId,
    '--skill-path', path.join(installedRoot, 'skills', 'tidemind', 'SKILL.md'),
    '--tool', 'gemini',
    '--expected-skill-sha256', sha256Bytes(skill),
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ].map(shellArgument).join(' ')
  const preCompressCommand = [
    context.runtime.shimPath,
    context.runtime.preCompactScriptPath,
    '--agent-id', context.agentId,
    '--tool', 'gemini',
    '--event-name', 'PreCompress',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ].map(shellArgument).join(' ')
  const sessionEndCommand = [
    context.runtime.shimPath,
    path.join(path.dirname(context.runtime.hookScriptPath), 'hook-session-end.cjs'),
    '--agent-id', context.agentId,
    '--tool', 'gemini',
    ...(context.activityGenerationToken ? ['--activity-generation-token', context.activityGenerationToken] : []),
  ].map(shellArgument).join(' ')
  const hooks = jsonDocument({
    hooks: {
      SessionStart: [{
        hooks: [{
          type: 'command',
          command: sessionStartCommand,
          name: `tidemind-${context.agentId}-session-start`,
          timeout: 60_000,
          description: 'Load Tide Mind context when a Gemini CLI session starts or resumes.',
        }],
      }],
      PreCompress: [{
        hooks: [{
          type: 'command',
          command: preCompressCommand,
          name: `tidemind-${context.agentId}-pre-compress`,
          timeout: 60_000,
          description: 'Save Tide Mind context before Gemini CLI compresses the session.',
        }],
      }],
      SessionEnd: [{
        hooks: [{
          type: 'command',
          command: sessionEndCommand,
          name: `tidemind-${context.agentId}-session-end`,
          timeout: 60_000,
          description: 'Record the end of a Gemini CLI session.',
        }],
      }],
    },
  })
  const payloadHash = sha256Json({
    agentId: context.agentId,
    hostVariant: context.installation.hostVariant,
    tideMindVersion: context.runtime.tideMindVersion,
    projectionVersion: context.runtime.projectionVersion,
    contextDocument,
    skill,
    hooks,
  })
  const version = `1.0.${Number.parseInt(payloadHash.slice(0, 6), 16)}`
  const manifest = jsonDocument({
    name,
    version,
    description: `Tide Mind external memory integration for ${context.agentId}`,
    mcpServers: {
      tidemind: {
        command: context.runtime.shimPath,
        args: [context.runtime.mcpServerPath],
        env: {
          EB_AGENT_ID: context.agentId,
          EB_HOST_VARIANT: context.installation.hostVariant,
          ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}),
        },
      },
    },
    contextFileName: 'GEMINI.md',
    excludeTools: [],
  })
  const files = Object.freeze({
    'gemini-extension.json': manifest,
    'GEMINI.md': contextDocument,
    'hooks/hooks.json': hooks,
    'skills/tidemind/SKILL.md': skill,
  })
  const packageHash = filesFingerprint(files)
  const desiredHash = installedStateHash({ name, version, installedRoot, stagingRoot, packageHash, active: true })
  return {
    name,
    version,
    stagingRoot,
    installedRoot,
    files,
    packageHash,
    desiredHash,
    absentHash: sha256Json({ name, state: 'absent' }),
  }
}

function mutationMetadata(
  kind: GeminiMutationMetadata['kind'],
  desired: DesiredExtension,
  beforeHash: string | null,
): GeminiMutationMetadata {
  const installing = kind === 'install' || kind === 'repair'
  const action = installing ? '安装' : kind === 'enable' ? '启用' : '卸载'
  return {
    artifactType: 'plugin',
    kind,
    extensionName: desired.name,
    extensionVersion: desired.version,
    stagingRoot: desired.stagingRoot,
    installedRoot: desired.installedRoot,
    desiredFiles: desired.files,
    packageHash: desired.packageHash,
    beforeHash,
    desiredHash: kind === 'uninstall' ? null : desired.desiredHash,
    absentHash: desired.absentHash,
    previewTitle: `Gemini 将${action}本机 Tide Mind Extension：${desired.name}`,
    previewDescription: installing
      ? `安装源：${desired.stagingRoot}；宿主写入域：${desired.installedRoot}`
      : `宿主写入域：${desired.installedRoot}`,
    reversal: kind === 'uninstall'
      ? '卸载后可重新执行“查看并连接”恢复同一 Tide Mind Extension'
      : `可通过 gemini extensions uninstall ${desired.name} 撤销`,
  }
}

function commandsFor(
  kind: GeminiMutationMetadata['kind'],
  context: AdapterOperationContext,
  desired: DesiredExtension,
): FrozenHostCommand[] {
  const executable = context.installation.distribution.executableRealpath!
  const install: FrozenHostCommand = {
    category: 'plugin_install',
    executableRealpath: executable,
    args: ['extensions', 'install', desired.stagingRoot, '--consent', '--skip-settings'],
  }
  if (kind === 'install') return [install]
  if (kind === 'repair') return [
    { category: 'plugin_install', executableRealpath: executable, args: ['extensions', 'uninstall', desired.name] },
    install,
  ]
  if (kind === 'enable') return [{
    category: 'host_cli',
    executableRealpath: executable,
    args: ['extensions', 'enable', desired.name, '--scope', 'user'],
  }]
  return [{
    category: 'plugin_install',
    executableRealpath: executable,
    args: ['extensions', 'uninstall', desired.name],
  }]
}

async function inspectExtension(
  context: AdapterOperationContext,
  desired: DesiredExtension,
  dependencies: GeminiExtensionAdapterDependencies,
): Promise<ExtensionInspection> {
  const bundle = inspectInstalledBundle(context, desired)
  const executable = context.installation.distribution.executableRealpath
  if (!executable) return { state: 'unknown', observed: bundle.exists, fingerprint: bundle.fingerprint, diagnostics: ['gemini_executable_realpath_unproven'] }
  const listResult = await dependencies.run(executable, ['extensions', 'list', '--output-format', 'json'], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    cwd: context.runtime.homeDir,
    env: geminiEnvironment(context, executable),
  })
  if (listResult.exitCode !== 0) {
    return {
      state: 'unknown',
      observed: bundle.exists,
      fingerprint: bundle.fingerprint,
      diagnostics: [`gemini_extensions_list_failed:${listResult.exitCode}:${bounded(listResult.stderr || listResult.stdout)}`],
    }
  }
  const parsed = parseExtensionList(listResult.stdout)
  if (!parsed.ok) {
    return { state: 'unknown', observed: bundle.exists, fingerprint: bundle.fingerprint, diagnostics: [parsed.reason] }
  }
  const matches = parsed.extensions.filter(extension => extension.name === desired.name)
  if (!bundle.exists && matches.length === 0) return { state: 'absent', observed: false, fingerprint: null, diagnostics: [] }
  if (matches.length !== 1 || !bundle.exists) {
    return {
      state: 'conflict',
      observed: true,
      fingerprint: sha256Json({ bundle: bundle.fingerprint, matches }),
      diagnostics: ['gemini_extension_registration_or_directory_conflict'],
    }
  }
  const listed = matches[0]
  const listedPath = listed.path ? path.resolve(listed.path) : null
  const expectedPath = path.resolve(desired.installedRoot)
  if (listedPath !== expectedPath || typeof listed.isActive !== 'boolean') {
    return {
      state: 'conflict',
      observed: true,
      fingerprint: installedStateHash({
        name: desired.name,
        version: listed.version ?? null,
        installedRoot: listedPath,
        stagingRoot: desired.stagingRoot,
        packageHash: bundle.fingerprint,
        active: listed.isActive ?? null,
      }),
      diagnostics: bundle.diagnostics.length ? bundle.diagnostics : ['gemini_extension_identity_or_version_conflict'],
    }
  }
  if (!bundle.repairable) {
    return {
      state: 'conflict',
      observed: true,
      fingerprint: installedStateHash({
        name: desired.name,
        version: listed.version ?? null,
        installedRoot: desired.installedRoot,
        stagingRoot: desired.stagingRoot,
        packageHash: bundle.fingerprint,
        active: listed.isActive,
      }),
      diagnostics: bundle.diagnostics,
    }
  }
  if (!bundle.exact || listed.version !== desired.version) {
    return {
      state: 'stale',
      observed: true,
      fingerprint: installedStateHash({
        name: desired.name,
        version: listed.version ?? null,
        installedRoot: desired.installedRoot,
        stagingRoot: desired.stagingRoot,
        packageHash: bundle.fingerprint,
        active: listed.isActive,
      }),
      diagnostics: bundle.diagnostics.length ? bundle.diagnostics : ['gemini_extension_version_stale'],
    }
  }
  const fingerprint = installedStateHash({
    name: desired.name,
    version: desired.version,
    installedRoot: desired.installedRoot,
    stagingRoot: desired.stagingRoot,
    packageHash: desired.packageHash,
    active: listed.isActive,
  })
  return listed.isActive
    ? { state: 'exact', observed: true, fingerprint, diagnostics: [] }
    : { state: 'disabled', observed: true, fingerprint, diagnostics: ['gemini_extension_disabled'] }
}

function inspectInstalledBundle(
  context: AdapterOperationContext,
  desired: DesiredExtension,
): { exists: boolean; exact: boolean; repairable: boolean; fingerprint: string | null; diagnostics: string[] } {
  const root = desired.installedRoot
  assertContained(root, path.join(context.installation.canonicalConfigRoot, 'extensions'))
  if (!fs.existsSync(root)) return { exists: false, exact: false, repairable: true, fingerprint: null, diagnostics: [] }
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { exists: true, exact: false, repairable: false, fingerprint: sha256Json({ unsafe: true }), diagnostics: ['gemini_extension_root_not_safe_directory'] }
  }
  const entries = listEntries(root)
  const expectedFiles = [...Object.keys(desired.files), INSTALL_METADATA].sort()
  const expectedDirectories = ['hooks', 'skills', path.join('skills', 'tidemind')].sort()
  const diagnostics: string[] = []
  let repairable = true
  if (entries.files.some(file => !expectedFiles.includes(file))) {
    diagnostics.push('gemini_extension_contains_unexpected_file')
    repairable = false
  }
  if (entries.directories.some(directory => !expectedDirectories.includes(directory))) {
    diagnostics.push('gemini_extension_contains_unexpected_directory')
    repairable = false
  }
  const fileHashes: Record<string, string | null> = {}
  for (const [relative, content] of Object.entries(desired.files)) {
    const inspected = inspectRegularFileWithinRoot(path.join(root, relative), root)
    if (inspected.size !== null && inspected.size > MAX_FILE_BYTES) diagnostics.push('gemini_extension_file_too_large')
    fileHashes[relative] = inspected.containerHash
    if (inspected.containerHash !== sha256Bytes(content)) diagnostics.push(`gemini_extension_file_mismatch:${relative}`)
  }
  const metadata = readInstallMetadata(path.join(root, INSTALL_METADATA))
  if (!metadata || metadata.type !== 'local' || path.resolve(metadata.source) !== path.resolve(desired.stagingRoot)) {
    diagnostics.push('gemini_extension_install_metadata_mismatch')
    repairable = false
  }
  const actualPackageHash = sha256Json(Object.entries(fileHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, hash]) => ({ relativePath, hash })))
  const exact = diagnostics.length === 0
  return {
    exists: true,
    exact,
    repairable,
    fingerprint: exact ? desired.packageHash : actualPackageHash,
    diagnostics,
  }
}

function stagePackage(context: AdapterOperationContext, desired: DesiredExtension): void {
  assertContained(desired.stagingRoot, context.runtime.applicationDataDir)
  if (fs.existsSync(desired.stagingRoot)) {
    const entries = listEntries(desired.stagingRoot)
    const expectedFiles = Object.keys(desired.files).sort()
    if (sha256Json(entries.files) !== sha256Json(expectedFiles)
      || entries.directories.some(directory => !['hooks', 'skills', path.join('skills', 'tidemind')].includes(directory))) {
      throw new Error('gemini_extension_staging_conflict')
    }
  }
  for (const [relative, content] of Object.entries(desired.files)) {
    const target = path.join(desired.stagingRoot, relative)
    ensureSafeParentDirectoryWithinRoot(target, context.runtime.applicationDataDir)
    const current = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    if (current.exists && current.containerHash !== sha256Bytes(content)) throw new Error('gemini_extension_staging_file_conflict')
    if (!current.exists) writeRegularFileAtomicCas(target, content, { expectedContainerHash: null })
  }
  if (filesFingerprint(desired.files) !== desired.packageHash) throw new Error('gemini_extension_staging_hash_mismatch')
}

function cleanupStaging(context: AdapterOperationContext, desired: DesiredExtension): void {
  assertContained(desired.stagingRoot, context.runtime.applicationDataDir)
  for (const relative of Object.keys(desired.files)) {
    const target = path.join(desired.stagingRoot, relative)
    if (!fs.existsSync(target)) continue
    const current = inspectRegularFileWithinRoot(target, context.runtime.applicationDataDir)
    if (current.containerHash !== sha256Bytes(desired.files[relative])) continue
    fs.unlinkSync(current.canonicalPath)
  }
  for (const directory of [path.join(desired.stagingRoot, 'skills', 'tidemind'), path.join(desired.stagingRoot, 'skills'), path.join(desired.stagingRoot, 'hooks'), desired.stagingRoot]) {
    try { fs.rmdirSync(directory) } catch { /* retain any unexpected content */ }
  }
}

async function verifyGeminiExtension(
  context: AdapterOperationContext,
  request: AdapterVerificationRequest,
  desired: DesiredExtension,
  dependencies: GeminiExtensionAdapterDependencies,
): Promise<readonly ComponentVerificationResult[]> {
  const requested = COMPONENTS.filter(component => request.componentKeys.includes(component))
  const current = await inspectExtension(context, desired, dependencies)
  if (request.expectedCapability === 0 && current.state === 'absent') {
    return requested.map(componentKey => ({
      componentKey,
      status: 'verified',
      verifiedCapability: 0,
      identityAssertion: context.agentId,
      invalidationKeys: ['host_version', 'adapter_version'],
      diagnostics: ['disconnect_host_readback_verified'],
    }))
  }
  if (current.state !== 'exact' || current.fingerprint !== desired.desiredHash) {
    return requested.map(componentKey => failed(componentKey, current.diagnostics[0] ?? 'gemini_extension_not_exact_and_active'))
  }
  const results: ComponentVerificationResult[] = []
  const lifecycle = requested.includes('instruction') || requested.includes('lifecycle')
    ? await verifyHostActivity(context, request, {
        componentKey: 'lifecycle',
        signalNames: GEMINI_REQUIRED_LIFECYCLE_SIGNALS,
        require: 'all',
      })
    : undefined
  if (requested.includes('instruction')) {
    results.push(lifecycle?.status === 'verified'
      ? { ...lifecycle, componentKey: 'instruction', verifiedCapability: 1, diagnostics: ['extension_context_loaded', ...lifecycle.diagnostics] }
      : staticUnverified('instruction', desired.desiredHash, lifecycle?.diagnostics ?? []))
  }
  if (requested.includes('memory_tools')) {
    const memory = await verifyMemoryReadWriteActivity(context, request)
    results.push(memory.status === 'verified' ? memory : staticUnverified('memory_tools', desired.desiredHash, memory.diagnostics))
  }
  if (requested.includes('lifecycle')) {
    results.push(lifecycle?.status === 'verified'
      ? lifecycle
      : staticUnverified('lifecycle', desired.desiredHash, lifecycle?.diagnostics ?? []))
  }
  return results
}

function assertFrozenMutation(
  context: AdapterOperationContext,
  mutation: PlannedMutation,
  metadata: GeminiMutationMetadata,
  desired: DesiredExtension,
): void {
  if (mutation.operation !== 'host_command') throw new Error('gemini_extension_requires_host_command')
  if (metadata.extensionName !== desired.name
    || metadata.extensionVersion !== desired.version
    || metadata.stagingRoot !== desired.stagingRoot
    || metadata.installedRoot !== desired.installedRoot
    || metadata.packageHash !== desired.packageHash
    || filesFingerprint(metadata.desiredFiles) !== desired.packageHash
    || metadata.desiredHash !== (metadata.kind === 'uninstall' ? null : desired.desiredHash)) {
    throw new Error('gemini_extension_frozen_package_changed')
  }
  const expected = commandsFor(metadata.kind, context, desired)
  const actual = frozenCommands(mutation)
  if (sha256Json(actual) !== sha256Json(expected)) throw new Error('gemini_extension_frozen_commands_changed')
  if (sha256Json([...(mutation.coveredComponentKeys ?? [])].sort()) !== sha256Json([...COMPONENTS].sort())) {
    throw new Error('gemini_extension_component_coverage_changed')
  }
}

function frozenCommands(mutation: PlannedMutation): FrozenHostCommand[] {
  if (mutation.frozenCommands) return mutation.frozenCommands.map(command => ({ ...command, args: [...command.args] }))
  if (mutation.executableRealpath && mutation.args) return [{
    category: mutation.commandCategory === 'host_cli' ? 'host_cli' : 'plugin_install',
    executableRealpath: mutation.executableRealpath,
    args: [...mutation.args],
  }]
  throw new Error('gemini_extension_frozen_command_missing')
}

function parseMetadata(mutation: PlannedMutation): GeminiMutationMetadata {
  const value = mutation.metadata as unknown as Partial<GeminiMutationMetadata> | undefined
  if (!value
    || value.artifactType !== 'plugin'
    || !['install', 'repair', 'enable', 'uninstall'].includes(value.kind ?? '')
    || typeof value.extensionName !== 'string'
    || typeof value.extensionVersion !== 'string'
    || typeof value.stagingRoot !== 'string'
    || typeof value.installedRoot !== 'string'
    || typeof value.packageHash !== 'string'
    || (value.beforeHash !== null && typeof value.beforeHash !== 'string')
    || (value.desiredHash !== null && typeof value.desiredHash !== 'string')
    || typeof value.absentHash !== 'string'
    || !value.desiredFiles || typeof value.desiredFiles !== 'object') {
    throw new Error(`invalid_gemini_extension_metadata:${mutation.operationId}`)
  }
  return value as GeminiMutationMetadata
}

function baselineFor(
  baselines: readonly OwnedArtifactBaseline[],
  componentKey: ComponentKey,
  target: string,
  ownershipKey: string,
): OwnedArtifactBaseline | undefined {
  return baselines.find(baseline => baseline.componentKey === componentKey
    && path.resolve(baseline.physicalTarget) === path.resolve(target)
    && baseline.ownershipKey === ownershipKey)
}

function exactAggregateBaseline(values: readonly (OwnedArtifactBaseline | undefined)[]): string | null {
  if (values.every(value => value === undefined)) return null
  if (values.some(value => value === undefined)) return null
  const hashes = new Set(values.map(value => value!.ownedFragmentHash))
  return hashes.size === 1 ? values[0]!.ownedFragmentHash : null
}

function manageableDistribution(context: AdapterOperationContext): { ok: true } | { ok: false; reason: string } {
  const executable = context.installation.distribution.executableRealpath
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
    return { ok: false, reason: 'gemini_executable_realpath_unproven' }
  }
  if (context.installation.distribution.packageProvenance !== OFFICIAL_PROVENANCE) {
    return { ok: false, reason: 'gemini_official_npm_distribution_unproven' }
  }
  return { ok: true }
}

function executableExists(context: AdapterOperationContext): boolean {
  const executable = context.installation.distribution.executableRealpath
  return Boolean(executable && path.isAbsolute(executable) && fs.existsSync(executable))
}

function extensionName(agentId: string): string {
  const stem = agentId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent'
  return `tidemind-${stem}-${sha256Bytes(agentId).slice(0, 8)}`
}

function extensionOwnershipKey(desired: DesiredExtension): string {
  return `gemini-extension:${desired.name}`
}

function renderContext(context: AdapterOperationContext): string {
  return `# Tide Mind\n\nTide Mind 外部记忆已为当前 Gemini CLI 身份 \`${context.agentId}\` 接入。\n\n- 新会话开始时优先调用 \`brain_prepare\` 获取用户上下文。\n- 回答依赖历史背景、既往决策或偏好时调用 \`brain_recall\`。\n- 产生重要决策、事实、偏好、纠正或后续行动时调用 \`brain_digest\`。\n- 工具不可用时明确说明，不能假装已经查询或保存。\n\n<!-- tidemind-agent=${context.agentId};host=${context.installation.hostVariant};version=${context.runtime.tideMindVersion};projection=${context.runtime.projectionVersion} -->\n`
}

function renderSkill(): string {
  return `---\nname: tidemind\ndescription: Prepare, recall, and persist durable user context through Tide Mind.\n---\n\n# Tide Mind\n\nUse \`brain_prepare\` at session start, \`brain_recall\` when prior context matters, and \`brain_digest\` for durable facts and decisions. Never claim a memory operation succeeded when the tool is unavailable.\n`
}

function filesFingerprint(files: Readonly<Record<string, string>>): string {
  return sha256Json(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({ relativePath, hash: sha256Bytes(content) })))
}

function installedStateHash(input: {
  name: string
  version: string | null
  installedRoot: string | null
  stagingRoot: string
  packageHash: string | null
  active: boolean | null
}): string {
  return sha256Json({
    name: input.name,
    version: input.version,
    installedRoot: input.installedRoot === null ? null : path.resolve(input.installedRoot),
    installMetadata: { source: path.resolve(input.stagingRoot), type: 'local' },
    packageHash: input.packageHash,
  })
}

function parseExtensionList(stdout: string): { ok: true; extensions: ListedExtension[] } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return { ok: false, reason: 'gemini_extensions_list_json_invalid' }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'gemini_extensions_list_not_array' }
  const extensions: ListedExtension[] = []
  for (const item of parsed) {
    const record = asObject(item)
    if (!record || typeof record.name !== 'string') return { ok: false, reason: 'gemini_extensions_list_entry_invalid' }
    extensions.push({
      name: record.name,
      version: typeof record.version === 'string' ? record.version : undefined,
      path: typeof record.path === 'string' ? record.path : undefined,
      isActive: typeof record.isActive === 'boolean' ? record.isActive : undefined,
    })
  }
  return { ok: true, extensions }
}

function readInstallMetadata(filePath: string): { source: string; type: string } | null {
  try {
    const record = asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    return record && typeof record.source === 'string' && typeof record.type === 'string'
      ? { source: record.source, type: record.type }
      : null
  } catch {
    return null
  }
}

function listEntries(root: string): { files: string[]; directories: string[] } {
  const files: string[] = []
  const directories: string[] = []
  const queue = ['']
  let count = 0
  while (queue.length) {
    const relativeRoot = queue.shift()!
    for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
      count++
      if (count > MAX_ENTRIES) throw new Error('gemini_extension_too_many_entries')
      const relative = path.join(relativeRoot, entry.name)
      if (entry.isSymbolicLink()) throw new Error('gemini_extension_symlink_rejected')
      if (entry.isDirectory()) {
        directories.push(relative)
        queue.push(relative)
      } else if (entry.isFile()) files.push(relative)
      else throw new Error('gemini_extension_non_regular_entry')
    }
  }
  return { files: files.sort(), directories: directories.sort() }
}

function geminiEnvironment(context: AdapterOperationContext, executable: string): Record<string, string> {
  return {
    HOME: context.runtime.homeDir,
    GEMINI_CLI_HOME: path.dirname(context.installation.canonicalConfigRoot),
    PATH: [path.dirname(executable), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
  }
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertContained(target: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`gemini_extension_path_outside_root:${target}`)
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function bounded(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

function failed(componentKey: ComponentKey, diagnostic: string): ComponentVerificationResult {
  return {
    componentKey,
    status: 'failed',
    verifiedCapability: null,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
    diagnostics: [diagnostic],
  }
}

function staticUnverified(
  componentKey: ComponentKey,
  evidenceHash: string,
  diagnostics: readonly string[],
): ComponentVerificationResult {
  return {
    componentKey,
    status: 'unverified',
    verifiedCapability: null,
    evidenceHash,
    invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version', 'projection_version', 'tide_mind_version', 'activity_freshness'],
    diagnostics: ['static_readback_passed', ...diagnostics],
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
