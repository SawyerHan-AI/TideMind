import type Database from 'better-sqlite3';
import { readVectorRuntime } from './vector-cache-store.js';
import { nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding } from '../embedding/input-contract.js';

export interface VectorReadiness {
  mode: 'ready' | 'waiting_sync' | 'waiting_generation' | 'error' | 'initializing';
  eligible: number;
  ready: number;
  missing: number;
  failed: number;
  queued: number;
  uploadFailed: number;
}
/** Read-only coverage of the current model space. Never opens or migrates a DB. */
export function getVectorReadiness(db: Database.Database): VectorReadiness {
  const result: VectorReadiness = {mode:'initializing',eligible:0,ready:0,missing:0,failed:0,queued:0,uploadFailed:0};
  if (!db.open) return result;
  try {
    return db.transaction(() => {
      const nodes = db.prepare('SELECT id,content,title FROM nodes WHERE archived=0 AND is_superseded=0 AND heat>0.01').all() as Array<{id:string;content:string;title:string|null}>;
      const inputs = nodes.map(node=>({...node,input:nodeEmbeddingInput(node.content,node.title)})).filter(node=>node.input.trim());
      result.eligible=inputs.length;result.missing=inputs.length;
      const runtime=readVectorRuntime(db);
      const error=db.prepare("SELECT value FROM metadata WHERE key='vector.runtime_error'").get();
      if(error){result.mode='error';return result;}
      if(!runtime)return result;
      const metadata=new Map((db.prepare("SELECT key,value FROM metadata WHERE key GLOB 'vector.input:*' OR key GLOB 'vector.profile:*' OR key GLOB 'vector.projection_checksum:*' OR key GLOB 'vector.generate_retry:*'").all() as Array<{key:string;value:string}>).map(row=>[row.key,row.value]));
      // Count only canonical mappings backed by physical vec0 rows; a half-written
      // or removed segment must not make a node ready. Do not read vector blobs.
      const parts=new Map((db.prepare(`SELECT s.node_id,COUNT(*) AS count, MIN(s.segment_index) AS first, MAX(s.segment_index) AS last FROM node_segments s
        JOIN nodes_vec v ON v.id=s.segment_id
        WHERE s.segment_index>=0 AND s.segment_id=s.node_id || '#' || s.segment_index
        GROUP BY s.node_id`).all() as Array<{node_id:string;count:number;first:number;last:number}>).map(row=>[row.node_id,row]));
      const mapped=new Map((db.prepare('SELECT node_id,COUNT(*) AS count FROM node_segments GROUP BY node_id').all() as Array<{node_id:string;count:number}>).map(row=>[row.node_id,row.count]));
      const bundles=new Map((db.prepare('SELECT node_id,input_hash,checksum FROM vector_bundles WHERE profile_id=?').all(runtime.selection.id) as Array<{node_id:string;input_hash:string;checksum:string}>).map(row=>[row.node_id,row]));
      for(const node of inputs){
        const hash=nodeEmbeddingInputHash(node.content,node.title),bundle=bundles.get(node.id);
        const expected=segmentForEmbedding(node.input).length;
        if(bundle?.input_hash===hash && metadata.get(`vector.input:${node.id}`)===hash
          && metadata.get(`vector.profile:${node.id}`)===runtime.selection.id
          && metadata.get(`vector.projection_checksum:${node.id}`)===bundle.checksum
          && mapped.get(node.id)===expected && parts.get(node.id)?.count===expected && parts.get(node.id)?.first===0 && parts.get(node.id)?.last===expected-1){result.ready++;continue;}
        const retry=metadata.get(`vector.generate_retry:${JSON.stringify([runtime.endpointId??null,runtime.accountId,runtime.selection.id,node.id])}`);
        if(retry){try{if(JSON.parse(retry).inputHash===hash)result.failed++;}catch{/* Advisory state only. */}}
      }
      result.missing=result.eligible-result.ready;
      if(runtime.syncEnabled && runtime.selection.shareable && runtime.accountId){
        const currentInputs=new Map(inputs.map(node=>[node.id,nodeEmbeddingInputHash(node.content,node.title)]));
        const queue=db.prepare(`SELECT node_id,input_hash,attempts FROM vector_upload_queue
          WHERE account_id=? AND endpoint_id=? AND profile_id=?`).all(runtime.accountId,runtime.endpointId??'',runtime.selection.id) as Array<{node_id:string;input_hash:string;attempts:number}>;
        for(const item of queue)if(currentInputs.get(item.node_id)===item.input_hash){result.queued++;if(item.attempts>0)result.uploadFailed++;}
      }
      result.mode=result.failed||result.uploadFailed?'error':result.missing
        ? (runtime.selection.shareable && (runtime.awaitingDesktopAuth || (runtime.syncEnabled&&!runtime.backgroundBuilder))?'waiting_sync':'waiting_generation')
        :result.queued?'waiting_sync':'ready';
      return result;
    })();
  }catch{return {...result,mode:'initializing',ready:0,missing:result.eligible};}
}
