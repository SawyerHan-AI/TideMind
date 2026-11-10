import type Database from 'better-sqlite3';
import { getConfig, getLoadedConfigSourcePath, loadConfig, reloadConfig } from '../config.js';
import { getEmbedding, getEmbeddingCredentialSignal } from '../llm/embedding.js';
import { captureEmbeddingConnection, embeddingConnectionCurrent } from '../embedding/connection-config.js';
import { selectEmbeddingProfile } from '../embedding/profile.js';
import { stampVector, vectorSpace, type VectorSpaceStamp } from '../embedding/vector-space.js';
import { readVectorRuntime, type VectorRuntimeState } from './vector-cache-store.js';
import { nodeEmbeddingInputHash } from '../embedding/input-contract.js';
import { getMetabolismWorkerRuntimeContext } from '../metabolism/worker-runtime-context.js';
const registered = new WeakSet<Database.Database>();
export function registerVectorInputFunction(db: Database.Database): void {
  if (registered.has(db)) return;
  db.function('tidemind_embedding_input_hash',{deterministic:true},(content:unknown,title:unknown)=>
    nodeEmbeddingInputHash(typeof content==='string'?content:'',typeof title==='string'?title:null));
  registered.add(db);
}
export function vectorSpaceCurrent(db: Database.Database, space: VectorSpaceStamp | undefined): boolean {
  if (!db.open || !space) return false;
  const current=readVectorRuntime(db);
  if(current?.epoch!==space.epoch || current.selection.id!==space.profileId)return false;
  if(space.nodeId!==undefined||space.inputHash!==undefined){
    if(!space.nodeId||!space.inputHash)return false;
    const node=db.prepare('SELECT content,title,archived,is_superseded,heat FROM nodes WHERE id=?').get(space.nodeId) as {content:string;title:string|null;archived:number;is_superseded:number;heat:number}|undefined;
    return !!node&&!node.archived&&!node.is_superseded&&node.heat>0.01&&nodeEmbeddingInputHash(node.content,node.title)===space.inputHash;
  }
  return true;
}
export function vectorQueryCurrent(db: Database.Database, vector: Float32Array): boolean {
  try { return vectorSpaceCurrent(db,vectorSpace(vector)); } catch { return false; }
}
export function validUnitVector(vector: Float32Array, dimensions: number): boolean {
  if(vector.length!==dimensions)return false;
  let sum=0;for(const value of vector){if(!Number.isFinite(value))return false;sum+=value*value;}
  return Math.abs(Math.sqrt(sum)-1)<=1e-4;
}
export async function getQueryEmbedding(db: Database.Database,text:string,options:{timeoutMs?:number}={}):Promise<Float32Array|null>{
  try {
    const runtime=readVectorRuntime(db);if(!runtime)return null;
    const worker=getMetabolismWorkerRuntimeContext();
    let config=getConfig();
    if(!worker){
      const source=getLoadedConfigSourcePath();reloadConfig();config=loadConfig(source??undefined);
    }
    const captured=captureEmbeddingConnection(db,config);
    const instance=db.prepare("SELECT value FROM metadata WHERE key='vector.local_instance'").get() as {value:string}|undefined;
    if(!instance?.value)return null;
    const selection=selectEmbeddingProfile(captured.config,instance.value);
    if(selection.id!==runtime.selection.id||(captured.config.embedding.connection??null)!==(runtime.bindingId??null))return null;
    const signal=getEmbeddingCredentialSignal(captured.config);
    const current=()=>{
      if(!vectorSpaceCurrent(db,{profileId:selection.id,epoch:runtime.epoch})
        ||!embeddingConnectionCurrent(db,captured.config.embedding.connection,captured.binding)
        ||getEmbeddingCredentialSignal(captured.config)!==signal)return false;
      if(worker){const row=db.prepare("SELECT value FROM metadata WHERE key='metabolism_worker_runtime_revision'").get() as {value:string}|undefined;return row?.value===String(worker.runtimeRevision);}
      return true;
    };
    if(!current())return null;
    const vector=await getEmbedding(text,{...options,configSnapshot:captured.config});
    if(!vector||!current()||!validUnitVector(vector,selection.profile.dimensions))return null;
    return stampVector(vector,runtime);
  }catch{return null;}
}
/** Reused by every semantic consumer; eligibility is evaluated BEFORE KNN truncation. */
export const ELIGIBLE_VECTOR_SEGMENTS_SQL = `
  SELECT s.segment_id FROM node_segments s
  JOIN nodes n ON n.id=s.node_id
  JOIN vector_bundles b ON b.node_id=n.id AND b.profile_id=?
  JOIN metadata p ON p.key='vector.profile:' || n.id AND p.value=b.profile_id
  JOIN metadata h ON h.key='vector.input:' || n.id AND h.value=b.input_hash
  JOIN metadata c ON c.key='vector.projection_checksum:' || n.id AND c.value=b.checksum
  WHERE n.archived=0 AND n.is_superseded=0 AND n.heat>0.01
    AND b.input_hash=tidemind_embedding_input_hash(n.content,n.title)
`;
export function activeVectorRuntime(db: Database.Database):VectorRuntimeState|null {
  registerVectorInputFunction(db);return readVectorRuntime(db);
}
