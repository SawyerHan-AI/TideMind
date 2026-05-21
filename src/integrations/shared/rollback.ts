// ============================================================
// 笔记源初始化回退
//
// 从 sync state 表中读取所有 node_ids，
// 在事务中删除 links → nodes → vectors → sync state → note_sources 记录
// ============================================================

import type Database from 'better-sqlite3';
import { deleteNodeDependentsBatch } from '../../db/node-lifecycle.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('rollback');

/**
 * 回退一个笔记源的初始化数据。
 * 删除该笔记源创建的所有 nodes、links、向量、sync state，以及 note_sources 记录。
 */
export function rollbackNoteSource(
  db: Database.Database,
  sourceId: string,
  toolType: string,
): void {
  const syncTable = toolType === 'logseq'
    ? 'logseq_sync'
    : toolType === 'obsidian'
      ? 'obsidian_sync'
      : toolType === 'notion'
        ? 'notion_sync'
        : 'apple_notes_sync';

  // 1. 收集所有 node_ids
  const rows = db.prepare(
    `SELECT node_ids FROM ${syncTable} WHERE source_id = ? AND node_ids IS NOT NULL`,
  ).all(sourceId) as Array<{ node_ids: string }>;

  const allNodeIds = new Set<string>();
  for (const row of rows) {
    try {
      const ids = JSON.parse(row.node_ids);
      if (Array.isArray(ids)) {
        for (const id of ids) allNodeIds.add(id);
      }
    } catch { /* ignore malformed */ }
  }

  log.info(`回退笔记源 ${sourceId}: 找到 ${allNodeIds.size} 个节点, ${rows.length} 个文件记录`);

  if (allNodeIds.size === 0) {
    // 没有节点数据，只清理 sync state 和 note_sources
    db.transaction(() => {
      db.prepare(`DELETE FROM ${syncTable} WHERE source_id = ?`).run(sourceId);
      db.prepare('DELETE FROM note_sources WHERE id = ?').run(sourceId);

      // 清理 Notion pending_retry / pending_relations
      if (toolType === 'notion') {
        try {
          db.prepare('DELETE FROM notion_pending_retry WHERE source_id = ?').run(sourceId);
        } catch { /* table may not exist */ }
        try {
          db.prepare('DELETE FROM notion_pending_relations WHERE source_id = ?').run(sourceId);
        } catch { /* table may not exist */ }
      }

      // 清理 metadata 中的 full_scan 标记
      db.prepare(`DELETE FROM metadata WHERE key = ?`).run(`${toolType}_full_scan_completed_${sourceId}`);
    })();
    log.info(`回退完成（无节点数据）`);
    return;
  }

  // 2. 批量删除（SQLite 的 IN 子句有变量数限制，分批处理）
  const BATCH_SIZE = 500;
  const nodeIdArray = Array.from(allNodeIds);

  db.transaction(() => {
    for (let i = 0; i < nodeIdArray.length; i += BATCH_SIZE) {
      const batch = nodeIdArray.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');

      deleteNodeDependentsBatch(db, batch, { ignoreMissingTables: true });

      // 删除节点本身
      db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...batch);

      // 删除 FTS 索引条目（通过 trigger 自动处理，但 rebuild 更保险）
      // nodes 的 DELETE trigger 会自动清理 FTS
    }

    // 删除 sync state
    db.prepare(`DELETE FROM ${syncTable} WHERE source_id = ?`).run(sourceId);

    // 清理 Notion pending relations / pending_retry（如果存在）
    if (toolType === 'notion') {
      try {
        db.prepare('DELETE FROM notion_pending_relations WHERE source_id = ?').run(sourceId);
      } catch { /* table may not exist */ }
      try {
        db.prepare('DELETE FROM notion_pending_retry WHERE source_id = ?').run(sourceId);
      } catch { /* table may not exist */ }
    }

    // 删除 note_sources 记录
    db.prepare('DELETE FROM note_sources WHERE id = ?').run(sourceId);

    // 清理 metadata 中的 full_scan 标记
    db.prepare(`DELETE FROM metadata WHERE key = ?`).run(`${toolType}_full_scan_completed_${sourceId}`);
  })();

  log.info(`回退完成: 删除 ${allNodeIds.size} 个节点及相关链接`);
}
