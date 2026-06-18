import { ipcMain } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

/**
 * 安全递归遍历目录(M26 修复 2026-05-09)。
 *
 * 历史 bug:health:logseq / health:obsidian 用裸 walk 函数同步递归用户 vault,
 * 没有 symlink 循环检测,也没有最大深度上限。用户输入恶意/过深路径(含
 * symlink loop)会让主进程进入死循环或耗尽 fd(EMFILE)。同时同步递归大目录
 * 时主进程被阻塞,UI 卡顿。
 *
 * 这里在保留同步语义(IPC handler 简单)的前提下补三道护栏:
 *   - 跳过符号链接(`isSymbolicLink()`),消除链环
 *   - 最大深度 20 层,防止极深路径无意义递归
 *   - 文件数硬上限 50000,防止超大 vault 把 entries 数组撑爆
 */
// excludeDirs 支持两种形式:
//   - 单段名(`'.git'`、`'node_modules'`):匹配 entry.name(任意层级);
//   - 含 `/` 的相对前缀(`'logseq/bak'`、`'logseq/.recycle'`):匹配从 rootDir
//     起算的 relPath 前缀。修复(2026-05-10):老版只比 entry.name 让 `'logseq/bak'`
//     之类规则永远不命中(basename 不含 `/`),logseq 的 .bak 备份会被算进 fileCount。
function walkSafe(
  rootDir: string,
  entries: string[],
  extensions: string[],
  excludeDirs: Set<string>,
  maxDepth: number = 20,
  maxEntries: number = 50000,
): void {
  const namePatterns = new Set<string>();
  const prefixPatterns: string[] = [];
  for (const p of excludeDirs) {
    if (p.includes('/')) prefixPatterns.push(p.replace(/\\/g, '/'));
    else namePatterns.add(p);
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    if (entries.length >= maxEntries) return;
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 单目录读失败不影响兄弟目录
    }
    for (const entry of dirEntries) {
      if (entries.length >= maxEntries) return;
      // 跳过符号链接,避免循环和读到无关位置
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (namePatterns.has(entry.name)) continue;
        // path-prefix 形式:把 full 转成相对 rootDir 的 posix path 比对
        const rel = path.relative(rootDir, full).split(path.sep).join('/');
        if (prefixPatterns.some(p => rel === p || rel.startsWith(p + '/'))) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) entries.push(entry.name);
      }
    }
  }
}

// ============================================================
// 可复用的探测函数（供 connections IPC 调用）
// ============================================================

export interface ProbeResult {
  online: boolean
  models: string[]
  error?: string
  region?: string  // Vertex 专用
}

export async function probeAnthropic(apiKey: string): Promise<ProbeResult> {
  if (!apiKey) return { online: false, models: [], error: 'API key not configured' }
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return { online: false, models: [], error: `HTTP ${resp.status}` }
    const data = await resp.json() as { data?: Array<{ id: string }> }
    const models = data.data?.map(m => m.id) ?? []
    return { online: models.length > 0, models }
  } catch (e) {
    return { online: false, models: [], error: (e as Error).message }
  }
}

export async function probeVertex(projectId: string, region: string, credPath: string): Promise<ProbeResult> {
  if (!fs.existsSync(credPath)) return { online: false, models: [], error: '凭证文件未上传' }
  if (!projectId) return { online: false, models: [], error: 'Project ID 未配置' }

  const CANDIDATE_MODELS = [
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
    'claude-opus-4-5', 'claude-sonnet-4-5',
  ]
  const FALLBACK_REGIONS = ['us-east5', 'europe-west1', 'us-central1']
  const regionsToTry = [region, ...FALLBACK_REGIONS.filter(r => r !== region)]

  try {
    const AnthropicVertex = (await import('@anthropic-ai/vertex-sdk')).default
    const { GoogleAuth } = await import('google-auth-library')

    for (const r of regionsToTry) {
      const client = new AnthropicVertex({
        projectId, region: r,
        googleAuth: new GoogleAuth({
          keyFile: credPath,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        }),
      })

      const results = await Promise.allSettled(
        CANDIDATE_MODELS.map(async (model) => {
          await client.messages.create(
            { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
            { signal: AbortSignal.timeout(15000) },
          )
          return model
        }),
      )

      const available = results
        .filter((res): res is PromiseFulfilledResult<string> => res.status === 'fulfilled')
        .map(res => res.value)

      if (available.length > 0) {
        return { online: true, models: available, region: r }
      }
    }

    return { online: false, models: [], region, error: '所有候选模型均不可用' }
  } catch (e) {
    return { online: false, models: [], region, error: (e as Error).message }
  }
}

export async function probeGemini(apiKey: string): Promise<ProbeResult> {
  if (!apiKey) return { online: false, models: [], error: 'Gemini API key 未配置' }
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return { online: false, models: [], error: `HTTP ${resp.status}` }
    const data = await resp.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> }
    const models = data.models
      ?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(id => id.startsWith('gemini-')) ?? []
    return { online: models.length > 0, models }
  } catch (e) {
    return { online: false, models: [], error: (e as Error).message }
  }
}

