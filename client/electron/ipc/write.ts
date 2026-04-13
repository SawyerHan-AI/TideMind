import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { digest } from '@server/tools/digest.js'
import { updateNode, getNode, unarchiveNode, reArchiveNode, listArchivedNodes } from '@server/db/nodes.js'
import { createNode } from '@server/db/nodes.js'
import { logOperation, logStrategyFeedback } from '@server/db/log.js'
import { supersedeNode } from '@server/integrations/shared/version.js'

export function registerWriteHandlers(db: Database.Database): void {
  // editNode → 创建新节点 + supersede 旧节点（与笔记同步更新行为一致）
  ipcMain.handle('write:editNode', async (_e, nodeId: string, newContent: string, newTitle: string | null, reason: string) => {
    try {
      const oldNode = getNode(db, nodeId)
      if (!oldNode) {
        return { success: false, error: `节点 ${nodeId} 不存在` }
      }

      // 创建新版本节点
      const result = await digest(db, {
        content: newContent,
        title: newTitle ?? undefined,
        source: { tool: 'client' },
        context: reason,
        tags: oldNode.tags ? JSON.parse(oldNode.tags) : undefined,
        async: false,
      })

      const newNodeId = result.created_nodes?.[0]?.id
      if (!newNodeId) {
        return { success: false, error: '新节点创建失败' }
      }

      // 迁移链接 + 标记旧节点
      supersedeNode(db, nodeId, newNodeId)

      // 记录修改审计
      logOperation(db, {
        operation: 'digest',
        input_summary: `edit: ${nodeId} → ${newNodeId}`,
        context: reason,
        output_node_ids: [newNodeId],
        tool: 'client',
      })

      return { success: true, newNodeId, newVersion: result.created_nodes?.[0]?.version }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // archiveNode → 通过 digest archive 通道
  ipcMain.handle('write:archiveNode', async (_e, nodeId: string) => {
    try {
      await digest(db, {
        content: '',
        target_node: nodeId,
        intent: 'archive',
        source: { tool: 'client' },
        async: false,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // deleteLink → 通过 digest correction with target_link
  ipcMain.handle('write:deleteLink', async (_e, linkId: string) => {
    try {
      // digest 接口用 from/to 而非 linkId，需要先查端点
      const link = db.prepare('SELECT from_id, to_id FROM links WHERE id = ?').get(linkId) as
        | { from_id: string; to_id: string }
        | undefined
      if (!link) return { success: false, error: 'Link not found' }

      await digest(db, {
        content: '',
        target_link: { from: link.from_id, to: link.to_id },
        intent: 'correction',
        source: { tool: 'client' },
        async: false,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // submitFeedback → 元操作，直接用 db 层函数
  ipcMain.handle('write:submitFeedback', (_e, strategyName: string, signal: number) => {
    try {
      logStrategyFeedback(db, {
        strategy_name: strategyName,
        feedback_signal: signal,
        was_used: true,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // listArchived → 列出因外部笔记源删除而归档的节点
  ipcMain.handle('write:listArchived', (_e, opts?: { limit?: number; offset?: number }) => {
    return listArchivedNodes(db, opts ?? {})
  })

  // unarchiveNode → 恢复归档节点
  ipcMain.handle('write:unarchiveNode', (_e, nodeId: string) => {
    const ok = unarchiveNode(db, nodeId)
    return { success: ok }
  })

  // reArchiveNode → 重新归档节点
  ipcMain.handle('write:reArchiveNode', (_e, nodeId: string) => {
    const ok = reArchiveNode(db, nodeId)
    return { success: ok }
  })
}
