import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { scanTomlTableHeaders } from '../../ipc/toml-utils'
import { sha256Bytes, sha256Json } from '../fingerprint'
import { verifyMemoryReadWriteActivity } from '../host-activity-evidence'
import {
  ensureSafeParentDirectoryWithinRoot,
  inspectRegularFileWithinRoot,
  writeRegularFileAtomicCas,
  type FileFingerprint,
} from '../safe-file'
import type {
  AdoptableArtifactObservation,
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AdapterVerificationRequest,
  AgentHostAdapter,
  ComponentVerificationResult,
  JsonValue,
  MutationReadBack,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../types'

export type CodexMcpCatalogId = 'codex-cli' | 'codex-desktop'

export interface CodexMcpTomlHostSpec {
  catalogId: CodexMcpCatalogId
  adapterVersion: string
}

interface TomlTableBlock {
  start: number
  end: number
  text: string
  hash: string
  entry: JsonValue
}

interface TomlInspection {
  file: FileFingerprint
  source: string
  block?: TomlTableBlock
}

interface CodexMcpMutationMetadata {
  canonicalPath: string
  containerPreconditionHash: string | null
  liveFragmentHash: string | null
  desiredBlock?: string
  remove: boolean
}

const COMPONENT_KEY = 'memory_tools' as const
const SELECTOR_SCHEMA_VERSION = 1

/**
 * Maintains exactly one [mcp_servers.tidemind-<agentId>] table. CLI and
 * Desktop resolve to the same frozen config.toml physical target, allowing
 * the coordinator's writer fence and Ownership Ledger to serialize both.
 */
export function createCodexMcpTomlHostAdapter(spec: CodexMcpTomlHostSpec): AgentHostAdapter {
  const inspect = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const target = configFile(context)
    try {
      const projection = inspectToml(context)
      return {
        catalogId: spec.catalogId,
        detected: defaultDetected(context, target),
        distribution: { ...context.installation.distribution },
        components: [{
          componentKey: COMPONENT_KEY,
          visibility: projection.block ? 'dedicated' : 'absent',
          verificationStatus: 'unverified',
          observedTarget: projection.file.canonicalPath,
          observedFragmentHash: projection.block?.hash,
        }],
        provenance: [target],
        diagnostics: [],
      }
    } catch (error) {
      return {
        catalogId: spec.catalogId,
        detected: defaultDetected(context, target),
        distribution: { ...context.installation.distribution },
        components: [{
          componentKey: COMPONENT_KEY,
          visibility: 'unknown',
          verificationStatus: 'unverified',
          observedTarget: target,
        }],
        provenance: [target],
        diagnostics: [errorMessage(error)],
      }
    }
  }

  const buildPlan = (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    remove: boolean,
  ): AdapterPlan => {
    const base: Omit<AdapterPlan, 'mutations' | 'diagnostics'> = {
      catalogId: spec.catalogId,
      installationKey: context.installation.installKey,
      adapterVersion: spec.adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      requiredUserActions: request.desiredComponents
        .filter(component => component !== COMPONENT_KEY)
        .map(component => `component_requires_other_projection:${component}`),
    }
    if (!request.desiredComponents.includes(COMPONENT_KEY)) {
      return { ...base, mutations: [], diagnostics: ['memory_tools_not_requested'] }
    }
    if (!request.observed.detected) {
      return { ...base, mutations: [], diagnostics: ['host_not_detected'] }
    }

    let projection: TomlInspection
    try {
      projection = inspectToml(context)
    } catch (error) {
      return { ...base, mutations: [], diagnostics: [errorMessage(error)] }
    }
    const baseline = ownedBaseline(context, request.ownedArtifacts)
    const desiredBlock = renderServerBlock(context)
    const desiredHash = sha256Bytes(desiredBlock)
    const action = planAction({
      remove,
      liveHash: projection.block?.hash ?? null,
      desiredHash,
      ownedHash: baseline?.ownedFragmentHash ?? null,
    })
    if (action.kind === 'conflict') {
      return { ...base, mutations: [], diagnostics: [action.reason] }
    }
    if (action.kind === 'noop') return { ...base, mutations: [], diagnostics: [] }

    const metadata: CodexMcpMutationMetadata = {
      canonicalPath: projection.file.canonicalPath,
      containerPreconditionHash: projection.file.containerHash,
      liveFragmentHash: projection.block?.hash ?? null,
      ...(remove ? {} : { desiredBlock }),
      remove,
    }
    return {
      ...base,
      mutations: [{
        operationId: `${context.operationId}:memory_tools`,
        componentKey: COMPONENT_KEY,
        operation: action.kind,
        domainKind: 'file_fragment',
        physicalTarget: configFile(context),
        ownershipKey: ownershipKey(context),
        selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
        risk: 'low',
        reload: 'new_session',
        commandCategory: 'file_write',
        preconditionHash: projection.block?.hash,
        containerPreconditionHash: projection.file.containerHash ?? undefined,
        desiredFragmentHash: remove ? undefined : desiredHash,
        idempotent: true,
        metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
      }],
      diagnostics: [],
    }
  }

  return {
    catalogId: spec.catalogId,
    adapterVersion: spec.adapterVersion,
    componentKeys: [COMPONENT_KEY],
    implementationTypes: { memory_tools: ['mcp'] },
    componentContracts: {
      memory_tools: {
        deliveryMode: 'managed', artifactTypes: ['mcp'], mutationDomain: 'file_fragment', reload: 'new_session',
      },
    },
    inspect,
    async inspectAdoptableArtifacts(context): Promise<readonly AdoptableArtifactObservation[]> {
      try {
        const projection = inspectToml(context)
        if (!projection.block || !isExactAdoptableEntry(projection.block.entry, context)) return []
        return [{
          componentKey: COMPONENT_KEY,
          artifactType: 'mcp',
          domainKind: 'file_fragment',
          physicalTarget: projection.file.canonicalPath,
          ownershipKey: ownershipKey(context),
          selectorSchemaVersion: SELECTOR_SCHEMA_VERSION,
          projectionVersion: context.runtime.projectionVersion,
          containerHash: projection.file.containerHash ?? undefined,
          fragmentHash: projection.block.hash,
          identityAssertion: context.agentId,
          discoverReachability: 'dedicated',
        }]
      } catch {
        return []
      }
    },
    async plan(context, request) {
      return buildPlan(context, request, false)
    },
    async disconnect(context, request) {
      return buildPlan(context, {
        desiredCapability: 0,
        desiredComponents: request.componentKeys,
        observed: request.observed,
        ownedArtifacts: request.ownedArtifacts,
      }, true)
    },
    async apply(context, mutation) {
      assertMutation(context, mutation)
      const metadata = parseMetadata(mutation)
      const current = inspectToml(context)
      if (current.file.canonicalPath !== metadata.canonicalPath) {
        throw new CodexMcpTomlConflictError('container_canonical_path_changed')
      }
      if (current.file.containerHash !== metadata.containerPreconditionHash) {
        throw new CodexMcpTomlConflictError('container_precondition_changed')
      }
      if ((current.block?.hash ?? null) !== metadata.liveFragmentHash) {
        throw new CodexMcpTomlConflictError('fragment_precondition_changed')
      }

      const desiredDocument = mutateDocument(current, metadata)
      assertValidToml(desiredDocument, 'desired_codex_mcp_document_invalid')
      ensureSafeParentDirectoryWithinRoot(mutation.physicalTarget, context.installation.canonicalConfigRoot)
      writeRegularFileAtomicCas(mutation.physicalTarget, desiredDocument, {
        expectedCanonicalPath: metadata.canonicalPath,
        expectedContainerHash: metadata.containerPreconditionHash,
      })
      const after = inspectToml(context)
      const expectedHash = metadata.remove ? null : (mutation.desiredFragmentHash ?? null)
      if ((after.block?.hash ?? null) !== expectedHash) {
        throw new CodexMcpTomlConflictError('fragment_read_back_mismatch')
      }
      return {
        operationId: mutation.operationId,
        effectObserved: true,
        postEffectFingerprint: after.block?.hash,
        hostReceipt: {
          canonicalPath: after.file.canonicalPath,
          containerHash: after.file.containerHash,
        },
      }
    },
    async readBack(context, mutation): Promise<MutationReadBack> {
      const metadata = parseMetadata(mutation)
      try {
        const after = inspectToml(context)
        const expectedHash = metadata.remove ? null : (mutation.desiredFragmentHash ?? null)
        return {
          operationId: mutation.operationId,
          observed: after.block !== undefined,
          matchesDesired: (after.block?.hash ?? null) === expectedHash,
          observedFragmentHash: after.block?.hash,
          visibility: after.block ? 'dedicated' : 'absent',
          diagnostics: [],
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
    async verify(context, request: AdapterVerificationRequest): Promise<readonly ComponentVerificationResult[]> {
      if (!request.componentKeys.includes(COMPONENT_KEY)) return []
      const current = await inspect(context)
      const memory = current.components.find(component => component.componentKey === COMPONENT_KEY)
      if (request.expectedCapability === 0 && memory?.visibility === 'absent') {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'verified',
          verifiedCapability: 0,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['disconnect_static_readback_verified'],
        }]
      }
      if (memory?.visibility !== 'dedicated') {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'failed',
          verifiedCapability: null,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: current.diagnostics.length > 0
            ? current.diagnostics
            : ['managed_mcp_fragment_not_visible'],
        }]
      }
      const desiredHash = sha256Bytes(renderServerBlock(context))
      if (memory.observedFragmentHash !== desiredHash) {
        return [{
          componentKey: COMPONENT_KEY,
          status: 'failed',
          verifiedCapability: null,
          evidenceHash: memory.observedFragmentHash,
          identityAssertion: context.agentId,
          invalidationKeys: ['artifact_hash', 'host_version', 'adapter_version'],
          diagnostics: ['managed_mcp_fragment_drifted_from_current_desired'],
        }]
      }
      const activity = await verifyMemoryReadWriteActivity(context, request)
      if (activity.status === 'unverified') {
        return [{
          ...activity,
          evidenceHash: memory.observedFragmentHash,
          identityAssertion: context.agentId,
          diagnostics: ['static_readback_passed', ...activity.diagnostics],
        }]
      }
      return [activity]
    },
  }
}

