import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getClientDb } from '../db.js'
import { probeAnthropic, probeVertex, probeGemini, probeOllama, probeOpenAICompatible } from './health.js'

function generateConnectionId(): string {
  return 'mc_' + randomBytes(4).toString('hex')
}

function now(): string {
  return new Date().toISOString()
}

export function registerConnectionHandlers(dataDir: string): void {
  ipcMain.handle('connections:list', (_e, includeArchived?: boolean) => {
    const db = getClientDb()
    const rows = includeArchived
      ? db.prepare('SELECT * FROM model_connections ORDER BY archived ASC, created DESC').all() as any[]
      : db.prepare('SELECT * FROM model_connections WHERE archived = 0 ORDER BY created DESC').all() as any[]
    return rows.map(r => ({ ...r, credentials: undefined, hasCredentials: !!r.credentials }))
  })

  ipcMain.handle('connections:get', (_e, id: string) => {
    const db = getClientDb()
    const row = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as any
    if (!row) return null
    return { ...row, credentials: undefined, hasCredentials: !!row.credentials }
  })

  ipcMain.handle('connections:create', (_e, params: { name: string; provider_type: string; credentials?: Record<string, unknown> }) => {
    const db = getClientDb()
    const id = generateConnectionId()
    const created = now()
    const creds = JSON.stringify(params.credentials ?? {})
    db.prepare(
      'INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)',
    ).run(id, params.name, params.provider_type, creds, created)

    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        `创建了模型连接: ${params.name}`,
        JSON.stringify({ section: 'model_connection', action: 'create', connection_name: params.name, connection_id: id }),
      )
    } catch {}

    return {
      id, name: params.name, provider_type: params.provider_type,
      credentials: creds, status: 'unconfigured',
      available_models: null, last_checked: null,
      archived: 0, created,
    }
  })

  ipcMain.handle('connections:update', (_e, id: string, params: { name?: string; credentials?: Record<string, unknown> }) => {
    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name) }
    if (params.credentials !== undefined) { sets.push('credentials = ?'); values.push(JSON.stringify(params.credentials)) }
    if (sets.length === 0) return
    values.push(id)
    db.prepare(`UPDATE model_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  })

  ipcMain.handle('connections:archive', (_e, id: string) => {
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(id)
  })

  ipcMain.handle('connections:unarchive', (_e, id: string) => {
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 0 WHERE id = ?').run(id)
  })

  ipcMain.handle('connections:delete', (_e, id: string) => {
    const db = getClientDb()
    db.prepare('DELETE FROM model_connections WHERE id = ?').run(id)
  })

  // 统一测试连接入口
  ipcMain.handle('connections:test', async (_e, connectionId: string) => {
    const db = getClientDb()
    const conn = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(connectionId) as {
      id: string; provider_type: string; credentials: string
    } | undefined
    if (!conn) return { online: false, models: [], error: '连接不存在' }

    const creds = JSON.parse(conn.credentials)
    let result: { online: boolean; models: string[]; error?: string; region?: string }

    switch (conn.provider_type) {
      case 'anthropic':
        result = await probeAnthropic(creds.api_key ?? '')
        break
      case 'vertex': {
        const credPath = path.join(dataDir, `vertex-credentials-${connectionId}.json`)
        // 也检查旧的全局凭证文件作为回退
        const fallbackCredPath = path.join(dataDir, 'vertex-credentials.json')
        const actualCredPath = fs.existsSync(credPath) ? credPath : fallbackCredPath
        result = await probeVertex(creds.project_id ?? '', creds.region ?? 'us-central1', actualCredPath)
        break
      }
      case 'gemini':
        result = await probeGemini(creds.api_key ?? '')
        break
      case 'ollama':
        result = await probeOllama(creds.url ?? 'http://localhost:11434')
        break
      case 'openai-compatible':
        result = await probeOpenAICompatible(creds.base_url ?? '', creds.api_key)
        break
      default:
        result = { online: false, models: [], error: `未知 provider 类型: ${conn.provider_type}` }
    }

    // 更新状态到数据库
    const status = result.online ? 'online' : 'offline'
    db.prepare(
      'UPDATE model_connections SET status = ?, available_models = ?, last_checked = ? WHERE id = ?',
    ).run(status, result.models.length > 0 ? JSON.stringify(result.models) : null, now(), connectionId)

    return result
  })

  // Vertex 凭证文件上传（按 connection_id 存储）
  ipcMain.handle('connections:pick-vertex-file', async (_e, connectionId: string) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择 Google Cloud Service Account JSON 文件',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const sourcePath = result.filePaths[0]
      const content = fs.readFileSync(sourcePath, 'utf-8')

      let parsed: any
      try {
        parsed = JSON.parse(content)
      } catch {
        return { success: false, error: '文件不是合法的 JSON' }
      }

      if (parsed.type !== 'service_account') {
        return { success: false, error: '不是 Service Account 类型的凭证文件' }
      }

      // 复制到数据目录（按 connectionId 命名）
      const destPath = path.join(dataDir, `vertex-credentials-${connectionId}.json`)
      fs.copyFileSync(sourcePath, destPath)

      // 同时更新 connection 的 credentials（project_id）
      const db = getClientDb()
      const conn = db.prepare('SELECT credentials FROM model_connections WHERE id = ?').get(connectionId) as { credentials: string } | undefined
      if (conn) {
        const creds = JSON.parse(conn.credentials)
        if (parsed.project_id) creds.project_id = parsed.project_id
        db.prepare('UPDATE model_connections SET credentials = ? WHERE id = ?').run(JSON.stringify(creds), connectionId)
      }

      try {
        db.prepare(`
          INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
          VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
        `).run(
          '上传了 Vertex AI 凭证',
          JSON.stringify({ section: 'model_connection', action: 'upload_vertex_cred', connection_id: connectionId }),
        )
      } catch {}

      return {
        success: true,
        projectId: parsed.project_id ?? '',
      }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // Vertex 凭证状态检查
  ipcMain.handle('connections:vertex-cred-status', (_e, connectionId: string) => {
    // 优先检查按 connectionId 命名的凭证文件
    const credPath = path.join(dataDir, `vertex-credentials-${connectionId}.json`)
    const fallbackPath = path.join(dataDir, 'vertex-credentials.json')
    const actualPath = fs.existsSync(credPath) ? credPath : fallbackPath

    if (!fs.existsSync(actualPath)) {
      return { configured: false }
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(actualPath, 'utf-8'))
      return { configured: true, projectId: parsed.project_id ?? '' }
    } catch {
      return { configured: false }
    }
  })
}
