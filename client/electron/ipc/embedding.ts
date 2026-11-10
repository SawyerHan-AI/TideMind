import { isSyncBootstrapCheck } from '../sync-bootstrap.js'
import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { getReembedProgress, reembedAllNodes } from '@server/db/vectors.js'
import { getVectorReadiness } from '@server/db/vector-readiness.js'

export function registerEmbeddingHandlers(db: Database.Database): void {
  ipcMain.handle('embedding:reembed-status', () => {
    const progress = getReembedProgress()
    const coverage=getVectorReadiness(db)
    return {
      coverage,
      canRebuild: !isSyncBootstrapCheck(),
      needed: coverage.mode!=='ready',
      running: progress.running,
      done: progress.done,
      total: progress.total,
    }
  })

  ipcMain.handle('embedding:trigger-reembed', async () => {
    if(isSyncBootstrapCheck())return {success:false,error:'sync_bootstrap_active'}
    try {
      const complete=await reembedAllNodes(db)
      return { success: complete, ...(complete?{}:{error:'embedding_incomplete'}) }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
