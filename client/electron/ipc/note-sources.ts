import { ipcMain } from 'electron'
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

// 全局初始化锁（跨 Logseq/Obsidian）
let globalInitSourceId: string | null = null

/**
 * 注册笔记源管理 IPC handlers
 */
export function registerNoteSourceHandlers(): void {
  ipcMain.handle('note-sources:list', (_e, includeArchived?: boolean) => {
    return listNoteSources(getClientDb(), includeArchived ?? true)
  })

  ipcMain.handle('note-sources:create', (_e, params: {
    name: string; toolType: string; path: string; pollInterval?: number
  }) => {
    return createNoteSource(getClientDb(), params)
  })

  ipcMain.handle('note-sources:update', (_e, id: string, updates: {
    name?: string; path?: string; pollInterval?: number
  }) => {
    updateNoteSource(getClientDb(), id, updates)
  })

  ipcMain.handle('note-sources:archive', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return

    archiveNoteSource(getClientDb(), id)

    // 停止该笔记源的监听
    try {
      if (source.tool_type === 'logseq') {
        const { stopLogseqSource } = await import('@server/integrations/logseq/index.js')
        stopLogseqSource(id)
      } else if (source.tool_type === 'obsidian') {
        const { stopObsidianSource } = await import('@server/integrations/obsidian/index.js')
        stopObsidianSource(id)
      } else if (source.tool_type === 'apple-notes') {
        const { stopAppleNotesSource } = await import('@server/integrations/apple-notes/index.js')
        stopAppleNotesSource(id)
      }
    } catch { /* ignore */ }
  })

  ipcMain.handle('note-sources:unarchive', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return

    unarchiveNoteSource(getClientDb(), id)

    // 重新启动监听
    try {
      if (source.tool_type === 'logseq') {
        const { startLogseqSource } = await import('@server/integrations/logseq/index.js')
        await startLogseqSource(getDb(), id, source.path, source.poll_interval)
      } else if (source.tool_type === 'obsidian') {
        const { startObsidianSource } = await import('@server/integrations/obsidian/index.js')
        await startObsidianSource(getDb(), id, source.path, source.poll_interval)
      } else if (source.tool_type === 'apple-notes') {
        const { startAppleNotesSource } = await import('@server/integrations/apple-notes/index.js')
        await startAppleNotesSource(getDb(), id, source.path, source.poll_interval)
      }
    } catch { /* ignore */ }
  })

  ipcMain.handle('note-sources:stats', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { fileCount: 0, nodeCount: 0, lastSynced: null, syncing: false, accessible: true }

    const stats = getNoteSourceStats(getClientDb(), id)

    // 检查路径是否可达
    let accessible: boolean
    if (source.tool_type === 'apple-notes') {
      // Apple Notes 路径含 query params，只检查数据库文件
      const dbPath = source.path.split('?')[0]
      accessible = fs.existsSync(dbPath)
    } else {
      accessible = fs.existsSync(source.path)
    }

    // 检查是否正在同步
    let syncing = false
    try {
      if (source.tool_type === 'logseq') {
        const { getImportProgress } = await import('@server/integrations/logseq/queue.js')
        const prog = getImportProgress(id)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      } else if (source.tool_type === 'obsidian') {
        const { getImportProgress } = await import('@server/integrations/obsidian/queue.js')
        const prog = getImportProgress(id)
        syncing = prog.phase !== 'idle' && prog.phase !== 'done'
      } else if (source.tool_type === 'apple-notes') {
        const { getImportProgress } = await import('@server/integrations/apple-notes/index.js')
        const prog = getImportProgress(id)
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
  ipcMain.handle('note-sources:test', (_e, toolType: string, testPath: string) => {
    const resolved = testPath.replace('~', os.homedir())
    if (!fs.existsSync(resolved)) {
      return { accessible: false, fileCount: 0, path: resolved }
    }

    try {
      let count = 0
      // 排除规则与各自 walkMdFiles 保持一致（基于相对路径前缀匹配）
      // version-files 不排除：Phase 2.5 会单独处理它们
      const excludePrefixes = toolType === 'obsidian'
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

  ipcMain.handle('note-sources:init-preview', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { success: false, error: '笔记源不存在' }

    try {
      if (source.tool_type === 'logseq') {
        const { previewInit } = await import('@server/integrations/logseq/initialization.js')
        const preview = previewInit(getDb(), id, source.path)
        return { success: true, data: preview }
      } else if (source.tool_type === 'obsidian') {
        const { previewInit } = await import('@server/integrations/obsidian/initialization.js')
        const preview = previewInit(getDb(), id, source.path)
        return { success: true, data: preview }
      } else if (source.tool_type === 'apple-notes') {
        const { previewInit } = await import('@server/integrations/apple-notes/initialization.js')
        const preview = previewInit(getDb(), id, source.path)
        return { success: true, data: preview }
      }
      return { success: false, error: `不支持的工具类型: ${source.tool_type}` }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('note-sources:init-start', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { success: false, error: '笔记源不存在' }

    // 全局锁：同一时刻只允许一个初始化（跨 Logseq/Obsidian）
    if (globalInitSourceId) {
      return { success: false, error: '有其他笔记源正在初始化，请等待完成后再试' }
    }
    globalInitSourceId = id

    try {
      let report: any
      if (source.tool_type === 'logseq') {
        const { runInitialization } = await import('@server/integrations/logseq/initialization.js')
        report = await runInitialization(getDb(), id, source.path)
      } else if (source.tool_type === 'obsidian') {
        const { runInitialization } = await import('@server/integrations/obsidian/initialization.js')
        report = await runInitialization(getDb(), id, source.path)
      } else if (source.tool_type === 'apple-notes') {
        const { runInitialization } = await import('@server/integrations/apple-notes/initialization.js')
        report = await runInitialization(getDb(), id, source.path)
      } else {
        return { success: false, error: `不支持的工具类型: ${source.tool_type}` }
      }

      // 标记为已初始化
      markInitialized(getClientDb(), id)
      return { success: true, data: report }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      globalInitSourceId = null
    }
  })

  ipcMain.handle('note-sources:init-progress', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return null

    try {
      if (source.tool_type === 'logseq') {
        const { getInitProgress } = await import('@server/integrations/logseq/initialization.js')
        return getInitProgress(id)
      } else if (source.tool_type === 'obsidian') {
        const { getInitProgress } = await import('@server/integrations/obsidian/initialization.js')
        return getInitProgress(id)
      } else if (source.tool_type === 'apple-notes') {
        const { getInitProgress } = await import('@server/integrations/apple-notes/initialization.js')
        return getInitProgress(id)
      }
    } catch { /* ignore */ }
    return null
  })

  ipcMain.handle('note-sources:init-abort', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { success: false }

    try {
      if (source.tool_type === 'logseq') {
        const { abortInit } = await import('@server/integrations/logseq/initialization.js')
        abortInit(id)
      } else if (source.tool_type === 'obsidian') {
        const { abortInit } = await import('@server/integrations/obsidian/initialization.js')
        abortInit(id)
      } else if (source.tool_type === 'apple-notes') {
        const { abortInit } = await import('@server/integrations/apple-notes/initialization.js')
        abortInit(id)
      }
    } catch { /* ignore */ }
    return { success: true }
  })

  // 回退初始化数据
  ipcMain.handle('note-sources:rollback', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { success: false, error: '笔记源不存在' }

    try {
      const { rollbackNoteSource } = await import('@server/integrations/shared/rollback.js')
      rollbackNoteSource(getDb(), id, source.tool_type)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // --- 增量同步转发 ---

  ipcMain.handle('note-sources:import-status', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return null

    try {
      if (source.tool_type === 'logseq') {
        const { getImportProgress } = await import('@server/integrations/logseq/queue.js')
        return getImportProgress(id)
      } else if (source.tool_type === 'obsidian') {
        const { getImportProgress } = await import('@server/integrations/obsidian/queue.js')
        return getImportProgress(id)
      } else if (source.tool_type === 'apple-notes') {
        const { getImportProgress } = await import('@server/integrations/apple-notes/index.js')
        return getImportProgress(id)
      }
    } catch { /* ignore */ }
    return null
  })

  ipcMain.handle('note-sources:trigger-import', async (_e, id: string) => {
    const source = getNoteSource(getClientDb(), id)
    if (!source) return { success: false, error: '笔记源不存在' }

    try {
      if (source.tool_type === 'logseq') {
        const { triggerFullRescan } = await import('@server/integrations/logseq/index.js')
        await triggerFullRescan(getDb(), id, source.path)
      } else if (source.tool_type === 'obsidian') {
        const { triggerFullRescan } = await import('@server/integrations/obsidian/index.js')
        await triggerFullRescan(getDb(), id, source.path)
      } else if (source.tool_type === 'apple-notes') {
        const { triggerFullRescan } = await import('@server/integrations/apple-notes/index.js')
        await triggerFullRescan(getDb(), id, source.path)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
