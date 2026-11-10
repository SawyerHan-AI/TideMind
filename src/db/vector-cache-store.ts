import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ensureVectorTable } from './schema.js';
import { preserveLegacyVectorData } from './vector-cache-schema.js';
import { decodeVector, embeddingProfileId, validateVectorBundle, type VectorBundle } from '../embedding/bundle-contract.js';
import type { EmbeddingProfileSelection } from '../embedding/profile.js';
import { nodeEmbeddingInputHash } from '../embedding/input-contract.js';

const RUNTIME_KEY = 'vector.runtime.v1';
export interface VectorRuntimeInput {
  /** Local route identity only; never part of a portable profile. */
  bindingId?: string | null;
  endpointId?: string | null;
  awaitingDesktopAuth?: boolean;
  selection: EmbeddingProfileSelection;
  accountId: string | null;
  syncEnabled: boolean;
  backgroundBuilder: boolean;
}
export interface VectorRuntimeState extends VectorRuntimeInput { epoch: string }
export interface QueuedVectorIdentity {
  accountId: string;
  endpointId?: string | null;
  nodeId: string;
  profileId: string;
  inputHash: string;
  checksum: string;
}
export function localEmbeddingInstanceId(db: Database.Database): string {
  const existing=db.prepare("SELECT value FROM metadata WHERE key='vector.local_instance'").get() as {value:string}|undefined;
  if(existing?.value)return existing.value;
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('vector.local_instance',?)").run(randomUUID());
  return (db.prepare("SELECT value FROM metadata WHERE key='vector.local_instance'").get() as { value: string }).value;
}
function validateRuntimeInput(value: VectorRuntimeInput, epoch?: unknown): void {
  if (!value || !value.selection || value.selection.id !== embeddingProfileId(value.selection.profile)
    || typeof value.selection.shareable !== 'boolean' || typeof value.syncEnabled !== 'boolean'
    || typeof value.backgroundBuilder !== 'boolean'
    || !(value.endpointId == null || (typeof value.endpointId === 'string' && /^[a-f0-9]{64}$/.test(value.endpointId)))
    || !(value.awaitingDesktopAuth === undefined || typeof value.awaitingDesktopAuth === 'boolean')
    || !(value.bindingId == null || (typeof value.bindingId === 'string' && /^mc_[a-f0-9]{8}$/.test(value.bindingId)))
    || !(value.accountId === null || (typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 256 && !value.accountId.includes('\0')))
    || (value.syncEnabled && value.accountId === null)
    || (epoch !== undefined && (typeof epoch !== 'string' || !epoch || epoch.length > 128))) {
    throw new Error('Invalid vector runtime state');
  }
}
export function readVectorRuntime(db: Database.Database): VectorRuntimeState | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(RUNTIME_KEY) as { value: string } | undefined;
  if (!row) return null;
  const state = JSON.parse(row.value) as VectorRuntimeState;
  if (!state || state.epoch === undefined) throw new Error('Invalid vector runtime state');
  validateRuntimeInput(state,state.epoch);
  return state;
}
function matchingRuntime(db: Database.Database, expected: VectorRuntimeState): boolean {
  const current = readVectorRuntime(db);
  return current?.epoch === expected.epoch && current.selection.id === expected.selection.id
    && current.accountId === expected.accountId && current.syncEnabled === expected.syncEnabled
    && current.selection.shareable === expected.selection.shareable
    && current.backgroundBuilder === expected.backgroundBuilder
    && (current.endpointId ?? null) === (expected.endpointId ?? null)
    && (current.bindingId ?? null) === (expected.bindingId ?? null)
    && !!current.awaitingDesktopAuth === !!expected.awaitingDesktopAuth;
}
/** Only the current configuration owner activates; Workers consume this persisted epoch. */
export function activateVectorRuntime(db: Database.Database, input: VectorRuntimeInput): VectorRuntimeState {
  validateRuntimeInput(input);
  return db.transaction(() => {
    const old = readVectorRuntime(db);
    if (old && old.selection.id === input.selection.id && old.selection.shareable === input.selection.shareable
      && old.accountId === input.accountId && old.syncEnabled === input.syncEnabled
      && old.backgroundBuilder === input.backgroundBuilder && (old.bindingId ?? null) === (input.bindingId ?? null)
      && !!old.awaitingDesktopAuth === !!input.awaitingDesktopAuth && (old.endpointId ?? null) === (input.endpointId ?? null)) return old;
    if (!old || old.selection.id !== input.selection.id) {
      // Preserve before touching the projection; rollback includes archive + DDL.
      preserveLegacyVectorData(db, true);
      db.exec('DROP TABLE IF EXISTS nodes_vec');
      ensureVectorTable(db,input.selection.profile.dimensions);
      db.exec('DELETE FROM node_segments');
      db.prepare("DELETE FROM metadata WHERE key LIKE 'vector.input:%' OR key LIKE 'vector.profile:%' OR key LIKE 'vector.projection_checksum:%'").run();
      db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('vector_dimensions',?)").run(String(input.selection.profile.dimensions));
    }
    const state: VectorRuntimeState = { ...structuredClone(input), epoch: randomUUID() };
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(RUNTIME_KEY,JSON.stringify(state));
    return state;
  }).immediate();
}
function currentNode(db: Database.Database, id: string): { id: string; content: string; title: string | null } | null {
  const node = db.prepare('SELECT id,content,title,archived,is_superseded FROM nodes WHERE id=?').get(id) as
    { id: string; content: string; title: string | null; archived: number; is_superseded: number } | undefined;
  return node && !node.archived && !node.is_superseded ? node : null;
}
export function readCompatibleVectorBundle(db: Database.Database, nodeId: string, expected: VectorRuntimeState): VectorBundle | null {
  if (!matchingRuntime(db,expected)) return null;
  const node = currentNode(db,nodeId);
  if (!node) return null;
  const row = db.prepare('SELECT bundle_json FROM vector_bundles WHERE node_id=? AND profile_id=?')
    .get(nodeId,expected.selection.id) as { bundle_json: string } | undefined;
  if (!row) return null;
  try {
    const bundle = validateVectorBundle(JSON.parse(row.bundle_json),node);
    return bundle.profileId === expected.selection.id ? bundle : null;
  }
  catch { return null; }
}
/** Atomically publish complete raw data, search projection and account-scoped upload work. */
export function commitVectorBundle(db: Database.Database, value: unknown, expected: VectorRuntimeState, queueUpload: boolean, pendingAcknowledgement?: QueuedVectorIdentity, commitFence?: () => boolean): boolean {
  return db.transaction(() => {
    if (!matchingRuntime(db,expected) || (commitFence && !commitFence())) return false;
    const id = (value as Partial<VectorBundle> | null)?.nodeId;
    if (typeof id !== 'string') throw new Error('Vector bundle node is required');
    const node = currentNode(db,id);
    if (!node) return false;
    if ((value as Partial<VectorBundle>).inputHash !== nodeEmbeddingInputHash(node.content,node.title)) return false;
    const bundle = validateVectorBundle(value,node);
    if (bundle.profileId !== expected.selection.id) return false;
    if (pendingAcknowledgement && (pendingAcknowledgement.accountId !== expected.accountId
      || (pendingAcknowledgement.endpointId??'') !== (expected.endpointId??'')
      || pendingAcknowledgement.nodeId !== id || pendingAcknowledgement.profileId !== bundle.profileId)) return false;
    const pending = expected.accountId ? db.prepare(`SELECT input_hash,checksum FROM vector_upload_queue
      WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=?`).get(expected.accountId,expected.endpointId??'',id,bundle.profileId) as { input_hash: string; checksum: string } | undefined : undefined;
    const acknowledgesPending = pendingAcknowledgement && pending
      && pendingAcknowledgement.accountId === expected.accountId
      && pendingAcknowledgement.nodeId === id && pendingAcknowledgement.profileId === bundle.profileId
      && pendingAcknowledgement.inputHash === pending.input_hash && pendingAcknowledgement.checksum === pending.checksum;
    // A download cannot strand the current account's pending identity without its
    // exact acknowledgement. Cached projection rebuilds with identical bytes keep it.
    if (!queueUpload && pending && (pending.input_hash !== bundle.inputHash || pending.checksum !== bundle.checksum)
      && !acknowledgesPending) return false;
    if (pendingAcknowledgement && pending && !acknowledgesPending) return false;

    db.prepare(`INSERT INTO vector_bundles(node_id,profile_id,input_hash,checksum,bundle_json,shareable)
      VALUES (?,?,?,?,?,?) ON CONFLICT(node_id,profile_id) DO UPDATE SET input_hash=excluded.input_hash,
      checksum=excluded.checksum,bundle_json=excluded.bundle_json,shareable=excluded.shareable`)
      .run(id,bundle.profileId,bundle.inputHash,bundle.checksum,JSON.stringify(bundle),expected.selection.shareable?1:0);
    const oldSegments = db.prepare('SELECT segment_id FROM node_segments WHERE node_id=?').all(id) as Array<{segment_id:string}>;
    const remove = db.prepare('DELETE FROM nodes_vec WHERE id=?');
    for (const segment of oldSegments) remove.run(segment.segment_id);
    db.prepare('DELETE FROM node_segments WHERE node_id=?').run(id);
    const writeVector = db.prepare('INSERT INTO nodes_vec(id,embedding) VALUES (?,?)');
    const writeSegment = db.prepare('INSERT INTO node_segments(segment_id,node_id,segment_index) VALUES (?,?,?)');
    for (const part of bundle.segments) {
      const vector = decodeVector(part.vector,bundle.profile.dimensions);
      const segmentId = `${id}#${part.index}`;
      writeVector.run(segmentId,Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength));
      writeSegment.run(segmentId,id,part.index);
    }
    const metadata = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
    metadata.run(`vector.input:${id}`,bundle.inputHash);
    metadata.run(`vector.profile:${id}`,bundle.profileId);
    metadata.run(`vector.projection_checksum:${id}`,bundle.checksum);
    const willQueue = queueUpload && expected.syncEnabled && expected.accountId !== null && expected.selection.shareable;
    if (willQueue) {
      db.prepare(`INSERT INTO vector_upload_queue(account_id,endpoint_id,node_id,profile_id,input_hash,checksum,payload_json)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,endpoint_id,node_id,profile_id) DO UPDATE SET
        input_hash=excluded.input_hash,checksum=excluded.checksum,payload_json=excluded.payload_json,
        attempts=CASE WHEN vector_upload_queue.input_hash=excluded.input_hash AND vector_upload_queue.checksum=excluded.checksum THEN vector_upload_queue.attempts ELSE 0 END,
        retry_after=CASE WHEN vector_upload_queue.input_hash=excluded.input_hash AND vector_upload_queue.checksum=excluded.checksum THEN vector_upload_queue.retry_after ELSE 0 END`)
        .run(expected.accountId,expected.endpointId??'',id,bundle.profileId,bundle.inputHash,bundle.checksum,JSON.stringify(bundle));
    }
    if (!queueUpload && acknowledgesPending) {
      db.prepare(`DELETE FROM vector_upload_queue WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=?
        AND input_hash=? AND checksum=?`).run(expected.accountId,expected.endpointId??'',id,bundle.profileId,pending!.input_hash,pending!.checksum);
    }
    return true;
  }).immediate();
}
export function acknowledgeVectorUpload(db: Database.Database, expected: VectorRuntimeState, sent: QueuedVectorIdentity, commitFence?: () => boolean): boolean {
  return db.transaction(() => {
    if (!matchingRuntime(db,expected) || expected.accountId !== sent.accountId || expected.selection.id !== sent.profileId || (expected.endpointId??'') !== (sent.endpointId??'')
      || (commitFence && !commitFence())) return false;
    return db.prepare(`DELETE FROM vector_upload_queue WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=?
      AND input_hash=? AND checksum=?`).run(sent.accountId,sent.endpointId??'',sent.nodeId,sent.profileId,sent.inputHash,sent.checksum).changes === 1;
  }).immediate();
}

