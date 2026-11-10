import type Database from 'better-sqlite3';
import type { AppConfig } from '../types.js';
import { getEmbedding, getEmbeddingCredentialSignal } from '../llm/embedding.js';
import { createVectorBundle, validateVectorBundle, VECTOR_CACHE_LIMITS } from './bundle-contract.js';
import { nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding } from './input-contract.js';
import { captureEmbeddingConnection, embeddingConnectionCurrent } from './connection-config.js';
import { selectEmbeddingProfile } from './profile.js';
import { commitVectorBundle, isVectorProjectionCurrent, localEmbeddingInstanceId, readCompatibleVectorBundle, readVectorRuntime, type VectorRuntimeState } from '../db/vector-cache-store.js';
import { getMetabolismWorkerRuntimeContext } from '../metabolism/worker-runtime-context.js';

export interface NodeVectorGenerationOptions {
  /** Only explicit user operations may bypass the non-builder's background wait. */
  foreground?: boolean;
  /** Reports a current provider failure, never an epoch change or cache wait. */
  onGenerationFailure?: () => void;
  expectedEpoch?: string;
  signal?: AbortSignal;
  /** In-process cache fetch; callers must still respect account/profile/epoch after await. */
  fetchCached?: (nodeId: string, inputHash: string, runtime: VectorRuntimeState, signal?: AbortSignal) => Promise<unknown | null>;
}
let desktopCacheFetcher: NodeVectorGenerationOptions['fetchCached'];
/** An older owner may only unregister its own callback. Workers never install one. */
export function installDesktopVectorCacheFetcher(fetcher: NonNullable<NodeVectorGenerationOptions['fetchCached']>): () => void {
  desktopCacheFetcher = fetcher;
  return () => { if (desktopCacheFetcher === fetcher) desktopCacheFetcher = undefined; };
}
/** Cache-first node generation with one frozen request configuration and durable fencing. */
export async function generateNodeVectorBundle(
  db: Database.Database, nodeId: string, config: AppConfig, options: NodeVectorGenerationOptions = {},
): Promise<number> {
  if(!db.open || options.signal?.aborted)return 0;
  const runtime = readVectorRuntime(db);
  if (!runtime || options.signal?.aborted || (options.expectedEpoch && options.expectedEpoch !== runtime.epoch)) return 0;
  const captured = captureEmbeddingConnection(db,config);
  const frozen = captured.config;
  const selection = selectEmbeddingProfile(frozen,localEmbeddingInstanceId(db));
  if (selection.id !== runtime.selection.id || selection.shareable !== runtime.selection.shareable
    || (frozen.embedding.connection ?? null) !== (runtime.bindingId ?? null)) return 0;
  const credentialSignal = getEmbeddingCredentialSignal(frozen);
  const worker = getMetabolismWorkerRuntimeContext();
  const isCurrent = (): boolean => {
    if (!db.open || options.signal?.aborted || readVectorRuntime(db)?.epoch !== runtime.epoch
      || getEmbeddingCredentialSignal(frozen) !== credentialSignal
      || !embeddingConnectionCurrent(db,frozen.embedding.connection,captured.binding)) return false;
    if (worker) {
      const revision = db.prepare("SELECT value FROM metadata WHERE key='metabolism_worker_runtime_revision'").get() as { value: string } | undefined;
      if (revision?.value !== String(worker.runtimeRevision)) return false;
    }
    return true;
  };
  if (!isCurrent()) return 0;
  const node = db.prepare('SELECT id,content,title,archived,is_superseded FROM nodes WHERE id=?').get(nodeId) as
    { id: string; content: string; title: string | null; archived: number; is_superseded: number } | undefined;
  if (!node || node.archived || node.is_superseded) return 0;
  const inputHash = nodeEmbeddingInputHash(node.content,node.title);
  const stillSameNode = (): boolean => {
    const current = db.prepare('SELECT content,title,archived,is_superseded FROM nodes WHERE id=?').get(nodeId) as typeof node;
    return !!current && !current.archived && !current.is_superseded
      && nodeEmbeddingInputHash(current.content,current.title) === inputHash;
  };
  const local = readCompatibleVectorBundle(db,nodeId,runtime);
  if (local) return isCurrent() && (isVectorProjectionCurrent(db,local,runtime) || commitVectorBundle(db,local,runtime,false,undefined,isCurrent)) ? local.segments.length : 0;
  if (runtime.awaitingDesktopAuth && runtime.selection.shareable) return 0;
  if (runtime.syncEnabled && runtime.selection.shareable) {
    // A process without the authenticated cache transport must wait for the
    // owning desktop pump, rather than treating an unchecked cache as a miss.
    const fetchCached = options.fetchCached ?? desktopCacheFetcher;
    if (!fetchCached) return 0;
    const downloaded = await fetchCached(nodeId,inputHash,runtime,options.signal);
    if (!isCurrent() || !stillSameNode()) return 0;
    if (downloaded !== null) {
      try {
        const bundle = validateVectorBundle(downloaded,node);
        if (bundle.profileId !== runtime.selection.id) return 0;
        return commitVectorBundle(db,bundle,runtime,false,undefined,isCurrent) ? bundle.segments.length : 0;
      } catch { return 0; }
    }
  }
  if (runtime.syncEnabled && runtime.selection.shareable && !runtime.backgroundBuilder && !options.foreground) return 0;
  const segments = segmentForEmbedding(nodeEmbeddingInput(node.content,node.title));
  if (!segments.length || segments.length > VECTOR_CACHE_LIMITS.segments
    || segments.length * selection.profile.dimensions * 4 > VECTOR_CACHE_LIMITS.vectorBytes) return 0;
  const vectors: Float32Array[] = [];
  for (const segment of segments) {
    if (!isCurrent() || !stillSameNode()) return 0;
    let vector:Float32Array|null;
    try{vector=await getEmbedding(segment,{configSnapshot:frozen});}
    catch(error){if(isCurrent() && stillSameNode())options.onGenerationFailure?.();throw error;}
    if (!isCurrent() || !stillSameNode()) return 0;
    if (!vector) { options.onGenerationFailure?.(); return 0; }
    vectors.push(vector);
  }
  let bundle:ReturnType<typeof createVectorBundle>;
  try{bundle=createVectorBundle(node,selection.profile,vectors);}
  catch(error){if(isCurrent() && stillSameNode())options.onGenerationFailure?.();throw error;}
  return isCurrent() && commitVectorBundle(db,bundle,runtime,true,undefined,isCurrent) ? segments.length : 0;
}
