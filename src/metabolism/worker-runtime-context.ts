import type { AppConfig } from '../types.js'
import type { ParsedStrategy } from '../strategy/loader.js'

export interface WorkerRuntimeConnectionSnapshot {
  readonly id: string
  readonly name: string
  readonly providerType: string
  readonly archived: boolean
  readonly status: string
  readonly statusReason: string | null
  readonly candidateModels: string | null
  readonly availableModels: string | null
  readonly validationFingerprint: string | null
  readonly authFingerprint: string | null
  readonly modelValidationJson: string | null
  readonly credentials: Readonly<Record<string, string>>
}

export interface InstalledMetabolismWorkerRuntimeContext {
  readonly runtimeRevision: number
  readonly config: AppConfig
  readonly connections: ReadonlyMap<string, WorkerRuntimeConnectionSnapshot>
  readonly strategies: ReadonlyMap<string, ParsedStrategy>
  readonly credentials: Readonly<Record<string, unknown>>
  readonly dataDir: string
}

let installed: InstalledMetabolismWorkerRuntimeContext | null = null

function invalid(label: string): never {
  throw new TypeError(`invalid installed metabolism worker runtime ${label}`)
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(label)
  return value as Record<string, unknown>
}

export function installMetabolismWorkerRuntimeContext(input: {
  runtimeRevision: number
  config: unknown
  connectionSnapshot: unknown
  strategySnapshot: unknown
  credentials: unknown
  dataDir: string
}): InstalledMetabolismWorkerRuntimeContext {
  if (installed) throw new Error('metabolism worker runtime context already installed')
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 1) invalid('revision')
  if (typeof input.dataDir !== 'string' || input.dataDir.length < 1) invalid('data dir')
  const config = plainRecord(input.config, 'config') as unknown as AppConfig
  if (!config.general || config.general.data_dir !== input.dataDir || !config.metabolism || !config.llm || !config.embedding) invalid('config')

  const connectionContainer = plainRecord(input.connectionSnapshot, 'connections')
  if (!Array.isArray(connectionContainer.connections)) invalid('connections')
  const connections = new Map<string, WorkerRuntimeConnectionSnapshot>()
  for (const raw of connectionContainer.connections) {
    const row = plainRecord(raw, 'connection')
    if (
      typeof row.id !== 'string'
      || typeof row.name !== 'string'
      || typeof row.providerType !== 'string'
      || typeof row.archived !== 'boolean'
      || typeof row.status !== 'string'
      || !['string', 'object'].includes(typeof row.statusReason)
      || !['string', 'object'].includes(typeof row.candidateModels)
      || !['string', 'object'].includes(typeof row.availableModels)
      || !['string', 'object'].includes(typeof row.validationFingerprint)
      || !['string', 'object'].includes(typeof row.authFingerprint)
      || !['string', 'object'].includes(typeof row.modelValidationJson)
      || [row.statusReason, row.candidateModels, row.availableModels, row.validationFingerprint, row.authFingerprint, row.modelValidationJson]
        .some(value => value !== null && typeof value !== 'string')
    ) invalid('connection')
    const credentials = plainRecord(row.credentials, 'connection credentials')
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value !== 'string') invalid('connection credentials')
      normalized[key] = value
    }
    if (connections.has(row.id)) invalid('duplicate connection')
    connections.set(row.id, Object.freeze({
      id: row.id,
      name: row.name,
      providerType: row.providerType,
      archived: row.archived,
      status: row.status,
      statusReason: row.statusReason,
      candidateModels: row.candidateModels,
      availableModels: row.availableModels,
      validationFingerprint: row.validationFingerprint,
      authFingerprint: row.authFingerprint,
      modelValidationJson: row.modelValidationJson,
      credentials: Object.freeze(normalized),
    } as WorkerRuntimeConnectionSnapshot))
  }

  const strategyContainer = plainRecord(input.strategySnapshot, 'strategies')
  const strategies = new Map<string, ParsedStrategy>()
  for (const [name, raw] of Object.entries(strategyContainer)) {
    const row = plainRecord(raw, 'strategy')
    if (row.name !== name || !Number.isSafeInteger(row.version) || typeof row.status !== 'string' || typeof row.params !== 'object' || row.params === null) invalid('strategy')
    strategies.set(name, row as unknown as ParsedStrategy)
  }
  const credentialSnapshot = plainRecord(input.credentials, 'credentials')
  installed = Object.freeze({
    runtimeRevision: input.runtimeRevision,
    config,
    connections,
    strategies,
    credentials: credentialSnapshot,
    dataDir: input.dataDir,
  })
  return installed
}

export function getMetabolismWorkerRuntimeContext(): InstalledMetabolismWorkerRuntimeContext | null {
  return installed
}

export function getMetabolismWorkerConnectionSnapshot(connectionId: string): WorkerRuntimeConnectionSnapshot | null {
  return installed?.connections.get(connectionId) ?? null
}

export function getMetabolismWorkerVertexCredential(connectionId?: string): Readonly<Record<string, string>> | null {
  if (!installed) return null
  const container = installed.credentials
  const raw = connectionId === undefined
    ? container.legacyVertex
    : plainRecord(container.vertexFiles, 'vertex credential files')[connectionId] ?? container.legacyVertex
  if (raw === null || raw === undefined) return null
  const record = plainRecord(raw, 'vertex credential')
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') invalid('vertex credential')
    normalized[key] = value
  }
  return Object.freeze(normalized)
}

export function clearMetabolismWorkerRuntimeContext(): void {
  installed = null
}
