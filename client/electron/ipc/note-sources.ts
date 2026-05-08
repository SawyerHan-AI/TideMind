import { ipcMain, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getClientDb } from '../db.js'
import {
  listNoteSources, getNoteSource, createNoteSource, updateNoteSource,
  archiveNoteSource, unarchiveNoteSource, deleteNoteSource,
  markInitialized, getNoteSourceStats,
} from '@server/integrations/shared/note-sources.js'
import { getDb } from '@server/db/connection.js'
import { createLogger } from '@server/utils/logger.js'
import {
  initSessionManager,
  type InitSessionContext,
  type InitSessionSnapshot,
} from '@server/integrations/shared/init-session.js'
import {
  parseNoteSourceCreate,
  parseNoteSourceId,
  parseNoteSourcePath,
  parseNoteSourceTest,
  parseNoteSourceUpdate,
  parseOptionalBoolean,
} from './_schemas.js'

const log = createLogger('note-sources-ipc')

function isTerminalStatus(status: InitSessionSnapshot['status']): boolean {
  return status === 'done' || status === 'aborted' || status === 'error'
}

/** 等会话进入终态（done / aborted / error），返回最终 snapshot。 */
async function waitForTerminal(sourceId: string): Promise<InitSessionSnapshot> {
  return new Promise((resolve) => {
    let off: (() => void) | null = null
    const finish = (snap: InitSessionSnapshot) => {
      if (off) { off(); off = null }
      resolve(snap)
    }
    // 先订阅再轮询当前状态，避免事件已发出后注册晚了
    off = initSessionManager.on('transition', (snap) => {
      if (snap.sourceId !== sourceId) return
      if (isTerminalStatus(snap.status)) finish(snap)
    }) as () => void
    const current = initSessionManager.snapshot(sourceId)
    if (!current || isTerminalStatus(current.status)) {
      finish(current ?? {
        sourceId,
        toolType: 'logseq',
        status: 'idle',
        progress: { phase: -1, phaseName: 'idle', current: 0, total: 0, startedAt: null },
        error: null, abortReason: null, report: null,
        canStart: true, canAbort: false, canDiscard: false,
      })
    }
  })
}

/** 把 InitSessionManager 的 transition 事件广播给所有 renderer。 */
function broadcastSessionEvent(snapshot: InitSessionSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('note-sources:session-event', snapshot)
    }
  }
}

/**
 * 注册笔记源管理 IPC handlers
 */
