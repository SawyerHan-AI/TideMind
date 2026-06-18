import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { digest } from '@server/tools/digest.js'
import { getNode, listArchivedNodes } from '@server/db/nodes.js'
import { logOperation, logStrategyFeedback } from '@server/db/log.js'
import {
  reArchiveNodeWithVectors,
  supersedeNodeWithLinks,
  unarchiveNodeRecordOnly,
} from '@server/db/node-lifecycle.js'
import { SqliteRepository } from '@server/db/sqlite-repository.js'
import { createLogger } from '@server/utils/logger.js'
import {
  parseEditNodeArgs,
  parseFeedbackArgs,
  parseListArchivedOpts,
  parseNodeId,
} from './_schemas.js'

const log = createLogger('ipc-write')

export function registerWriteHandlers(db: Database.Database): void {
  const repo = new SqliteRepository(db)

  // editNode → 创建新节点 + supersede 旧节点（与笔记同步更新行为一致）
  ipcMain.handle('write:editNode', async (_e, nodeId: unknown, newContent: unknown, newTitle: unknown, reason: unknown) => {
    const parsed = parseEditNodeArgs(nodeId, newContent, newTitle, reason)
    if (!parsed.ok) return parsed.error
    const args = parsed.data

    try {
      const oldNode = getNode(db, args.nodeId)
      if (!oldNode) {
        return { success: false, error: `节点 ${args.nodeId} 不存在` }
      }

      // 创建新版本节点
      const result = await digest(repo, {
        content: args.newContent,
        title: args.newTitle ?? undefined,
        source: { tool: 'client' },
        context: args.reason,
        tags: oldNode.tags ? JSON.parse(oldNode.tags) : undefined,
        async: false,
      })

      const newNodeId = result.created_nodes?.[0]?.id
      if (!newNodeId) {
        return { success: false, error: '新节点创建失败' }
      }

      // 迁移链接 + 标记旧节点
      supersedeNodeWithLinks(db, args.nodeId, newNodeId)

      // 记录修改审计
      logOperation(db, {
        operation: 'digest',
        input_summary: `edit: ${args.nodeId} → ${newNodeId}`,
        context: args.reason,
        output_node_ids: [newNodeId],
        tool: 'client',
      })

      const newNode = getNode(db, newNodeId)
      return { success: true, newNodeId, newVersion: newNode?.version }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // archiveNode → 通过 digest archive 通道
  ipcMain.handle('write:archiveNode', async (_e, nodeId: unknown) => {
    const parsedId = parseNodeId(nodeId)
    if (!parsedId.ok) return parsedId.error

    try {
      await digest(repo, {
        content: '',
        target_node: parsedId.data,
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
  ipcMain.handle('write:deleteLink', async (_e, linkId: unknown) => {
    const parsedId = parseNodeId(linkId, 'linkId')
    if (!parsedId.ok) return parsedId.error

    try {
      // digest 接口用 from/to 而非 linkId，需要先查端点
      const link = db.prepare('SELECT from_id, to_id FROM links WHERE id = ? AND deleted = 0').get(parsedId.data) as
        | { from_id: string; to_id: string }
        | undefined
      if (!link) return { success: false, error: 'Link not found' }

      await digest(repo, {
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
  ipcMain.handle('write:submitFeedback', (_e, strategyName: unknown, signal: unknown) => {
    const parsed = parseFeedbackArgs(strategyName, signal)
    if (!parsed.ok) return parsed.error

    try {
      logStrategyFeedback(db, {
        strategy_name: parsed.data.strategyName,
        feedback_signal: parsed.data.signal,
        was_used: true,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // listArchived → 列出因外部笔记源删除而归档的节点
  ipcMain.handle('write:listArchived', (_e, opts: unknown) => {
    const parsed = parseListArchivedOpts(opts)
    if (!parsed.ok) return parsed.error
    return listArchivedNodes(db, parsed.data)
  })

  // unarchiveNode → 恢复归档节点 + 重建向量(archive 时被清空)
  // archiveNodeWithVectors 在归档时删了 nodes_vec / node_segments(防孤儿向量),
  // 不补 embed 的话恢复后的节点完全无法被 recall 召回。即使重 archive 也再删
  // 不掉(已经没了)。所以 unarchive 必须再 embed 一次。
  ipcMain.handle('write:unarchiveNode', async (_e, nodeId: unknown) => {
    const parsedId = parseNodeId(nodeId)
    if (!parsedId.ok) return parsedId.error
    const ok = unarchiveNodeRecordOnly(db, parsedId.data)
    if (ok) {
      const node = getNode(db, parsedId.data)
      if (node && node.content) {
        try {
          await repo.vectors.insertSegmentVectors(parsedId.data, node.content)
        } catch (err) {
          // embed 失败不阻塞 unarchive(用户可在设置里手动触发 reembedAllNodes 修)
          log.error(`unarchive ${parsedId.data} embed 失败: ${(err as Error).message}`)
        }
      }
    }
    return { success: ok }
  })

  // reArchiveNode → 重新归档节点
  ipcMain.handle('write:reArchiveNode', (_e, nodeId: unknown) => {
    const parsedId = parseNodeId(nodeId)
    if (!parsedId.ok) return parsedId.error
    const ok = reArchiveNodeWithVectors(db, parsedId.data)
    return { success: ok }
  })
}
