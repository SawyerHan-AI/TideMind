import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { getReembedProgress, reembedAllNodes } from '@server/db/vectors.js'
import { isReembedNeeded } from '@server/db/connection.js'

export function registerEmbeddingHandlers(db: Database.Database): void {
  ipcMain.handle('embedding:reembed-status', () => {
    const progress = getReembedProgress()
    return {
      needed: isReembedNeeded(),
      running: progress.running,
      done: progress.done,
      total: progress.total,
    }
  })

  ipcMain.handle('embedding:trigger-reembed', async () => {
    try {
      await reembedAllNodes(db)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
