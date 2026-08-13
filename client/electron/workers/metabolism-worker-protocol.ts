import { types as utilTypes } from 'node:util'

export const METABOLISM_WORKER_PROTOCOL_VERSION = 1 as const

export type SchedulerWorkerMode = 'foreground' | 'background' | 'paused'
export type SchedulerWorkerCadence = 'active' | 'idle'
export type SchedulerWorkerTriggerReason = 'initial' | 'interval' | 'resume' | 'immediate'

export type PlainJson = null | boolean | number | string | readonly PlainJson[] | Readonly<{ [key: string]: PlainJson }>

export interface MetabolismWorkerBootstrapV1 {
  protocolVersion: 1
  lifecycleGeneration: number
  startupAuthority: {
    controllerReceiptId: string
    dataScopeFingerprint: string
    controllerGeneration: number
  }
  databaseIdentity: {
    canonicalRealPath: string
    deviceId: string
    inodeId: string
    identityCommitment: string
  }
  expectedSchemaVersion: number
  runtimeRevision: number
  runtimeConfigSnapshot: Readonly<Record<string, PlainJson>>
  runtimeConnectionSnapshot: Readonly<Record<string, PlainJson>>
  strategySnapshot: Readonly<Record<string, PlainJson>>
  strategySourceFingerprint: string
  externalRuntimeSourceFingerprint: string
  credentialSnapshot: Readonly<Record<string, PlainJson>>
  authorizedRoots: { dataDir: string }
  vecCapability: 'ready' | 'unavailable'
}

export type MainToMetabolismWorkerMessage =
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'set_schedule_context'; mode: SchedulerWorkerMode; cadence: SchedulerWorkerCadence; revision: number }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'trigger'; reason: SchedulerWorkerTriggerReason }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'drain_for_restart' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'shutdown' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'structure_holes_result'; requestId: string; holes: readonly PlainJson[] }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'structure_holes_failed'; requestId: string; errorKind: 'busy' | 'failed' | 'cancelled' }

export type WorkerTaskPurpose = 'scheduler_task' | 'llm' | 'embedding' | 'cli'

export interface SanitizedWorkerError {
  code: string
  phase: string
  retryable: boolean
}

export type MetabolismWorkerToMainMessage =
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'ready'; runtimeRevision: number; databaseIdentityCommitment: string; vecCapability: 'ready' | 'unavailable' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'idle' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'stopped'; reason: 'restart' | 'shutdown' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'fatal'; error: SanitizedWorkerError }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'scheduler_pass_started' | 'scheduler_pass_finished'; executionThreadId: number }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'scheduler_sqlite_contention'; reason: 'busy_deferred' | 'busy_task_failure' | 'locked_task_failure' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'task_started' | 'task_finished'; taskId: string }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'task_failed'; taskId: string; error: SanitizedWorkerError }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'active_llm_task_started'; taskId: string; origin: 'scheduler-worker'; purpose: WorkerTaskPurpose; tier: 'light' | 'standard' | 'heavy'; connectionId: string | null }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'active_llm_task_cleared'; taskId: string; origin: 'scheduler-worker'; purpose: WorkerTaskPurpose }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'health_changed'; scope: 'llm' | 'embedding' }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'runtime_snapshot_invalidated'; changeKind: 'strategy' | 'credential' | 'connection'; sourceFingerprint: string }
  | { protocolVersion: 1; lifecycleGeneration: number; kind: 'structure_holes_request'; requestId: string; limit?: number }

const HASH = /^[a-f0-9]{64}$/
const MAX_STRING = 4096
const MAX_SNAPSHOT_STRING = 1_000_000
const MAX_JSON_DEPTH = 32

function fail(label: string): never {
  throw new TypeError(`invalid metabolism worker ${label}`)
}

function plainDataObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) fail(label)
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(label)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || descriptor.get || descriptor.set) fail(label)
  }
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = plainDataObject(value, label)
  const actual = Object.keys(row).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(label)
  return row
}

function stringValue(value: unknown, label: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) fail(label)
  return value
}

