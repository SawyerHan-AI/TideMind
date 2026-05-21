import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getClientDb } from '../db.js'
import { probeAnthropic, probeVertex, probeGemini, probeOllama, probeOpenAICompatible } from './health.js'
import { validateConnectionId, validateProviderType, assertPathWithinRoot } from './_validate.js'
import { clearClientCache } from '../../../src/llm/client.js'
import { resetCircuitBreaker } from '../../../src/metabolism/scheduler.js'

function generateConnectionId(): string {
  return 'mc_' + randomBytes(4).toString('hex')
}

function now(): string {
  return new Date().toISOString()
}

/**
 * HIGH 2 (audit-10, 2026-05-21): 8KB credentials JSON 上限抽常量。
 * 之前 create path 有 8192 cap 但 update path 漏检 → 攻击/buggy renderer 可
 * 先 create 1KB 再 update 到 100MB,SQLite 落盘膨胀 + 后续同步推送 OOM。
 * 抽常量保证 create / update 两路一致。
 */
const MAX_CREDENTIALS_BYTES = 8192

/**
 * 安全解析 credentials 字段:DB 里写入的 JSON 字符串可能因升级/手动改库
 * 损坏。直接 `JSON.parse` 会抛错让 IPC handler 崩溃,前端拿到 unhandled
 * rejection 没有有用错误。这里返回空对象作降级,调用方按"未配凭证"路径处理。
 */