export class CodexMcpTomlConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexMcpTomlConflictError'
  }
}

function inspectToml(context: AdapterOperationContext): TomlInspection {
  const file = inspectRegularFileWithinRoot(configFile(context), context.installation.canonicalConfigRoot)
  if (!file.exists) return { file, source: '' }
  const source = fs.readFileSync(file.canonicalPath, 'utf8')
  const document = assertValidToml(source, 'codex_config_toml_malformed')
  const key = tableKey(context)
  const headers = scanTomlTableHeaders(source)
  const matching = headers.filter(header => !header.array && header.key === key)
  if (matching.length > 1) throw new CodexMcpTomlConflictError('duplicate_tidemind_codex_mcp_tables')
  if (matching.length === 0) return { file, source }

  const startHeader = matching[0]
  const startIndex = headers.indexOf(startHeader)
  let end = source.split('\n').length
  for (let index = startIndex + 1; index < headers.length; index++) {
    const candidate = headers[index]
    if (candidate.key.startsWith(`${key}.`)) continue
    end = candidate.line
    break
  }
  const lines = source.split('\n')
  const text = normalizeOwnedBlock(lines.slice(startHeader.line, end).join('\n'))
  const servers = asObject(document.mcp_servers)
  const entry = servers?.[serverName(context)]
  if (entry === undefined) throw new CodexMcpTomlConflictError('codex_mcp_table_projection_missing')
  return {
    file,
    source,
    block: { start: startHeader.line, end, text, hash: sha256Bytes(text), entry },
  }
}