export async function probeOpenAICompatible(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
  if (!baseUrl) return { online: false, models: [], error: 'Base URL not configured' }
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    // 规范化 URL：确保以 /v1/models 结尾，无论用户是否已包含 /v1
    const normalized = baseUrl.replace(/\/+$/, '')
    const modelsUrl = normalized.endsWith('/v1')
      ? `${normalized}/models`
      : `${normalized}/v1/models`

    const resp = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return { online: false, models: [], error: `HTTP ${resp.status}` }
    const data = await resp.json() as { data?: Array<{ id: string }> }
    const models = data.data?.map(m => m.id) ?? []
    return { online: models.length > 0, models }
  } catch (e) {
    return { online: false, models: [], error: (e as Error).message }
  }
}

export async function probeOllama(url: string): Promise<ProbeResult> {
  try {
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) return { online: false, models: [] }
    const data = await resp.json() as { models?: Array<{ name: string }> }
    const models = data.models?.map(m => m.name) ?? []
    return { online: true, models }
  } catch {
    return { online: false, models: [] }
  }
}

// ============================================================
// IPC handlers（旧接口保留向后兼容）
// ============================================================

export function registerHealthHandlers(dataDir: string): void {
  ipcMain.handle('health:ollama', async () => {
    let url = 'http://localhost:11434'
    let isOllamaUsed = false
    const configPath = path.join(dataDir, 'config.toml')
    if (fs.existsSync(configPath)) {
      try {
        const config = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        if (config.ollama?.url) url = config.ollama.url
        isOllamaUsed = config.embedding?.provider === 'ollama'
      } catch {}
    }
    if (!isOllamaUsed) return null
    const result = await probeOllama(url)
    return result.online ? { online: true, models: result.models } : { online: false }
  })

  ipcMain.handle('health:anthropic-models', async () => {
    let apiKey = process.env.ANTHROPIC_API_KEY ?? ''
    const configPath = path.join(dataDir, 'config.toml')
    if (fs.existsSync(configPath)) {
      try {
        const config = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        if (config.anthropic?.api_key) apiKey = config.anthropic.api_key
      } catch {}
    }
    return await probeAnthropic(apiKey)
  })

  ipcMain.handle('health:vertex', () => {
    const credPath = path.join(dataDir, 'vertex-credentials.json')
    const configPath2 = path.join(dataDir, 'config.toml')

    let projectId = ''
    let region = 'global'
    if (fs.existsSync(configPath2)) {
      try {
        const cfg = parseToml(fs.readFileSync(configPath2, 'utf-8')) as any
        if (cfg.vertex?.project_id) projectId = cfg.vertex.project_id
        if (cfg.vertex?.region) region = cfg.vertex.region
      } catch {}
    }

    const hasCredentials = fs.existsSync(credPath)
    // 如果 config 中没有 projectId，尝试从凭证文件中读取
    if (!projectId && hasCredentials) {
      try {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
        if (cred.project_id) projectId = cred.project_id
      } catch {}
    }
    const configured = hasCredentials && !!projectId
    return { configured, projectId, region, hasCredentials }
  })

  // Vertex AI 没有"列出可用 partner models"的 API，只能通过探测法检测
  ipcMain.handle('health:vertex-models', async () => {
    const credPath = path.join(dataDir, 'vertex-credentials.json')
    const configPath3 = path.join(dataDir, 'config.toml')
    let configRegion = 'us-east5'
    let projectId = ''
    if (fs.existsSync(configPath3)) {
      try {
        const cfg = parseToml(fs.readFileSync(configPath3, 'utf-8')) as any
        if (cfg.vertex?.region) configRegion = cfg.vertex.region
        if (cfg.vertex?.project_id) projectId = cfg.vertex.project_id
      } catch {}
    }
    if (!projectId) {
      try {
        const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
        if (cred.project_id) projectId = cred.project_id
      } catch {}
    }
    return await probeVertex(projectId, configRegion, credPath)
  })

  ipcMain.handle('health:gemini-embedding', async () => {
    const configPath4 = path.join(dataDir, 'config.toml')
    let useVertex = true
    let geminiApiKey = ''
    let region = 'us-central1'
    let projectId = ''

    if (fs.existsSync(configPath4)) {
      try {
        const cfg = parseToml(fs.readFileSync(configPath4, 'utf-8')) as any
        useVertex = cfg.embedding?.provider === 'vertex' || (cfg.embedding?.provider == null)
        geminiApiKey = cfg.gemini?.api_key ?? ''
        const r = cfg.vertex?.region ?? 'us-central1'
        region = r === 'global' ? 'us-central1' : r
        projectId = cfg.vertex?.project_id ?? ''
      } catch {}
    }

    if (useVertex) {
      const credPath = path.join(dataDir, 'vertex-credentials.json')
      if (!fs.existsSync(credPath)) return { online: false, error: '未上传 Vertex AI 凭证' }
      if (!projectId) {
        try {
          const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
          projectId = cred.project_id ?? ''
        } catch {}
      }
      if (!projectId) return { online: false, error: '无 Project ID' }

      try {
        const { GoogleAuth } = await import('google-auth-library')
        const auth = new GoogleAuth({
          keyFile: credPath,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        })
        const client = await auth.getClient()
        const token = await client.getAccessToken()
        const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/gemini-embedding-001:predict`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances: [{ content: 'test' }] }),
          signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok) return { online: false, error: `HTTP ${resp.status}` }
        return { online: true }
      } catch (e) {
        return { online: false, error: (e as Error).message }
      }
    } else {
      if (!geminiApiKey) return { online: false, error: 'Gemini API key 未配置' }
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiApiKey}`
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text: 'test' }] } }),
          signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok) return { online: false, error: `HTTP ${resp.status}` }
        return { online: true }
      } catch (e) {
        return { online: false, error: (e as Error).message }
      }
    }
  })

  ipcMain.handle('health:anthropic', () => {
    const configPath = path.join(dataDir, 'config.toml')
    let apiKey = process.env.ANTHROPIC_API_KEY ?? ''

    if (fs.existsSync(configPath)) {
      try {
        const config = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        if (config.anthropic?.api_key) apiKey = config.anthropic.api_key
      } catch {}
    }

    return { configured: !!apiKey }
  })

  ipcMain.handle('health:gemini-models', async () => {
    const configPath = path.join(dataDir, 'config.toml')
    let apiKey = ''
    if (fs.existsSync(configPath)) {
      try {
        const cfg = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        apiKey = cfg.gemini?.api_key ?? ''
      } catch {}
    }
    return await probeGemini(apiKey)
  })

  ipcMain.handle('health:logseq', async () => {
    const configPath = path.join(dataDir, 'config.toml')
    let watchPath = ''
    if (fs.existsSync(configPath)) {
      try {
        const config = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        watchPath = config.sources?.logseq?.path ?? ''
      } catch {}
    }
    if (!watchPath) return { accessible: false, fileCount: 0, path: '' }
    // 锚定正则:只展开开头的 `~`,不替换路径中间的 `~`(与 _schemas.ts 一致)。
    const resolved = watchPath.replace(/^~(?=$|\/)/, os.homedir())
    if (!fs.existsSync(resolved)) return { accessible: false, fileCount: 0, path: resolved }
    try {
      const entries: string[] = []
      const excludeDirs = new Set(['logseq/bak', 'logseq/.recycle', 'assets', '.git', 'node_modules'])
      walkSafe(resolved, entries, ['.md'], excludeDirs)
      return { accessible: true, fileCount: entries.length, path: resolved }
    } catch {
      return { accessible: false, fileCount: 0, path: resolved }
    }
  })

  ipcMain.handle('health:obsidian', async () => {
    const configPath = path.join(dataDir, 'config.toml')
    let watchPath = ''
    if (fs.existsSync(configPath)) {
      try {
        const config = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
        watchPath = config.sources?.obsidian?.path ?? ''
      } catch {}
    }
    if (!watchPath) return { accessible: false, fileCount: 0, path: '' }
    // 锚定正则:只展开开头的 `~`,不替换路径中间的 `~`(与 _schemas.ts 一致)。
    const resolved = watchPath.replace(/^~(?=$|\/)/, os.homedir())
    if (!fs.existsSync(resolved)) return { accessible: false, fileCount: 0, path: resolved }
    try {
      const entries: string[] = []
      const excludeDirs = new Set(['.obsidian', '.git', '.trash', 'node_modules'])
      walkSafe(resolved, entries, ['.md', '.canvas'], excludeDirs)
      return { accessible: true, fileCount: entries.length, path: resolved }
    } catch {
      return { accessible: false, fileCount: 0, path: resolved }
    }
  })

  ipcMain.handle('health:storage', () => {
    const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')
    const streamDir = path.join(dataDir, 'stream')

    let dbSize = 0
    if (fs.existsSync(dbPath)) {
      dbSize = fs.statSync(dbPath).size
    }

    let streamFiles = 0
    if (fs.existsSync(streamDir)) {
      streamFiles = fs.readdirSync(streamDir).filter(f => f.endsWith('.md')).length
    }

    return { path: dataDir, dbSize, streamFiles }
  })
}