function hashValue(value: unknown, label: string): string {
  const result = stringValue(value, label, 64)
  if (!HASH.test(result)) fail(label)
  return result
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(label)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(label)
  return value as number
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(label)
  return value as T
}

function snapshotJson(value: unknown, label: string, seen: Set<object>, depth = 0): PlainJson {
  if (depth > MAX_JSON_DEPTH) fail(label)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_SNAPSHOT_STRING) fail(label)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(label)
    return value
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) fail(label)
  if (seen.has(value)) fail(label)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || descriptor.get || descriptor.set)) fail(label)
      return Object.freeze(value.map((entry) => snapshotJson(entry, label, seen, depth + 1)))
    }
    const row = plainDataObject(value, label)
    const out: Record<string, PlainJson> = {}
    for (const key of Object.keys(row).sort()) {
      if (key.length < 1 || key.length > 256) fail(label)
      out[key] = snapshotJson(row[key], label, seen, depth + 1)
    }
    return Object.freeze(out)
  } finally {
    seen.delete(value)
  }
}

function snapshotRecord(value: unknown, label: string): Readonly<Record<string, PlainJson>> {
  const snapshot = snapshotJson(value, label, new Set())
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') fail(label)
  return snapshot as Readonly<Record<string, PlainJson>>
}

function commonMessage(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = exact(value, ['protocolVersion', 'lifecycleGeneration', 'kind', ...keys], label)
  if (row.protocolVersion !== METABOLISM_WORKER_PROTOCOL_VERSION) fail(label)
  positiveInteger(row.lifecycleGeneration, label)
  return row
}

function sanitizedError(value: unknown): SanitizedWorkerError {
  const row = exact(value, ['code', 'phase', 'retryable'], 'error')
  if (typeof row.retryable !== 'boolean') fail('error')
  return Object.freeze({
    code: stringValue(row.code, 'error', 128),
    phase: stringValue(row.phase, 'error', 128),
    retryable: row.retryable,
  })
}

export function snapshotMetabolismWorkerBootstrap(value: unknown): MetabolismWorkerBootstrapV1 {
  const row = exact(value, [
    'protocolVersion', 'lifecycleGeneration', 'startupAuthority', 'databaseIdentity',
    'expectedSchemaVersion', 'runtimeRevision', 'runtimeConfigSnapshot',
    'runtimeConnectionSnapshot', 'strategySnapshot', 'strategySourceFingerprint', 'externalRuntimeSourceFingerprint',
    'credentialSnapshot', 'authorizedRoots', 'vecCapability',
  ], 'bootstrap')
  if (row.protocolVersion !== 1) fail('bootstrap')
  const authority = exact(row.startupAuthority, ['controllerReceiptId', 'dataScopeFingerprint', 'controllerGeneration'], 'bootstrap authority')
  const database = exact(row.databaseIdentity, ['canonicalRealPath', 'deviceId', 'inodeId', 'identityCommitment'], 'database identity')
  const roots = exact(row.authorizedRoots, ['dataDir'], 'authorized roots')
  return Object.freeze({
    protocolVersion: 1,
    lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'bootstrap generation'),
    startupAuthority: Object.freeze({
      controllerReceiptId: stringValue(authority.controllerReceiptId, 'controller receipt'),
      dataScopeFingerprint: hashValue(authority.dataScopeFingerprint, 'data scope fingerprint'),
      controllerGeneration: positiveInteger(authority.controllerGeneration, 'controller generation'),
    }),
    databaseIdentity: Object.freeze({
      canonicalRealPath: stringValue(database.canonicalRealPath, 'database path'),
      deviceId: stringValue(database.deviceId, 'database device', 128),
      inodeId: stringValue(database.inodeId, 'database inode', 128),
      identityCommitment: hashValue(database.identityCommitment, 'database identity commitment'),
    }),
    expectedSchemaVersion: positiveInteger(row.expectedSchemaVersion, 'schema version'),
    runtimeRevision: positiveInteger(row.runtimeRevision, 'runtime revision'),
    runtimeConfigSnapshot: snapshotRecord(row.runtimeConfigSnapshot, 'runtime config snapshot'),
    runtimeConnectionSnapshot: snapshotRecord(row.runtimeConnectionSnapshot, 'runtime connection snapshot'),
    strategySnapshot: snapshotRecord(row.strategySnapshot, 'strategy snapshot'),
    strategySourceFingerprint: hashValue(row.strategySourceFingerprint, 'strategy fingerprint'),
    externalRuntimeSourceFingerprint: hashValue(row.externalRuntimeSourceFingerprint, 'external runtime source fingerprint'),
    credentialSnapshot: snapshotRecord(row.credentialSnapshot, 'credential snapshot'),
    authorizedRoots: Object.freeze({ dataDir: stringValue(roots.dataDir, 'data dir') }),
    vecCapability: enumValue(row.vecCapability, ['ready', 'unavailable'], 'vec capability'),
  })
}