function mutateDocument(current: TomlInspection, metadata: CodexMcpMutationMetadata): string {
  const lines = current.source.split('\n')
  if (metadata.remove) {
    if (!current.block) return current.source
    lines.splice(current.block.start, current.block.end - current.block.start)
    return normalizeDocument(lines.join('\n'))
  }
  if (!metadata.desiredBlock) throw new CodexMcpTomlConflictError('desired_mcp_block_missing')
  if (current.block) {
    lines.splice(
      current.block.start,
      current.block.end - current.block.start,
      ...metadata.desiredBlock.split('\n'),
    )
    return normalizeDocument(lines.join('\n'))
  }
  const prefix = current.source.length === 0 ? '' : `${current.source.trimEnd()}\n\n`
  return `${prefix}${metadata.desiredBlock}\n`
}

function normalizeOwnedBlock(value: string): string {
  return `${value.trimEnd()}\n`
}

function normalizeDocument(value: string): string {
  const trimmed = value.replace(/^\n+/u, '').trimEnd()
  return trimmed.length === 0 ? '' : `${trimmed}\n`
}

function assertValidToml(source: string, code: string): Record<string, JsonValue> {
  try {
    const parsed = parseToml(source) as unknown
    const record = asObject(parsed)
    if (!record) throw new Error('root_not_object')
    return JSON.parse(JSON.stringify(record)) as Record<string, JsonValue>
  } catch (error) {
    throw new CodexMcpTomlConflictError(`${code}:${errorMessage(error)}`)
  }
}

function renderServerBlock(context: AdapterOperationContext): string {
  const entry = desiredEntry(context) as Record<string, JsonValue>
  const args = (entry.args as readonly string[]).map(tomlString).join(', ')
  const environment = entry.env as Record<string, string>
  const env = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')
  return normalizeOwnedBlock([
    `[${tableKey(context)}]`,
    'enabled = true',
    `command = ${tomlString(entry.command as string)}`,
    `args = [${args}]`,
    `env = { ${env} }`,
  ].join('\n'))
}

