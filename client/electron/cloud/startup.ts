import type Database from 'better-sqlite3'
import { getConfig } from '@server/config.js'
import { createLogger } from '@server/utils/logger.js'
import { isLoggedIn } from './auth-client.js'
import { refreshDesktopVectorRuntime } from './vector-runtime.js'
import { evaluateLocalRole } from './primary-device.js'
import { createCloudSyncClient, getCloudSyncClient } from './sync-client.js'
const log=createLogger('cloud-startup')
/** Embedding readiness is independent of authentication and basic memory sync. */
export async function startCloudSyncIfConfigured(db:Database.Database):Promise<void>{
  // 登录状态或同步开关可能刚变化:先按当前状态求值本机角色(不联网)。
  evaluateLocalRole(db)
  await refreshDesktopVectorRuntime(db)
  if(!isLoggedIn()||!getConfig().cloud?.sync_enabled||getCloudSyncClient())return
  const client=createCloudSyncClient(db)
  void client.start().catch(error=>log.warn(`sync start failed: ${(error as Error).message}`))
}
