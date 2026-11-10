import type Database from 'better-sqlite3'
import { getConfig } from '@server/config.js'
import { createLogger } from '@server/utils/logger.js'
import { isLoggedIn } from './auth-client.js'
import { refreshDesktopVectorRuntime } from './vector-runtime.js'
import { createCloudSyncClient, getCloudSyncClient } from './sync-client.js'
const log=createLogger('cloud-startup')
/** Embedding readiness is independent of authentication and basic memory sync. */
export async function startCloudSyncIfConfigured(db:Database.Database):Promise<void>{
  await refreshDesktopVectorRuntime(db)
  if(!isLoggedIn()||!getConfig().cloud?.sync_enabled||getCloudSyncClient())return
  const client=createCloudSyncClient(db)
  void client.start().catch(error=>log.warn(`sync start failed: ${(error as Error).message}`))
}