function safeParseCredentials(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function registerConnectionHandlers(dataDir: string): void {
  ipcMain.handle('connections:list', (_e, includeArchived?: boolean) => {
    const db = getClientDb()
    const rows = includeArchived
      ? db.prepare('SELECT * FROM model_connections ORDER BY archived ASC, created DESC').all() as any[]
      : db.prepare('SELECT * FROM model_connections WHERE archived = 0 ORDER BY created DESC').all() as any[]
    return rows.map(r => ({ ...r, credentials: undefined, hasCredentials: !!r.credentials }))
  })

  ipcMain.handle('connections:get', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const row = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(validId) as any
    if (!row) return null
    return { ...row, credentials: undefined, hasCredentials: !!row.credentials }
  })

  // 按需取出明文 credentials —— 仅在详情面板需要把已存凭证回填表单时调用,
  // 不进 connections:list(避免列表刷新时把所有连接的密钥扇出到 renderer 内存)。
  // 安全模型:credentials 反正明文存在用户本地 SQLite,UI 上隐藏不是真隔离,
  // 让用户看到自己配过什么 > 强制蒙黑。
  ipcMain.handle('connections:get-credentials', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const row = db.prepare('SELECT credentials FROM model_connections WHERE id = ?').get(validId) as { credentials: string } | undefined
    if (!row) return {}
    return safeParseCredentials(row.credentials)
  })

  ipcMain.handle('connections:create', (_e, params: { name: string; provider_type: string; credentials?: Record<string, unknown> }) => {
    // renderer 输入需校验:provider_type 走白名单防止 DB 里被写入垃圾值,
    // name 限长避免 timeline_events.title 失控膨胀
    const providerType = validateProviderType(params.provider_type)
    const name = typeof params.name === 'string' ? params.name.slice(0, 200).trim() : ''
    if (!name) throw new Error('Invalid connection name')

    const db = getClientDb()
    const id = generateConnectionId()
    const created = now()
    const creds = JSON.stringify(params.credentials ?? {})
    // F8 (audit-9): credentials JSON 上限 8KB,API key / project_id 类参数远不到这个量。
    // 没有上限的话恶意 / 出 bug 的 renderer 能把 100MB 字符串塞进 SQLite,后续 SELECT/
    // 同步推送都被拖累(也会让 cloud-server 的 reconcile size limit 失效)。
    if (creds.length > MAX_CREDENTIALS_BYTES) {
      throw new Error(`credentials too large (> ${MAX_CREDENTIALS_BYTES} bytes JSON)`)
    }
    db.prepare(
      'INSERT INTO model_connections (id, name, provider_type, credentials, created) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, providerType, creds, created)

    try {
      db.prepare(`
        INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
        VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
      `).run(
        `创建了模型连接: ${name}`,
        JSON.stringify({ section: 'model_connection', action: 'create', connection_name: name, connection_id: id }),
      )
    } catch {}

    return {
      id, name, provider_type: providerType,
      credentials: creds, status: 'unconfigured',
      available_models: null, last_checked: null,
      archived: 0, created,
    }
  })

  ipcMain.handle('connections:update', (_e, id: unknown, params: { name?: string; credentials?: Record<string, unknown> }) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    const sets: string[] = []
    const values: unknown[] = []
    if (params.name !== undefined) {
      const trimmed = typeof params.name === 'string' ? params.name.slice(0, 200).trim() : ''
      if (!trimmed) throw new Error('Invalid connection name')
      sets.push('name = ?'); values.push(trimmed)
    }
    if (params.credentials !== undefined) {
      const creds = JSON.stringify(params.credentials)
      // HIGH 2 (audit-10): 跟 create 一致的 8KB cap;之前 update 漏检让 renderer
      // 能先 create 小 payload 再 update 到任意大小绕过 create 的限制。
      if (creds.length > MAX_CREDENTIALS_BYTES) {
        throw new Error(`credentials too large (> ${MAX_CREDENTIALS_BYTES} bytes JSON)`)
      }
      sets.push('credentials = ?')
      values.push(creds)
    }
    if (sets.length === 0) return
    values.push(validId)
    db.prepare(`UPDATE model_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    // 2026-05-21: 凭据变更后主动清 LLM client cache + 重置熔断器。
    // 用户改 connection 等同于"我在主动修复 LLM 问题",不应该让旧的熔断状态继续挡。
    // 注意只在 credentials 变更时清,纯改 name 不动 LLM 调用路径。
    if (params.credentials !== undefined) {
      try {
        clearClientCache()
        resetCircuitBreaker(db)
      } catch {
        // 自愈逻辑失败不能让 connection update 整体失败
      }
    }
  })

  ipcMain.handle('connections:archive', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 1 WHERE id = ?').run(validId)
  })

  ipcMain.handle('connections:unarchive', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    db.prepare('UPDATE model_connections SET archived = 0 WHERE id = ?').run(validId)
  })

  ipcMain.handle('connections:delete', (_e, id: unknown) => {
    const validId = validateConnectionId(id)
    const db = getClientDb()
    db.prepare('DELETE FROM model_connections WHERE id = ?').run(validId)
  })

  // 统一测试连接入口
  ipcMain.handle('connections:test', async (_e, connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    const db = getClientDb()
    const conn = db.prepare('SELECT * FROM model_connections WHERE id = ?').get(validId) as {
      id: string; provider_type: string; credentials: string
    } | undefined
    if (!conn) return { online: false, models: [], error: '连接不存在' }

    // credentials 解析失败时降级为空对象,避免 IPC 崩溃
    const creds = safeParseCredentials(conn.credentials)
    let result: { online: boolean; models: string[]; error?: string; region?: string }

    switch (conn.provider_type) {
      case 'anthropic':
        result = await probeAnthropic(typeof creds.api_key === 'string' ? creds.api_key : '')
        break
      case 'vertex': {
        const credPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
        // 也检查旧的全局凭证文件作为回退
        const fallbackCredPath = path.join(dataDir, 'vertex-credentials.json')
        const actualCredPath = fs.existsSync(credPath) ? credPath : fallbackCredPath
        result = await probeVertex(
          typeof creds.project_id === 'string' ? creds.project_id : '',
          typeof creds.region === 'string' ? creds.region : 'us-central1',
          actualCredPath,
        )
        break
      }
      case 'gemini':
        result = await probeGemini(typeof creds.api_key === 'string' ? creds.api_key : '')
        break
      case 'ollama': {
        // F11 (audit-9): URL scheme 校验,挡 file:// / ftp:// / gopher:// 等绕路。
        // Ollama 是用户的本地服务,默认 localhost,这里允许任意 http(s) 地址
        // (LAN 部署 / 公司内网都是真实场景),只拒非 http(s) 协议。
        const rawUrl = typeof creds.url === 'string' ? creds.url : 'http://localhost:11434'
        try {
          const parsed = new URL(rawUrl)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            result = { online: false, models: [], error: 'Ollama URL 协议必须是 http/https' }
            break
          }
        } catch (e) {
          result = { online: false, models: [], error: `Ollama URL 无效: ${(e as Error).message}` }
          break
        }
        result = await probeOllama(rawUrl)
        break
      }
      case 'openai-compatible': {
        // F11 (audit-9): OpenAI 兼容端点应是公网或受信内网,挡 file:// 等非 http(s)。
        // 私网 IP 不强制拒(用户可能自建 OpenAI 兼容服务),但留 TODO。
        const baseUrl = typeof creds.base_url === 'string' ? creds.base_url : ''
        if (baseUrl) {
          try {
            const parsed = new URL(baseUrl)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              result = { online: false, models: [], error: 'base_url 协议必须是 http/https' }
              break
            }
          } catch (e) {
            result = { online: false, models: [], error: `base_url 无效: ${(e as Error).message}` }
            break
          }
        }
        result = await probeOpenAICompatible(
          baseUrl,
          typeof creds.api_key === 'string' ? creds.api_key : undefined,
        )
        break
      }
      default:
        result = { online: false, models: [], error: `未知 provider 类型: ${conn.provider_type}` }
    }

    // 更新状态到数据库
    // Audit-3 F11 修复:仅在成功(online + 有 models)时才回写 available_models。
    // 之前测试失败会把 available_models 设回 null,丢掉用户上次成功时拿到的型号列表 —
    // UI 上"模型下拉"瞬间变空,但其实凭证可能只是瞬时不可用。保留上次的 list 让 UI 仍可用。
    const status = result.online ? 'online' : 'offline'
    const cols = ['status = ?', 'last_checked = ?']
    const params: unknown[] = [status, now()]
    if (result.online && result.models.length > 0) {
      cols.push('available_models = ?')
      params.push(JSON.stringify(result.models))
    }
    db.prepare(
      `UPDATE model_connections SET ${cols.join(', ')} WHERE id = ?`,
    ).run(...params, validId)

    return result
  })

  // Vertex 凭证文件上传（按 connection_id 存储）
  ipcMain.handle('connections:pick-vertex-file', async (_e, connectionId: unknown) => {
    // 历史漏洞:connectionId 来自 renderer 完全未校验,直接拼到
    // `vertex-credentials-${connectionId}.json` → 攻击者可传
    // `../../../../etc/foo` 把任意位置覆盖成 SA JSON。同时 fs.copyFileSync 的
    // 默认权限是 0644,SA 私钥落盘默认可读,保留窗口期(改为
    // writeFileSync({mode: 0o600}) 一次性创建权限受限文件)。
    const validId = validateConnectionId(connectionId)
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

      // 复制到数据目录(按 validId 命名)。validId 已正则白名单卡住,
      // assertPathWithinRoot 是纵深兜底——确认拼接结果落在 dataDir 内。
      const destPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
      assertPathWithinRoot(destPath, dataDir)
      // 用 mode: 0o600 一次性创建受限权限文件,避免 copyFileSync + chmodSync
      // 之间默认 0644 可读窗口。content 已读到内存,直接写。
      // 加固:writeFileSync 的 mode 仅在创建新文件时应用,先 unlink 确保
      // 已存在的旧 0644 文件升级后真变成 0600。
      try { fs.unlinkSync(destPath) } catch { /* 不存在或无权限 */ }
      fs.writeFileSync(destPath, content, { mode: 0o600 })

      // 同时更新 connection 的 credentials（project_id）
      const db = getClientDb()
      const conn = db.prepare('SELECT credentials FROM model_connections WHERE id = ?').get(validId) as { credentials: string } | undefined
      if (conn) {
        const creds = safeParseCredentials(conn.credentials)
        if (parsed.project_id) creds.project_id = parsed.project_id
        db.prepare('UPDATE model_connections SET credentials = ? WHERE id = ?').run(JSON.stringify(creds), validId)
        // 2026-05-21 (audit A.H2 / C.H3): 上传新 SA 文件后,即使 project_id 不变,
        // 文件内容已经换了(私钥/客户端 email 不同),GoogleAuth 内部 cachedCredential
        // 还会沿用旧 JWT。必须 clearClientCache() 让 SDK 重建,resetCircuitBreaker
        // 让上次因旧凭证失败积累的熔断状态清掉(用户上传新 SA 通常就是为了修这个)。
        try {
          clearClientCache()
          resetCircuitBreaker(db)
        } catch {
          // 自愈失败不能阻挡 SA 上传整体成功
        }
      }

      try {
        db.prepare(`
          INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
          VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
        `).run(
          '上传了 Vertex AI 凭证',
          JSON.stringify({ section: 'model_connection', action: 'upload_vertex_cred', connection_id: validId }),
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
  ipcMain.handle('connections:vertex-cred-status', (_e, connectionId: unknown) => {
    const validId = validateConnectionId(connectionId)
    // 优先检查按 connectionId 命名的凭证文件
    const credPath = path.join(dataDir, `vertex-credentials-${validId}.json`)
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