/** Stop only the generation owned by the disposing desktop controller. */
export function invalidateVectorRuntime(db: Database.Database, expectedEpoch: string): boolean {
  return db.transaction(() => {
    const current = readVectorRuntime(db);
    if (!current || current.epoch !== expectedEpoch) return false;
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({...current,epoch:randomUUID()}),RUNTIME_KEY);
    return true;
  }).immediate();
}

/** Cheap readiness stamp; missing physical segments still force a projection rebuild. */
export function isVectorProjectionCurrent(db: Database.Database, bundle: VectorBundle, expected: VectorRuntimeState): boolean {
  if (!matchingRuntime(db,expected)) return false;
  const node = currentNode(db,bundle.nodeId);
  if (!node || nodeEmbeddingInputHash(node.content,node.title) !== bundle.inputHash) return false;
  const read = db.prepare('SELECT value FROM metadata WHERE key=?');
  for (const [prefix,value] of [['vector.input:',bundle.inputHash],['vector.profile:',bundle.profileId],['vector.projection_checksum:',bundle.checksum]]) {
    if ((read.get(prefix+bundle.nodeId) as {value:string}|undefined)?.value !== value) return false;
  }
  const parts=db.prepare('SELECT segment_id,segment_index FROM node_segments WHERE node_id=? ORDER BY segment_index').all(bundle.nodeId) as Array<{segment_id:string;segment_index:number}>;
  if (parts.length !== bundle.segments.length) return false;
  const exists=db.prepare('SELECT id FROM nodes_vec WHERE id=?');
  return parts.every((part,index)=>part.segment_index===index&&part.segment_id===`${bundle.nodeId}#${index}`&&!!exists.get(part.segment_id));
}