export function snapshotMainToMetabolismWorkerMessage(value: unknown): MainToMetabolismWorkerMessage {
  const base = plainDataObject(value, 'main message')
  switch (base.kind) {
    case 'set_schedule_context': {
      const row = commonMessage(value, ['mode', 'cadence', 'revision'], 'schedule context')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'generation'), kind: 'set_schedule_context', mode: enumValue(row.mode, ['foreground', 'background', 'paused'], 'mode'), cadence: enumValue(row.cadence, ['active', 'idle'], 'cadence'), revision: positiveInteger(row.revision, 'schedule revision') })
    }
    case 'trigger': {
      const row = commonMessage(value, ['reason'], 'trigger')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'generation'), kind: 'trigger', reason: enumValue(row.reason, ['initial', 'interval', 'resume', 'immediate'], 'trigger reason') })
    }
    case 'drain_for_restart':
    case 'shutdown': {
      const row = commonMessage(value, [], base.kind)
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'generation'), kind: base.kind })
    }
    case 'structure_holes_result': {
      const row = commonMessage(value, ['requestId', 'holes'], 'structure holes result')
      const holes = snapshotJson(row.holes, 'structure holes result', new Set())
      if (!Array.isArray(holes)) fail('structure holes result')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'generation'), kind: 'structure_holes_result', requestId: stringValue(row.requestId, 'request id', 256), holes })
    }
    case 'structure_holes_failed': {
      const row = commonMessage(value, ['requestId', 'errorKind'], 'structure holes failed')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: positiveInteger(row.lifecycleGeneration, 'generation'), kind: 'structure_holes_failed', requestId: stringValue(row.requestId, 'request id', 256), errorKind: enumValue(row.errorKind, ['busy', 'failed', 'cancelled'], 'error kind') })
    }
    default: fail('main message')
  }
}

