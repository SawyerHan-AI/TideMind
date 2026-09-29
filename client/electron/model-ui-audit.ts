import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { parse, stringify } from 'smol-toml'
import { buildConnectionModelsView, type RouteConfigLike } from '@server/llm/model-catalog-view.js'

/** Only called after the unpackaged, canonical audit HOME/root guard succeeds.
 * Exercises real preload/renderer/read-model with synthetic DB rows. No CLI,
 * credential, network or provider-generation handler is registered here.
 */
export function registerModelCatalogUiAuditHandlers(db: Database.Database, dataDir: string): void {
  const configPath = path.join(dataDir, 'config.toml')
  ipcMain.handle('connections:list', () => db.prepare('SELECT * FROM model_connections').all())
  ipcMain.handle('connections:models', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.startsWith('mc_ui_audit_')) throw new Error('fixture connection required')
    const connection = db.prepare('SELECT id, provider_type, status FROM model_connections WHERE id = ?').get(id) as {
      id: string; provider_type: string; status: string
    } | undefined
    if (!connection) throw new Error('fixture connection missing')
    return buildConnectionModelsView(db, connection, parse(fs.readFileSync(configPath, 'utf8')) as unknown as RouteConfigLike)
  })
  ipcMain.handle('embedding:reembed-status', () => ({ needed: false, running: false, done: 0, total: 0 }))
  ipcMain.handle('config:update', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid fixture config')
    const parts = patch as Record<string, unknown>
    if (Object.keys(parts).some(key => !['llm', 'embedding'].includes(key))) throw new Error('only fixture model routes may be edited')
    const llm = parts.llm as Record<string, unknown>
    if (!llm || Object.values(llm).some(value => value !== undefined && typeof value !== 'string')) throw new Error('invalid fixture routes')
    for (const tier of ['light', 'standard', 'heavy']) {
      if (llm[`${tier}_connection`] !== 'mc_ui_audit_codex') throw new Error('only the fixture connection may be selected')
    }
    const current = parse(fs.readFileSync(configPath, 'utf8'))
    const embedding = parts.embedding as Record<string, unknown> | undefined
    const originalEmbedding = current.embedding as Record<string, unknown> | undefined
    if (embedding?.model !== originalEmbedding?.model || embedding?.dimensions !== originalEmbedding?.dimensions) {
      throw new Error('generation model selection unexpectedly changed embedding')
    }
    // Embedding is intentionally unchanged; its production mutation API is absent.
    const next = { ...current, llm: { ...(current.llm as Record<string, unknown>), ...llm } }
    fs.writeFileSync(configPath, stringify(next), { mode: 0o600 })
    return { success: true }
  })
}
