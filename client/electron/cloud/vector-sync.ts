import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createLogger } from '@server/utils/logger.js'
import { createVectorCacheClient, VectorCacheTransportError, type VectorCacheClient, type VectorCacheKey, type VectorCacheReceipt, type PendingVectorUpload } from './vector-cache-client.js'
import { refreshDesktopVectorRuntime, desktopVectorBindings, type DesktopVectorBindings } from './vector-runtime.js'
import { acknowledgeVectorUpload, commitVectorBundle, isVectorProjectionCurrent, invalidateVectorRuntime, readCompatibleVectorBundle, readVectorRuntime, type VectorRuntimeState } from '@server/db/vector-cache-store.js'
import { generateNodeVectorBundle, installDesktopVectorCacheFetcher } from '@server/embedding/generate-node.js'
import { VECTOR_CACHE_LIMITS, type VectorBundle } from '@server/embedding/bundle-contract.js'
import { nodeEmbeddingInput, nodeEmbeddingInputHash, segmentForEmbedding } from '@server/embedding/input-contract.js'
import { isSyncBootstrapCheck } from '../sync-bootstrap.js'
const log=createLogger('vector-sync')
type CacheTransport=Pick<VectorCacheClient,'lookup'|'download'|'uploadPending'|'dispose'>
type ScanNode={id:string;content:string;title:string|null;proofGeneration:string}
type ScanItem={node:ScanNode;key:VectorCacheKey;remote:VectorCacheReceipt|null;remoteFresh:boolean}
export interface VectorSyncDependencies extends DesktopVectorBindings {
  client(db:Database.Database):CacheTransport
  allowGeneration():boolean
}
const defaults:VectorSyncDependencies={...desktopVectorBindings,client:createVectorCacheClient,allowGeneration:()=>!isSyncBootstrapCheck()}
/** One owner, bounded slices, persistent cursor/backoff. Main sync versions are untouched. */
export class DesktopVectorSync {
  private readonly ownerId=randomUUID()
  private claimed=false
  private stopped=false
  private running=false
  private timer:ReturnType<typeof setTimeout>|null=null
  private abort=new AbortController()
  private runtime:VectorRuntimeState|null=null
  private client:CacheTransport|null=null
  private uninstall:(()=>void)|null=null
  private page:ScanItem[]=[]
  private nextScanAt=0
  private uploadCooldown=0
  private generationCooldown=0
  private retryScanAt=Infinity
  private rescanRequested=false
  constructor(private readonly db:Database.Database,private readonly deps:VectorSyncDependencies=defaults){}
  private owns():boolean {
    return !this.stopped && this.db.open && (!this.claimed || (this.db.prepare("SELECT value FROM metadata WHERE key='vector.desktop_owner'").get() as {value:string}|undefined)?.value===this.ownerId)
  }
  private current(state:VectorRuntimeState):boolean {
    return this.owns() && !this.abort.signal.aborted
      && this.deps.config().cloud?.sync_enabled === true && this.deps.accountId()===state.accountId
      && readVectorRuntime(this.db)?.epoch===state.epoch
  }
  private cursorKey(state:VectorRuntimeState):string {return `vector.scan:${JSON.stringify([state.endpointId??null,state.accountId,state.selection.id])}`}
  private saveCursor(state:VectorRuntimeState,id:string):void {
    if(this.current(state))this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(this.cursorKey(state),id)
  }
  async prepare():Promise<VectorRuntimeState|null>{
    let state=await refreshDesktopVectorRuntime(this.db,this.deps,()=>this.owns())
    if(!state||!this.owns())return null
    if(!this.claimed){
      state=this.db.transaction(()=>{
        this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('vector.desktop_owner',?)").run(this.ownerId)
        invalidateVectorRuntime(this.db,state!.epoch)
        return readVectorRuntime(this.db)!
      }).immediate()
      this.claimed=true
    }
    if(this.runtime?.epoch!==state.epoch){
      this.client?.dispose();this.uninstall?.();this.page=[];this.nextScanAt=0
      this.runtime=state;this.client=state.syncEnabled&&state.selection.shareable?this.deps.client(this.db):null
      const client=this.client
      this.uninstall=client?installDesktopVectorCacheFetcher((nodeId,inputHash,expected,signal)=>client.download({nodeId,inputHash,profileId:expected.selection.id},expected,signal)):null
    }
    return state
  }
  kick(rescan=false):void{
    if(this.stopped)return
    if(rescan){this.nextScanAt=0;this.rescanRequested=true;if(this.timer){clearTimeout(this.timer);this.timer=null}}
    if(this.running||this.timer)return
    void this.runBatch().then(more=>{
      if(this.stopped)return
      this.timer=setTimeout(()=>{this.timer=null;this.kick()},more?25:60_000);this.timer.unref?.()
    }).catch(error=>{
      if(!this.stopped)log.warn(`vector pass failed: ${(error as Error).message}`)
      if(!this.stopped){this.timer=setTimeout(()=>{this.timer=null;this.kick()},60_000);this.timer.unref?.()}
    })
  }
  private receiptKey(state:VectorRuntimeState,nodeId:string):string{return `vector.remote_receipt:${JSON.stringify([nodeId,state.endpointId??null,state.accountId,state.selection.id])}`}
  private checkedReceipt(state:VectorRuntimeState,node:ScanNode):VectorCacheReceipt|null{
    try{
      const raw=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(this.receiptKey(state,node.id)) as {value:string}|undefined
      if(!raw)return null
      const saved=JSON.parse(raw.value) as VectorCacheReceipt&{checkedAt:number;proofGeneration:string}
      if(saved.proofGeneration!==node.proofGeneration||!Number.isFinite(saved.checkedAt)||saved.checkedAt>Date.now()||Date.now()-saved.checkedAt>6*60*60_000)return null
      const local=this.db.prepare('SELECT input_hash,checksum FROM vector_bundles WHERE node_id=? AND profile_id=?').get(node.id,state.selection.id) as {input_hash:string;checksum:string}|undefined
      return saved.nodeId===node.id&&saved.profileId===state.selection.id&&saved.inputHash===nodeEmbeddingInputHash(node.content,node.title)
        &&local?.input_hash===saved.inputHash&&local.checksum===saved.checksum?saved:null
    }catch{return null}
  }
  private proofGeneration(nodeId:string):string|null {
    return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(`vector.proof_generation:${nodeId}`) as {value:string}|undefined)?.value??null
  }
  private markChecked(state:VectorRuntimeState,bundle:VectorBundle,generation:string|null):void{
    if(!generation||!this.current(state))return
    this.db.transaction(()=>{
      if(!this.current(state)||this.proofGeneration(bundle.nodeId)!==generation)return
      this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(this.receiptKey(state,bundle.nodeId),JSON.stringify({
        nodeId:bundle.nodeId,inputHash:bundle.inputHash,profileId:bundle.profileId,checksum:bundle.checksum,checkedAt:Date.now(),proofGeneration:generation,
      }))
    }).immediate()
  }
  private pending(state:VectorRuntimeState):PendingVectorUpload[]{
    return (this.db.prepare(`SELECT account_id AS accountId,endpoint_id AS endpointId,node_id AS nodeId,profile_id AS profileId,input_hash AS inputHash,
      checksum,payload_json AS payloadJson FROM vector_upload_queue WHERE account_id=? AND endpoint_id=? AND profile_id=? AND retry_after<=? ORDER BY retry_after,node_id LIMIT 10`)
      .all(state.accountId,state.endpointId??'',state.selection.id,Date.now()) as PendingVectorUpload[])
  }
  private pendingFor(nodeId:string,state:VectorRuntimeState):PendingVectorUpload|undefined{
    return this.db.prepare(`SELECT account_id AS accountId,endpoint_id AS endpointId,node_id AS nodeId,profile_id AS profileId,input_hash AS inputHash,checksum,payload_json AS payloadJson
      FROM vector_upload_queue WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=?`).get(state.accountId,state.endpointId??'',nodeId,state.selection.id) as PendingVectorUpload|undefined
  }
  async runBatch():Promise<boolean>{
    if(this.stopped||this.running||!this.db.open)return false
    this.running=true
    try{
      const state=await this.prepare();if(!state||!this.current(state))return false
      const client=this.client
      if(client&&Date.now()>=this.uploadCooldown)for(const pending of this.pending(state)){
        if(!this.current(state))return false
        const proofGeneration=this.proofGeneration(pending.nodeId)
        try{
          const uploaded=await client.uploadPending(pending,state,this.abort.signal)
          if(!this.current(state))return false
          const local=uploaded?readCompatibleVectorBundle(this.db,pending.nodeId,state):null
          if(local&&local.inputHash===pending.inputHash&&local.checksum===pending.checksum)this.markChecked(state,local,proofGeneration)
        }
        catch(error){
          if(!this.current(state))return false
          const node=this.db.prepare('SELECT content,title,archived,is_superseded FROM nodes WHERE id=?').get(pending.nodeId) as (ScanNode&{archived:number;is_superseded:number})|undefined
          if(error instanceof VectorCacheTransportError&&error.kind==='stale'&&(!node||node.archived||node.is_superseded||nodeEmbeddingInputHash(node.content,node.title)!==pending.inputHash)){
            acknowledgeVectorUpload(this.db,state,pending,()=>this.current(state));continue
          }
          this.db.prepare(`UPDATE vector_upload_queue SET attempts=attempts+1,retry_after=? WHERE account_id=? AND endpoint_id=? AND node_id=? AND profile_id=? AND input_hash=? AND checksum=?`)
            .run(Date.now()+60_000,pending.accountId,pending.endpointId??'',pending.nodeId,pending.profileId,pending.inputHash,pending.checksum)
          this.uploadCooldown=Date.now()+60_000;log.warn(`upload deferred: ${(error as Error).message}`);break
        }
      }
      if(!this.current(state)||Date.now()<this.nextScanAt)return false
      if(!this.page.length){
        const cursor=(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(this.cursorKey(state)) as {value:string}|undefined)?.value??''
        const nodes=this.db.prepare("SELECT n.id,n.content,n.title,m.value AS proofGeneration FROM nodes n LEFT JOIN metadata m ON m.key='vector.proof_generation:' || n.id WHERE n.id>? AND n.archived=0 AND n.is_superseded=0 ORDER BY n.id LIMIT 200").all(cursor) as ScanNode[]
        if(!nodes.length){this.saveCursor(state,'');const again=this.rescanRequested;this.rescanRequested=false;this.nextScanAt=again?0:Math.max(Date.now(),Math.min(Date.now()+6*60*60_000,this.retryScanAt));return again}
        if(!cursor)this.retryScanAt=Infinity
        const eligible=nodes.filter(n=>nodeEmbeddingInput(n.content,n.title).trim())
        if(!eligible.length){this.saveCursor(state,nodes.at(-1)!.id);return true}
        const keys=eligible.map(node=>({nodeId:node.id,inputHash:nodeEmbeddingInputHash(node.content,node.title),profileId:state.selection.id}))
        const checked=new Map<string,VectorCacheReceipt>()
        if(client)for(const node of eligible){const receipt=this.checkedReceipt(state,node);if(receipt)checked.set(node.id,receipt)}
        const unchecked=keys.filter(key=>!checked.has(key.nodeId))
        const receipts=client&&unchecked.length?await client.lookup(unchecked,state,this.abort.signal):[]
        if(!this.current(state))return false
        const byId=new Map([...checked,...receipts.map(r=>[r.nodeId,r] as const)])
        this.page=eligible.map((node,index)=>({node,key:keys[index],remote:byId.get(node.id)??null,remoteFresh:!checked.has(node.id)}))
      }
      let processed=0
      while(this.page.length&&processed++<10){
        const item=this.page[0]
        if(!this.current(state))return false
        const now=this.db.prepare('SELECT content,title,archived,is_superseded FROM nodes WHERE id=?').get(item.node.id) as (ScanNode&{archived:number;is_superseded:number})|undefined
        if(!now||now.archived||now.is_superseded||nodeEmbeddingInputHash(now.content,now.title)!==item.key.inputHash||this.proofGeneration(item.node.id)!==item.node.proofGeneration){
          this.rescanRequested=true;
          this.saveCursor(state,item.node.id);this.page.shift();continue
        }
        const local=readCompatibleVectorBundle(this.db,item.node.id,state)
        if(item.remote&&client){
          if(local?.checksum===item.remote.checksum){
            if(isVectorProjectionCurrent(this.db,local,state)||commitVectorBundle(this.db,local,state,false,undefined,()=>this.current(state))){if(item.remoteFresh)this.markChecked(state,local,item.node.proofGeneration)}
          }
          else{
            const priorPending=this.pendingFor(item.node.id,state)
            let downloaded
            try { downloaded=await client.download(item.key,state,this.abort.signal) }
            catch(error){
              if(error instanceof VectorCacheTransportError&&error.kind==='stale'&&this.current(state)){
                const current=this.db.prepare('SELECT content,title,archived,is_superseded FROM nodes WHERE id=?').get(item.node.id) as (ScanNode&{archived:number;is_superseded:number})|undefined
                if(!current||current.archived||current.is_superseded||nodeEmbeddingInputHash(current.content,current.title)!==item.key.inputHash){this.saveCursor(state,item.node.id);this.page.shift();continue}
              }
              throw error
            }
            if(!this.current(state))return false
            if(this.proofGeneration(item.node.id)!==item.node.proofGeneration){this.rescanRequested=true;this.saveCursor(state,item.node.id);this.page.shift();continue}
            if(downloaded&&commitVectorBundle(this.db,downloaded,state,false,priorPending,()=>this.current(state)))this.markChecked(state,downloaded,item.node.proofGeneration)
            else this.retryScanAt=Math.min(this.retryScanAt,Date.now()+60_000)
          }
        }else if(local){
          if(client)commitVectorBundle(this.db,local,state,true,undefined,()=>this.current(state))
          else if(!isVectorProjectionCurrent(this.db,local,state))commitVectorBundle(this.db,local,state,false,undefined,()=>this.current(state))
        }else if(this.deps.allowGeneration()&&Date.now()>=this.generationCooldown){
          const retryKey=`vector.generate_retry:${JSON.stringify([state.endpointId??null,state.accountId,state.selection.id,item.node.id])}`
          let retry:{inputHash:string;retryAfter:number}|null=null
          try { const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(retryKey) as {value:string}|undefined;retry=row?JSON.parse(row.value):null } catch { /* Replace invalid advisory state after a real attempt. */ }
          if(retry?.inputHash===item.key.inputHash&&retry.retryAfter>Date.now()){this.retryScanAt=Math.min(this.retryScanAt,retry.retryAfter);this.saveCursor(state,item.node.id);this.page.shift();continue}
          const segments=segmentForEmbedding(nodeEmbeddingInput(item.node.content,item.node.title))
          if(segments.length>VECTOR_CACHE_LIMITS.segments||segments.length*state.selection.profile.dimensions*4>VECTOR_CACHE_LIMITS.vectorBytes){
            this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(retryKey,JSON.stringify({inputHash:item.key.inputHash,retryAfter:Number.MAX_SAFE_INTEGER,reason:'node_limit'}))
            this.saveCursor(state,item.node.id);this.page.shift();continue
          }

          let made=0
          try { made=await generateNodeVectorBundle(this.db,item.node.id,this.deps.config(),{signal:this.abort.signal,expectedEpoch:state.epoch,fetchCached:async(nodeId,inputHash,expected,signal)=>{
            if(nodeId===item.key.nodeId&&inputHash===item.key.inputHash&&expected.epoch===state.epoch)return null
            return client?client.download({nodeId,inputHash,profileId:expected.selection.id},expected,signal):null
          }}) } catch(error) {
            if(!this.current(state))return false
            log.warn(`node generation deferred: ${(error as Error).message}`)
          }
          if(!this.current(state))return false
          if(!made&&(state.backgroundBuilder||!state.selection.shareable)){
            this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(retryKey,JSON.stringify({inputHash:item.key.inputHash,retryAfter:Date.now()+5*60_000,reason:'generation_failed'}))
            this.generationCooldown=Date.now()+60_000
            this.retryScanAt=Math.min(this.retryScanAt,this.generationCooldown)
          }
          if(!made&&!state.backgroundBuilder&&state.selection.shareable)this.retryScanAt=Math.min(this.retryScanAt,Date.now()+60_000)
        }else if(this.deps.allowGeneration()&&Date.now()<this.generationCooldown){
          this.retryScanAt=Math.min(this.retryScanAt,this.generationCooldown)
        }else if(!local){
          this.retryScanAt=Math.min(this.retryScanAt,Date.now()+60_000)
        }
        this.saveCursor(state,item.node.id);this.page.shift()
      }
      return true
    }finally{this.running=false}
  }
  dispose():void{
    if(this.stopped)return
    this.stopped=true;this.abort.abort();this.client?.dispose();this.uninstall?.();this.page=[]
    if(this.timer)clearTimeout(this.timer);this.timer=null
    if(this.runtime&&this.db.open)this.db.transaction(()=>{
      const owner=this.db.prepare("SELECT value FROM metadata WHERE key='vector.desktop_owner'").get() as {value:string}|undefined
      if(owner?.value===this.ownerId){
        const current=readVectorRuntime(this.db)
        if(current)invalidateVectorRuntime(this.db,current.epoch)
        this.db.prepare("DELETE FROM metadata WHERE key='vector.desktop_owner' AND value=?").run(this.ownerId)
      }
    }).immediate()
  }
}
