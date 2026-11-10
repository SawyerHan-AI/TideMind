import type Database from 'better-sqlite3'
import type { AppConfig } from '@server/types.js'
import { cloudEndpointIdentity } from '@server/utils/cloud-endpoint.js'
import { getConfig } from '@server/config.js'
import { captureEmbeddingConnection } from '@server/embedding/connection-config.js'
import { selectEmbeddingProfile } from '@server/embedding/profile.js'
import { createLogger } from '@server/utils/logger.js'
import { activateVectorRuntime, localEmbeddingInstanceId, type VectorRuntimeState } from '@server/db/vector-cache-store.js'
import { resolveSqliteVecLoadablePath } from '@server/db/sqlite-vec-path.js'
import { getCloudAuth } from './auth-client.js'

const log=createLogger('vector-runtime')
const ready = new WeakSet<Database.Database>()
export interface DesktopVectorBindings {
  config(): AppConfig
  accountId(): string | null
}
export const desktopVectorBindings: DesktopVectorBindings = {
  config:getConfig, accountId:()=>getCloudAuth()?.userId || null,
}
/** Initializes only local storage; never calls a model or a remote API. */
export async function refreshDesktopVectorRuntime(
  db: Database.Database, bindings=desktopVectorBindings, allowed:()=>boolean=()=>true,
): Promise<VectorRuntimeState | null> {
  if (!allowed() || !db.open) return null
  try {
  if (!ready.has(db)) {
    try { db.prepare('SELECT vec_version()').get() }
    catch (error) {
      if (!/no such function: vec_version/i.test(String(error))) throw error
      const sqliteVec = await import('sqlite-vec')
      if (!allowed() || !db.open) return null
      db.loadExtension(resolveSqliteVecLoadablePath(sqliteVec.getLoadablePath()))
    }
    ready.add(db)
  }
  if (!allowed() || !db.open) return null
  const config = captureEmbeddingConnection(db,bindings.config()).config
  const accountId = bindings.accountId()
  const selection = selectEmbeddingProfile(config,localEmbeddingInstanceId(db))
  const state = activateVectorRuntime(db,{
    selection,accountId,bindingId:config.embedding.connection??null,
    endpointId:selection.shareable&&config.cloud?.sync_enabled?cloudEndpointIdentity(config.cloud.server_url).id:null,
    syncEnabled:config.cloud?.sync_enabled === true && !!accountId,
    backgroundBuilder:config.metabolism.background_enabled !== false,awaitingDesktopAuth:selection.shareable && config.cloud?.sync_enabled === true && !accountId,
  })
  db.prepare("DELETE FROM metadata WHERE key='vector.runtime_error'").run()
  return state
  } catch (error) {
    if (allowed() && db.open) {
      try { db.transaction(()=>{
        db.prepare("DELETE FROM metadata WHERE key='vector.runtime.v1'").run()
        db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('vector.runtime_error','embedding_configuration_unavailable')").run()
      }).immediate() } catch { /* Main sync will independently report database failures. */ }
      log.warn(`vector initialization unavailable: ${(error as Error).message}`)
    }
    return null
  }
}
