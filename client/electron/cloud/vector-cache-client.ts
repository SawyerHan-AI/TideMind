import type Database from 'better-sqlite3'
import { cloudEndpointIdentity } from '@server/utils/cloud-endpoint.js'
import { getConfig } from '@server/config.js'
import { VECTOR_CACHE_LIMITS, validateVectorBundle, type VectorBundle } from '@server/embedding/bundle-contract.js'
import { nodeEmbeddingInputHash } from '@server/embedding/input-contract.js'
import { acknowledgeVectorUpload, commitVectorBundle, readVectorRuntime, type QueuedVectorIdentity, type VectorRuntimeState } from '@server/db/vector-cache-store.js'
import { getCloudAuth, getCloudBaseUrl, refreshTokenIfNeeded } from './auth-client.js'

export interface VectorCacheKey { nodeId: string; inputHash: string; profileId: string }
export interface VectorCacheReceipt extends VectorCacheKey { checksum: string }
export interface PendingVectorUpload extends QueuedVectorIdentity { payloadJson: string }
export interface VectorCacheBindings {
  accountId(): string | null
  enabled(): boolean
  token(): Promise<string | null>
  baseUrl(): string
  fetch?: typeof fetch
}
export class VectorCacheTransportError extends Error {
  constructor(public readonly kind: 'stale' | 'protocol' | 'http', public readonly status?: number) { super(`vector cache ${kind}${status ? ` (${status})` : ''}`) }
}
const HASH = /^[a-f0-9]{64}$/
function cleanKey(key: VectorCacheKey): VectorCacheKey {
  if (!key || typeof key.nodeId !== 'string' || !key.nodeId || key.nodeId.length > 256 || key.nodeId.includes('\0')
    || typeof key.inputHash !== 'string' || !HASH.test(key.inputHash) || typeof key.profileId !== 'string' || !HASH.test(key.profileId)) throw new VectorCacheTransportError('protocol')
  return {nodeId:key.nodeId,inputHash:key.inputHash,profileId:key.profileId}
}
function sameKey(a: VectorCacheKey, b: VectorCacheKey): boolean {
  return a.nodeId === b.nodeId && a.inputHash === b.inputHash && a.profileId === b.profileId
}
function parseReceipt(value: unknown): VectorCacheReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VectorCacheTransportError('protocol')
  const row = value as Record<string,unknown>
  if (Object.keys(row).length !== 4 || typeof row.nodeId !== 'string' || !row.nodeId || row.nodeId.length > 256 || row.nodeId.includes('\0')
    || typeof row.inputHash !== 'string' || !HASH.test(row.inputHash) || typeof row.profileId !== 'string' || !HASH.test(row.profileId)
    || typeof row.checksum !== 'string' || !HASH.test(row.checksum)) throw new VectorCacheTransportError('protocol')
  return row as unknown as VectorCacheReceipt
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > VECTOR_CACHE_LIMITS.transportBytes) throw new VectorCacheTransportError('protocol')
  if (!response.body) throw new VectorCacheTransportError('protocol')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > VECTOR_CACHE_LIMITS.transportBytes) { await reader.cancel(); throw new VectorCacheTransportError('protocol') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const buffer = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { buffer.set(chunk,offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)) }
  catch { throw new VectorCacheTransportError('protocol') }
}
/** No token enters SQLite, profiles, logs, or retry payloads. */
export class VectorCacheClient {
  private stopped = false
  private controllers = new Set<AbortController>()
  private readonly baseUrl: string
  private readonly endpointId: string
  constructor(private readonly db: Database.Database, private readonly bindings: VectorCacheBindings) {
    const endpoint=cloudEndpointIdentity(bindings.baseUrl());this.baseUrl=endpoint.url;this.endpointId=endpoint.id
  }
  dispose(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear() }
  private assertCurrent(expected: VectorRuntimeState): void {
    // Shutdown may close SQLite while token/body promises are still settling.
    if (this.stopped) throw new VectorCacheTransportError('stale')
    const current = readVectorRuntime(this.db)
    if (this.stopped || cloudEndpointIdentity(this.bindings.baseUrl()).url !== this.baseUrl || !expected.syncEnabled || !expected.accountId || !expected.selection.shareable || !current?.selection.shareable || !this.bindings.enabled()
      || this.bindings.accountId() !== expected.accountId || current?.epoch !== expected.epoch
      || current.accountId !== expected.accountId || current.selection.id !== expected.selection.id
      || (current.endpointId != null && current.endpointId !== this.endpointId)
      || (current.endpointId??null)!==(expected.endpointId??null)) throw new VectorCacheTransportError('stale')
  }
  private async request(operation: string, body: unknown, expected: VectorRuntimeState, signal?: AbortSignal, preflight?: () => boolean): Promise<unknown> {
    this.assertCurrent(expected)
    if (signal?.aborted) throw new VectorCacheTransportError('stale')
    const token = await this.bindings.token()
    this.assertCurrent(expected)
    if (!token || signal?.aborted || (preflight && !preflight())) throw new VectorCacheTransportError('stale')
    const serialized = JSON.stringify(body)
    if (Buffer.byteLength(serialized) > VECTOR_CACHE_LIMITS.transportBytes) throw new VectorCacheTransportError('protocol')
    const controller = new AbortController(); this.controllers.add(controller)
    try {
      const response = await (this.bindings.fetch ?? fetch)(`${this.baseUrl}/api/v1/sync/vector-cache/${operation}`, {
        method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:serialized,
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000),...(signal?[signal]:[])]),
      })
      this.assertCurrent(expected)
      if (response.status !== 200) { await response.body?.cancel(); throw new VectorCacheTransportError('http',response.status) }
      const decoded = await readBoundedJson(response)
      this.assertCurrent(expected)
      if (signal?.aborted || !decoded || typeof decoded !== 'object' || Array.isArray(decoded)
        || Object.keys(decoded).length !== 1 || !Object.hasOwn(decoded,'result')) throw new VectorCacheTransportError('protocol')
      return (decoded as {result:unknown}).result
    } finally { controller.abort(); this.controllers.delete(controller) }
  }
  private nodeMatches(key: VectorCacheKey): boolean {
    const node = this.db.prepare('SELECT content,title,archived,is_superseded FROM nodes WHERE id=?').get(key.nodeId) as
      {content:string;title:string|null;archived:number;is_superseded:number}|undefined
    return !!node && !node.archived && !node.is_superseded && nodeEmbeddingInputHash(node.content,node.title) === key.inputHash
  }
  async lookup(keys: VectorCacheKey[], expected: VectorRuntimeState, signal?: AbortSignal): Promise<VectorCacheReceipt[]> {
    if (keys.length > VECTOR_CACHE_LIMITS.lookupKeys || keys.some(key=>key.profileId !== expected.selection.id)) throw new VectorCacheTransportError('protocol')
    const rows = await this.request('lookup',keys.map(cleanKey),expected,signal)
    if (!Array.isArray(rows) || rows.length > keys.length) throw new VectorCacheTransportError('protocol')
    const result = rows.map(parseReceipt); const seen = new Set<string>()
    for (const receipt of result) {
      const id = JSON.stringify([receipt.nodeId,receipt.inputHash,receipt.profileId])
      if (seen.has(id) || !keys.some(key=>sameKey(key,receipt))) throw new VectorCacheTransportError('protocol')
      seen.add(id)
    }
    return result
  }
  async download(key: VectorCacheKey, expected: VectorRuntimeState, signal?: AbortSignal): Promise<VectorBundle | null> {
    if (key.profileId !== expected.selection.id) throw new VectorCacheTransportError('protocol')
    const result = await this.request('download',cleanKey(key),expected,signal,()=>this.nodeMatches(key))
    if (result === null) return null
    const node = this.db.prepare('SELECT id,content,title,archived,is_superseded FROM nodes WHERE id=?').get(key.nodeId) as
      { id:string;content:string;title:string|null;archived:number;is_superseded:number } | undefined
    if (!node || node.archived || node.is_superseded || nodeEmbeddingInputHash(node.content,node.title) !== key.inputHash) throw new VectorCacheTransportError('stale')
    try {
      const bundle = validateVectorBundle(result,node)
      if (!sameKey(bundle,key)) throw new Error('identity mismatch')
      return bundle
    } catch { throw new VectorCacheTransportError('protocol') }
  }
  async uploadPending(sent: PendingVectorUpload, expected: VectorRuntimeState, signal?: AbortSignal): Promise<boolean> {
    this.assertCurrent(expected)
    if (sent.accountId !== expected.accountId || (sent.endpointId??'')!==(expected.endpointId??'') || sent.profileId !== expected.selection.id || !expected.selection.shareable) throw new VectorCacheTransportError('stale')
    const node = this.db.prepare('SELECT id,content,title,archived,is_superseded FROM nodes WHERE id=?').get(sent.nodeId) as
      {id:string;content:string;title:string|null;archived:number;is_superseded:number}|undefined
    if (!node || node.archived || node.is_superseded || nodeEmbeddingInputHash(node.content,node.title) !== sent.inputHash) throw new VectorCacheTransportError('stale')
    let bundle:VectorBundle
    try { bundle = validateVectorBundle(JSON.parse(sent.payloadJson),node) }
    catch { throw new VectorCacheTransportError('protocol') }
    if (!sameKey(bundle,sent) || bundle.checksum !== sent.checksum) throw new VectorCacheTransportError('protocol')
    const receipt = parseReceipt(await this.request('upload',bundle,expected,signal,()=>this.nodeMatches(sent)
      && !!this.db.prepare(`SELECT 1 FROM vector_upload_queue WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=? AND input_hash=? AND checksum=?`)
        .get(sent.accountId,sent.endpointId??'',sent.nodeId,sent.profileId,sent.inputHash,sent.checksum)))
    if (!sameKey(receipt,sent)) throw new VectorCacheTransportError('protocol')
    this.assertCurrent(expected)
    if (receipt.checksum === sent.checksum) return acknowledgeVectorUpload(this.db,expected,sent,()=>{
      try { this.assertCurrent(expected); return !signal?.aborted } catch { return false }
    })
    const authority = await this.download(receipt,expected,signal)
    if (!authority || authority.checksum !== receipt.checksum) throw new VectorCacheTransportError('protocol')
    return commitVectorBundle(this.db,authority,expected,false,sent,()=>{
      try { this.assertCurrent(expected); return !signal?.aborted } catch { return false }
    })
  }
}
export function createVectorCacheClient(db: Database.Database): VectorCacheClient {
  return new VectorCacheClient(db,{
    accountId:()=>getCloudAuth()?.userId || null,
    enabled:()=>getConfig().cloud?.sync_enabled === true,
    token:refreshTokenIfNeeded,
    baseUrl:getCloudBaseUrl,
  })
}