export function snapshotMetabolismWorkerToMainMessage(value: unknown): MetabolismWorkerToMainMessage {
  const base = plainDataObject(value, 'worker message')
  const generation = () => positiveInteger(base.lifecycleGeneration, 'generation')
  switch (base.kind) {
    case 'ready': {
      const row = commonMessage(value, ['runtimeRevision', 'databaseIdentityCommitment', 'vecCapability'], 'ready')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'ready', runtimeRevision: positiveInteger(row.runtimeRevision, 'runtime revision'), databaseIdentityCommitment: hashValue(row.databaseIdentityCommitment, 'database identity commitment'), vecCapability: enumValue(row.vecCapability, ['ready', 'unavailable'], 'vec capability') })
    }
    case 'idle': {
      commonMessage(value, [], 'idle')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'idle' })
    }
    case 'stopped': {
      const row = commonMessage(value, ['reason'], 'stopped')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'stopped', reason: enumValue(row.reason, ['restart', 'shutdown'], 'stop reason') })
    }
    case 'fatal': {
      const row = commonMessage(value, ['error'], 'fatal')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'fatal', error: sanitizedError(row.error) })
    }
    case 'scheduler_pass_started':
    case 'scheduler_pass_finished': {
      const row = commonMessage(value, ['executionThreadId'], base.kind)
      return Object.freeze({
        protocolVersion: 1,
        lifecycleGeneration: generation(),
        kind: base.kind,
        executionThreadId: nonNegativeInteger(row.executionThreadId, 'execution thread id'),
      })
    }
    case 'scheduler_sqlite_contention': {
      const row = commonMessage(value, ['reason'], base.kind)
      return Object.freeze({
        protocolVersion: 1,
        lifecycleGeneration: generation(),
        kind: base.kind,
        reason: enumValue(row.reason, ['busy_deferred', 'busy_task_failure', 'locked_task_failure'], 'scheduler contention reason'),
      })
    }
    case 'task_started':
    case 'task_finished': {
      const row = commonMessage(value, ['taskId'], base.kind)
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: base.kind, taskId: stringValue(row.taskId, 'task id', 256) })
    }
    case 'task_failed': {
      const row = commonMessage(value, ['taskId', 'error'], 'task failed')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'task_failed', taskId: stringValue(row.taskId, 'task id', 256), error: sanitizedError(row.error) })
    }
    case 'active_llm_task_started': {
      const row = commonMessage(value, ['taskId', 'origin', 'purpose', 'tier', 'connectionId'], base.kind)
      if (row.origin !== 'scheduler-worker') fail('active task origin')
      if (row.connectionId !== null && typeof row.connectionId !== 'string') fail('active task connection')
      return Object.freeze({
        protocolVersion: 1,
        lifecycleGeneration: generation(),
        kind: 'active_llm_task_started',
        taskId: stringValue(row.taskId, 'task id', 256),
        origin: 'scheduler-worker',
        purpose: enumValue(row.purpose, ['scheduler_task', 'llm', 'embedding', 'cli'], 'task purpose'),
        tier: enumValue(row.tier, ['light', 'standard', 'heavy'], 'active task tier'),
        connectionId: row.connectionId === null ? null : stringValue(row.connectionId, 'active task connection', 256),
      })
    }
    case 'active_llm_task_cleared': {
      const row = commonMessage(value, ['taskId', 'origin', 'purpose'], base.kind)
      if (row.origin !== 'scheduler-worker') fail('active task origin')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'active_llm_task_cleared', taskId: stringValue(row.taskId, 'task id', 256), origin: 'scheduler-worker', purpose: enumValue(row.purpose, ['scheduler_task', 'llm', 'embedding', 'cli'], 'task purpose') })
    }
    case 'health_changed': {
      const row = commonMessage(value, ['scope'], 'health changed')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'health_changed', scope: enumValue(row.scope, ['llm', 'embedding'], 'health scope') })
    }
    case 'runtime_snapshot_invalidated': {
      const row = commonMessage(value, ['changeKind', 'sourceFingerprint'], 'runtime invalidated')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'runtime_snapshot_invalidated', changeKind: enumValue(row.changeKind, ['strategy', 'credential', 'connection'], 'change kind'), sourceFingerprint: hashValue(row.sourceFingerprint, 'source fingerprint') })
    }
    case 'structure_holes_request': {
      const keys = Object.prototype.hasOwnProperty.call(base, 'limit') ? ['requestId', 'limit'] : ['requestId']
      const row = commonMessage(value, keys, 'structure holes request')
      const limit = row.limit === undefined ? undefined : positiveInteger(row.limit, 'structure holes limit')
      return Object.freeze({ protocolVersion: 1, lifecycleGeneration: generation(), kind: 'structure_holes_request', requestId: stringValue(row.requestId, 'request id', 256), ...(limit === undefined ? {} : { limit }) })
    }
    default: fail('worker message')
  }
}

export function sanitizeMetabolismWorkerError(error: unknown, phase: string): SanitizedWorkerError {
  const code = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code!
    : 'METABOLISM_WORKER_FAILED'
  return Object.freeze({ code: stringValue(code, 'error code', 128), phase: stringValue(phase, 'error phase', 128), retryable: false })
}