export function registerNoteSourceHandlers(): void {
  // 订阅 SessionManager 全局事件，广播到所有 renderer
  initSessionManager.on('transition', broadcastSessionEvent)

  ipcMain.handle('note-sources:list', (_e, includeArchived?: boolean) => {
    const parsed = parseOptionalBoolean(includeArchived, 'includeArchived')
    if (!parsed.ok) return parsed.error

    return listNoteSources(getClientDb(), parsed.data ?? true)
  })

  ipcMain.handle('note-sources:create', (_e, params: unknown) => {
    const parsed = parseNoteSourceCreate(params)
    if (!parsed.ok) return parsed.error

    return createNoteSource(getClientDb(), parsed.data)
  })

  ipcMain.handle('note-sources:update', (_e, id: unknown, updates: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const parsedUpdates = parseNoteSourceUpdate(updates)
    if (!parsedUpdates.ok) return parsedUpdates.error

    // path 字段需要按 toolType 走白名单：notion/apple-notes 跳过，logseq/obsidian
    // 限制在 homedir / /Volumes / /mnt / /media。create handler 内置了同样的检查，
    // 但 update 时只能在这里查到既存 source 的 toolType 后再做。
    const updates2 = { ...parsedUpdates.data }
    if (updates2.path !== undefined) {
      const existing = getNoteSource(getClientDb(), parsedId.data)
      if (!existing) return { success: false, error: 'invalid_arguments', details: ['source not found'] }
      const checkedPath = parseNoteSourcePath(existing.tool_type as 'logseq' | 'obsidian' | 'apple-notes' | 'notion', updates2.path)
      if (!checkedPath.ok) return checkedPath.error
      updates2.path = checkedPath.data
    }

    updateNoteSource(getClientDb(), parsedId.data, updates2)
  })

  ipcMain.handle('note-sources:archive', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return

    archiveNoteSource(getClientDb(), parsedId.data)

    // 停止该笔记源的监听
    try {
      if (source.tool_type === 'logseq') {
        const { stopLogseqSource } = await import('@server/integrations/logseq/index.js')
        stopLogseqSource(parsedId.data)
      } else if (source.tool_type === 'obsidian') {
        const { stopObsidianSource } = await import('@server/integrations/obsidian/index.js')
        stopObsidianSource(parsedId.data)
      } else if (source.tool_type === 'apple-notes') {
        const { stopAppleNotesSource } = await import('@server/integrations/apple-notes/index.js')
        stopAppleNotesSource(parsedId.data)
      } else if (source.tool_type === 'notion') {
        const { stopNotionSource } = await import('@server/integrations/notion/index.js')
        stopNotionSource(parsedId.data)
      }
    } catch { /* ignore */ }
  })

  ipcMain.handle('note-sources:unarchive', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return

    unarchiveNoteSource(getClientDb(), parsedId.data)

    // 重新启动监听
    try {
      if (source.tool_type === 'logseq') {
        const { startLogseqSource } = await import('@server/integrations/logseq/index.js')
        await startLogseqSource(getDb(), parsedId.data, source.path, source.poll_interval)
      } else if (source.tool_type === 'obsidian') {
        const { startObsidianSource } = await import('@server/integrations/obsidian/index.js')
        await startObsidianSource(getDb(), parsedId.data, source.path, source.poll_interval)
      } else if (source.tool_type === 'apple-notes') {
        const { startAppleNotesSource } = await import('@server/integrations/apple-notes/index.js')
        await startAppleNotesSource(getDb(), parsedId.data, source.path, source.poll_interval)
      } else if (source.tool_type === 'notion') {
        const { startNotionSource } = await import('@server/integrations/notion/index.js')
        await startNotionSource(getDb(), parsedId.data, source.path, source.poll_interval)
      }
    } catch { /* ignore */ }
  })

  ipcMain.handle('note-sources:stats', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { fileCount: 0, nodeCount: 0, lastSynced: null, syncing: false, accessible: true }

    const stats = getNoteSourceStats(getClientDb(), parsedId.data)

    // 检查路径是否可达
    let accessible: boolean
    if (source.tool_type === 'apple-notes') {
      // Apple Notes 路径含 query params，只检查数据库文件
      const dbPath = source.path.split('?')[0]
      accessible = fs.existsSync(dbPath)
    } else if (source.tool_type === 'notion') {
      // Notion 是云端 API，accessible = token 格式有效
      accessible = source.path.startsWith('notion://') || source.path.startsWith('ntn_') || source.path.startsWith('secret_')
    } else {
      accessible = fs.existsSync(source.path)
    }

    // 检查是否正在同步
    let syncing = false
    try {
      if (source.tool_type === 'logseq') {
        const { getImportProgress } = await import('@server/integrations/logseq/queue.js')
        const prog = getImportProgress(parsedId.data)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      } else if (source.tool_type === 'obsidian') {
        const { getImportProgress } = await import('@server/integrations/obsidian/queue.js')
        const prog = getImportProgress(parsedId.data)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      } else if (source.tool_type === 'apple-notes') {
        const { getImportProgress } = await import('@server/integrations/apple-notes/index.js')
        const prog = getImportProgress(parsedId.data)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      } else if (source.tool_type === 'notion') {
        const { getImportProgress } = await import('@server/integrations/notion/queue.js')
        const prog = getImportProgress(parsedId.data)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      }
    } catch { /* ignore */ }

    return { ...stats, syncing, accessible }
  })

  // --- Apple Notes 专用 handlers ---

  ipcMain.handle('note-sources:apple-notes-check-permission', async () => {
    try {
      const { checkPermission } = await import('@server/integrations/apple-notes/database.js')
      return checkPermission()
    } catch (err) {
      return { accessible: false, path: '', error: (err as Error).message }
    }
  })

  ipcMain.handle('note-sources:apple-notes-list-accounts', async () => {
    try {
      const { openNoteStoreDb, detectSchemaVersion, listAccounts, listNotes, countNotes } = await import('@server/integrations/apple-notes/database.js')
      const db = openNoteStoreDb()
      try {
        const schema = detectSchemaVersion(db)
        const accounts = listAccounts(db)
        // 为每个账户计算笔记数
        return accounts.map(acc => ({
          ...acc,
          noteCount: countNotes(db, schema, [acc.zpk]),
        }))
      } finally {
        db.close()
      }
    } catch (err) {
      return []
    }
  })

  // 测试路径可访问性（不需要 sourceId，直接测试给定路径）
  ipcMain.handle('note-sources:test', async (_e, toolType: unknown, testPath: unknown) => {
    const parsed = parseNoteSourceTest(toolType, testPath)
    if (!parsed.ok) return parsed.error

    const { toolType: parsedToolType, testPath: parsedTestPath } = parsed.data

    // Notion: 验证 token 而非检查文件系统
    if (parsedToolType === 'notion') {
      try {
        const { validateToken } = await import('@server/integrations/notion/api-client.js')
        const token = parsedTestPath.startsWith('notion://') ? parsedTestPath.slice('notion://'.length) : parsedTestPath
        const result = await validateToken(token)
        return { accessible: result.valid, fileCount: result.pageCount, path: parsedTestPath }
      } catch (err) {
        // validateToken 在 401 情况返 valid:false 不 throw。throw 代表瞬时
        // 错误(网络/DNS/502),这里应该回馈"可重试"而不是"token 无效"。
        // UI 侧渲染时可用 `transient` 标识提示用户。
        return { accessible: false, fileCount: 0, path: parsedTestPath, transient: true, error: (err as Error).message }
      }
    }

    // 路径白名单：renderer 传进来的 testPath 会被 fs.readdirSync 递归，
    // 不卡会变成任意目录遍历。create/update/test 共用 parseNoteSourcePath。
    const checkedPath = parseNoteSourcePath(parsedToolType, parsedTestPath)
    if (!checkedPath.ok) {
      return { accessible: false, fileCount: 0, path: parsedTestPath, error: 'path outside allowed roots' }
    }
    const resolved = checkedPath.data
    if (!fs.existsSync(resolved)) {
      return { accessible: false, fileCount: 0, path: resolved }
    }

    try {
      let count = 0
      // 排除规则与各自 walkMdFiles 保持一致（基于相对路径前缀匹配）
      // version-files 不排除：Phase 2.5 会单独处理它们
      const excludePrefixes = parsedToolType === 'obsidian'
        ? ['.obsidian', '.git', '.trash', 'node_modules']
        : ['logseq/bak', 'logseq/.recycle', 'draws', 'whiteboards', 'assets', '.git', '.trash', 'node_modules']

      const isExcluded = (relPath: string) =>
        excludePrefixes.some(p => relPath === p || relPath.startsWith(p + '/'))

      const walk = (dir: string, relDir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            // 跳过隐藏目录（与 walkMdFiles 一致）
            if (entry.name.startsWith('.')) continue
            const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
            if (!isExcluded(relPath)) walk(path.join(dir, entry.name), relPath)
          } else if (entry.name.endsWith('.md')) {
            count++
          }
        }
      }
      walk(resolved, '')
      return { accessible: true, fileCount: count, path: resolved }
    } catch {
      return { accessible: false, fileCount: 0, path: resolved }
    }
  })

  // --- 初始化管线转发（直接传 sourceId + path，不依赖 Function.length 检测） ---

  ipcMain.handle('note-sources:init-preview', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { success: false, error: '笔记源不存在' }

    try {
      if (source.tool_type === 'logseq') {
        const { previewInit } = await import('@server/integrations/logseq/initialization.js')
        const preview = previewInit(getDb(), parsedId.data, source.path)
        return { success: true, data: preview }
      } else if (source.tool_type === 'obsidian') {
        const { previewInit } = await import('@server/integrations/obsidian/initialization.js')
        const preview = previewInit(getDb(), parsedId.data, source.path)
        return { success: true, data: preview }
      } else if (source.tool_type === 'apple-notes') {
        const { previewInit } = await import('@server/integrations/apple-notes/initialization.js')
        const preview = previewInit(getDb(), parsedId.data, source.path)
        return { success: true, data: preview }
      } else if (source.tool_type === 'notion') {
        const { previewInit } = await import('@server/integrations/notion/initialization.js')
        const token = source.path.startsWith('notion://') ? source.path.slice('notion://'.length) : source.path
        const preview = await previewInit(token)
        return { success: true, data: preview }
      }
      return { success: false, error: `不支持的工具类型: ${source.tool_type}` }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('note-sources:init-start', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { success: false, error: '笔记源不存在' }

    // 全局互斥
    const activeId = initSessionManager.getActiveSourceId()
    if (activeId && activeId !== parsedId.data) {
      return { success: false, error: '有其他笔记源正在初始化，请等待完成后再试' }
    }

    // 装配 runner（按 tool_type 选择 runInitialization 实现）
    const toolType = source.tool_type as 'logseq' | 'obsidian' | 'apple-notes' | 'notion'
    const runner = async (ctx: InitSessionContext): Promise<Record<string, unknown>> => {
      if (toolType === 'logseq') {
        const { runInitialization } = await import('@server/integrations/logseq/initialization.js')
        return await runInitialization(getDb(), ctx, source.path) as unknown as Record<string, unknown>
      } else if (toolType === 'obsidian') {
        const { runInitialization } = await import('@server/integrations/obsidian/initialization.js')
        return await runInitialization(getDb(), ctx, source.path) as unknown as Record<string, unknown>
      } else if (toolType === 'apple-notes') {
        const { runInitialization } = await import('@server/integrations/apple-notes/initialization.js')
        return await runInitialization(getDb(), ctx, source.path) as unknown as Record<string, unknown>
      } else if (toolType === 'notion') {
        const { runInitialization } = await import('@server/integrations/notion/initialization.js')
        const token = source.path.startsWith('notion://') ? source.path.slice('notion://'.length) : source.path
        return await runInitialization(getDb(), ctx, token) as unknown as Record<string, unknown>
      }
      throw new Error(`不支持的工具类型: ${source.tool_type}`)
    }

    const startResult = initSessionManager.start({
      sourceId: parsedId.data,
      toolType,
      runner,
    })
    if (!startResult.ok) {
      return { success: false, error: '有其他笔记源正在初始化，请等待完成后再试' }
    }

    const finalSnap = await waitForTerminal(parsedId.data)
    if (finalSnap.status === 'done') {
      markInitialized(getClientDb(), parsedId.data)
      return { success: true, data: finalSnap.report }
    }
    if (finalSnap.status === 'aborted') {
      return { success: false, error: finalSnap.error ?? `已停止（${finalSnap.abortReason ?? 'user'}）` }
    }
    return { success: false, error: finalSnap.error ?? '初始化失败' }
  })

  /**
   * 返回完整 InitSessionSnapshot（status / progress / error / report / canStart 等）。
   * 所有四个 tool 都走 SessionManager。
   */
  ipcMain.handle('note-sources:init-snapshot', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return null

    return initSessionManager.snapshot(parsedId.data)
  })

  ipcMain.handle('note-sources:init-abort', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { success: false }

    const snap = await initSessionManager.abort(parsedId.data, 'user')
    return { success: true, snapshot: snap }
  })

  // 回退初始化数据
  ipcMain.handle('note-sources:rollback', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { success: false, error: '笔记源不存在' }

    // 若仍处于活跃状态（不应该；UI 必先 abort 再 discard），先尝试 abort
    const snap = initSessionManager.snapshot(parsedId.data)
    if (snap && (snap.status === 'running' || snap.status === 'aborting')) {
      await initSessionManager.abort(parsedId.data, 'user')
    }

    try {
      const { rollbackNoteSource } = await import('@server/integrations/shared/rollback.js')
      rollbackNoteSource(getDb(), parsedId.data, source.tool_type)
      // 清空 SessionManager 中残留的终态会话
      try { initSessionManager.discard(parsedId.data) } catch { /* ignore */ }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // --- 增量同步转发 ---

  ipcMain.handle('note-sources:import-status', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return null

    try {
      if (source.tool_type === 'logseq') {
        const { getImportProgress } = await import('@server/integrations/logseq/queue.js')
        return getImportProgress(parsedId.data)
      } else if (source.tool_type === 'obsidian') {
        const { getImportProgress } = await import('@server/integrations/obsidian/queue.js')
        return getImportProgress(parsedId.data)
      } else if (source.tool_type === 'apple-notes') {
        const { getImportProgress } = await import('@server/integrations/apple-notes/index.js')
        return getImportProgress(parsedId.data)
      } else if (source.tool_type === 'notion') {
        const { getImportProgress } = await import('@server/integrations/notion/queue.js')
        return getImportProgress(parsedId.data)
      }
    } catch { /* ignore */ }
    return null
  })

  ipcMain.handle('note-sources:trigger-import', async (_e, id: unknown) => {
    const parsedId = parseNoteSourceId(id)
    if (!parsedId.ok) return parsedId.error

    const source = getNoteSource(getClientDb(), parsedId.data)
    if (!source) return { success: false, error: '笔记源不存在' }

    try {
      if (source.tool_type === 'logseq') {
        const { triggerFullRescan } = await import('@server/integrations/logseq/index.js')
        await triggerFullRescan(getDb(), parsedId.data, source.path)
      } else if (source.tool_type === 'obsidian') {
        const { triggerFullRescan } = await import('@server/integrations/obsidian/index.js')
        await triggerFullRescan(getDb(), parsedId.data, source.path)
      } else if (source.tool_type === 'apple-notes') {
        const { triggerFullRescan } = await import('@server/integrations/apple-notes/index.js')
        await triggerFullRescan(getDb(), parsedId.data, source.path)
      } else if (source.tool_type === 'notion') {
        const { triggerFullRescan } = await import('@server/integrations/notion/index.js')
        await triggerFullRescan(getDb(), parsedId.data, source.path)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
