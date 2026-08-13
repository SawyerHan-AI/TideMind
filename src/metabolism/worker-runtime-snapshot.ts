import crypto from 'node:crypto'
import { types as utilTypes } from 'node:util'

export type RuntimeSnapshotJson = null | boolean | number | string | readonly RuntimeSnapshotJson[] | RuntimeSnapshotObject
export interface RuntimeSnapshotObject { readonly [key: string]: RuntimeSnapshotJson }

export interface MetabolismWorkerRuntimeSnapshotSource {
  runtimeConfig: unknown
  connections: unknown
  strategy: unknown
  credentials: unknown
  authorizedRoots: { dataDir: string }
}

export interface MetabolismWorkerRuntimeSnapshot {
  readonly protocolVersion: 1
  readonly runtimeRevision: number
  readonly runtimeConfig: Readonly<Record<string, RuntimeSnapshotJson>>
  readonly connections: readonly RuntimeSnapshotJson[]
  readonly strategy: Readonly<Record<string, RuntimeSnapshotJson>>
  readonly strategySourceFingerprint: string
  readonly credentials: Readonly<Record<string, RuntimeSnapshotJson>>
  readonly authorizedRoots: { readonly dataDir: string }
  readonly commitment: string
}

const MAX_DEPTH = 32
const MAX_STRING = 1_000_000

function invalid(label: string): never {
  throw new TypeError(`invalid metabolism worker runtime snapshot ${label}`)
}

function snapshotJson(value: unknown, label: string, seen: Set<object>, depth = 0): RuntimeSnapshotJson {
  if (depth > MAX_DEPTH) invalid(label)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(label)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) invalid(label)
    return value
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) invalid(label)
  if (seen.has(value)) invalid(label)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid(label)
      return Object.freeze(value.map(item => snapshotJson(item, label, seen, depth + 1)))
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid(label)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const output: Record<string, RuntimeSnapshotJson> = {}
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]
      if (!('value' in descriptor)) invalid(label)
      output[key] = snapshotJson(descriptor.value, label, seen, depth + 1)
    }
    return Object.freeze(output)
  } finally {
    seen.delete(value)
  }
}

function record(value: unknown, label: string): Readonly<Record<string, RuntimeSnapshotJson>> {
  const result = snapshotJson(value, label, new Set())
  if (result === null || Array.isArray(result) || typeof result !== 'object') invalid(label)
  return result as Readonly<Record<string, RuntimeSnapshotJson>>
}

function array(value: unknown, label: string): readonly RuntimeSnapshotJson[] {
  const result = snapshotJson(value, label, new Set())
  if (!Array.isArray(result)) invalid(label)
  return result
}

function canonical(value: RuntimeSnapshotJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const objectValue = value as RuntimeSnapshotObject
  return `{${Object.keys(objectValue).sort().map(key => `${JSON.stringify(key)}:${canonical(objectValue[key])}`).join(',')}}`
}

function sha256(domain: string, value: RuntimeSnapshotJson): string {
  return crypto.createHash('sha256').update(`${domain}\0${canonical(value)}`).digest('hex')
}

export class MetabolismWorkerRuntimeRevisionAllocator {
  private current: number

  constructor(initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) invalid('initial revision')
    this.current = initialRevision
  }

  allocate(): number {
    if (this.current >= Number.MAX_SAFE_INTEGER) throw new RangeError('metabolism worker runtime revision exhausted')
    this.current += 1
    return this.current
  }

  peek(): number {
    return this.current
  }
}

export function createMetabolismWorkerRuntimeSnapshot(
  source: MetabolismWorkerRuntimeSnapshotSource,
  runtimeRevision: number,
): MetabolismWorkerRuntimeSnapshot {
  if (!Number.isSafeInteger(runtimeRevision) || runtimeRevision < 1) invalid('revision')
  if (typeof source !== 'object' || source === null || utilTypes.isProxy(source) || Object.getPrototypeOf(source) !== Object.prototype) invalid('source')
  const sourceDescriptors = Object.getOwnPropertyDescriptors(source)
  const expected = ['authorizedRoots', 'connections', 'credentials', 'runtimeConfig', 'strategy']
  if (Object.keys(sourceDescriptors).sort().join('\0') !== expected.sort().join('\0')) invalid('source')
  if (Object.values(sourceDescriptors).some(descriptor => !('value' in descriptor))) invalid('source')

  const roots = source.authorizedRoots
  if (typeof roots !== 'object' || roots === null || utilTypes.isProxy(roots) || Object.getPrototypeOf(roots) !== Object.prototype) invalid('authorized roots')
  const rootDescriptors = Object.getOwnPropertyDescriptors(roots)
  if (Object.keys(rootDescriptors).length !== 1 || !('dataDir' in rootDescriptors) || !('value' in rootDescriptors.dataDir)) invalid('authorized roots')
  if (typeof roots.dataDir !== 'string' || roots.dataDir.length < 1 || roots.dataDir.length > 4096) invalid('data dir')

  const runtimeConfig = record(source.runtimeConfig, 'config')
  const connections = array(source.connections, 'connections')
  const strategy = record(source.strategy, 'strategy')
  const credentials = record(source.credentials, 'credentials')
  const strategySourceFingerprint = sha256('metabolism-worker-strategy-source-v1', strategy)
  const facts = Object.freeze({
    protocolVersion: 1 as const,
    runtimeRevision,
    runtimeConfig,
    connections,
    strategy,
    strategySourceFingerprint,
    credentials,
    authorizedRoots: Object.freeze({ dataDir: roots.dataDir }),
  })
  return Object.freeze({
    ...facts,
    commitment: sha256('metabolism-worker-runtime-snapshot-v1', facts),
  })
}

export function verifyMetabolismWorkerRuntimeSnapshot(snapshot: MetabolismWorkerRuntimeSnapshot): void {
  const rebuilt = createMetabolismWorkerRuntimeSnapshot({
    runtimeConfig: snapshot.runtimeConfig,
    connections: snapshot.connections,
    strategy: snapshot.strategy,
    credentials: snapshot.credentials,
    authorizedRoots: snapshot.authorizedRoots,
  }, snapshot.runtimeRevision)
  if (rebuilt.strategySourceFingerprint !== snapshot.strategySourceFingerprint || rebuilt.commitment !== snapshot.commitment) {
    invalid('commitment')
  }
}