function desiredEntry(context: AdapterOperationContext): JsonValue {
  return {
    enabled: true,
    command: context.runtime.shimPath,
    args: [context.runtime.mcpServerPath],
    env: {
      EB_AGENT_ID: context.agentId,
      EB_HOST_VARIANT: context.installation.hostVariant,
      ...(context.activityGenerationToken ? { EB_ACTIVITY_GENERATION_TOKEN: context.activityGenerationToken } : {}),
    },
  }
}

function isExactAdoptableEntry(entry: JsonValue, context: AdapterOperationContext): boolean {
  const desired = desiredEntry(context)
  if (sha256Json(entry) === sha256Json(desired)) return true
  const desiredRecord = desired as Record<string, JsonValue>
  const legacyEnvironment = { ...(desiredRecord.env as Record<string, JsonValue>) }
  delete legacyEnvironment.EB_HOST_VARIANT
  return sha256Json(entry) === sha256Json({ ...desiredRecord, env: legacyEnvironment })
}

function planAction(input: {
  remove: boolean
  liveHash: string | null
  desiredHash: string
  ownedHash: string | null
}): { kind: 'create' | 'update' | 'remove' | 'noop' } | { kind: 'conflict'; reason: string } {
  if (input.remove) {
    if (input.liveHash === null) return { kind: 'noop' }
    if (input.ownedHash === null || input.liveHash !== input.ownedHash) {
      return { kind: 'conflict', reason: 'remove_requires_exact_owned_mcp_table' }
    }
    return { kind: 'remove' }
  }
  if (input.liveHash === input.desiredHash) {
    return input.ownedHash === null
      ? { kind: 'conflict', reason: 'matching_mcp_table_has_no_ownership_evidence' }
      : { kind: 'noop' }
  }
  if (input.liveHash === null) return { kind: 'create' }
  if (input.ownedHash === null) return { kind: 'conflict', reason: 'mcp_table_already_occupied' }
  if (input.liveHash !== input.ownedHash) return { kind: 'conflict', reason: 'owned_mcp_table_modified' }
  return { kind: 'update' }
}

function ownedBaseline(
  context: AdapterOperationContext,
  baselines: readonly OwnedArtifactBaseline[],
): OwnedArtifactBaseline | undefined {
  const target = configFile(context)
  return baselines.find(artifact => artifact.componentKey === COMPONENT_KEY
    && path.resolve(artifact.physicalTarget) === path.resolve(target)
    && artifact.ownershipKey === ownershipKey(context))
}

function parseMetadata(mutation: PlannedMutation): CodexMcpMutationMetadata {
  const metadata = mutation.metadata as Partial<CodexMcpMutationMetadata> | undefined
  if (!metadata
    || typeof metadata.canonicalPath !== 'string'
    || !(metadata.containerPreconditionHash === null || typeof metadata.containerPreconditionHash === 'string')
    || !(metadata.liveFragmentHash === null || typeof metadata.liveFragmentHash === 'string')
    || typeof metadata.remove !== 'boolean'
    || (!metadata.remove && typeof metadata.desiredBlock !== 'string')) {
    throw new CodexMcpTomlConflictError('invalid_codex_mcp_mutation_metadata')
  }
  return metadata as CodexMcpMutationMetadata
}

function assertMutation(context: AdapterOperationContext, mutation: PlannedMutation): void {
  if (mutation.componentKey !== COMPONENT_KEY
    || mutation.domainKind !== 'file_fragment'
    || path.resolve(mutation.physicalTarget) !== path.resolve(configFile(context))
    || mutation.ownershipKey !== ownershipKey(context)
    || (mutation.operation !== 'create' && mutation.operation !== 'update' && mutation.operation !== 'remove')) {
    throw new CodexMcpTomlConflictError('mutation_not_owned_by_codex_mcp_adapter')
  }
}

function configFile(context: AdapterOperationContext): string {
  return context.installation.componentConfigFiles?.memory_tools
    ?? path.join(context.installation.canonicalConfigRoot, 'config.toml')
}

function serverName(context: AdapterOperationContext): string {
  return `tidemind-${context.agentId}`
}

function tableKey(context: AdapterOperationContext): string {
  return `mcp_servers.${serverName(context)}`
}

function ownershipKey(context: AdapterOperationContext): string {
  return tableKey(context)
}

function defaultDetected(context: AdapterOperationContext, target: string): boolean {
  const executable = context.installation.distribution.executableRealpath
  return fs.existsSync(context.installation.canonicalConfigRoot)
    || fs.existsSync(target)
    || (executable !== undefined && fs.existsSync(executable))
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/gu, '\\u007F')
}

function asObject(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
