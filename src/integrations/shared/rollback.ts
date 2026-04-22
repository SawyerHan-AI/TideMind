// ============================================================
// 笔记源初始化回退
//
// 从 sync state 表中读取所有 node_ids，
// 在事务中删除 links → nodes → vectors → sync state → note_sources 记录
// ============================================================

import type Database from 'better-sqlite3';
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

      // 删除关联表（必须先于 nodes 删除，避免外键悬挂）
      //
      // 清理范围覆盖 schema.ts 里所有以 node_id 作直接 FK 的表：
      //   - node_versions(node_id) REFERENCES nodes(id)
      //   - strategy_feedback(node_id) REFERENCES nodes(id)
      //   - links(from_id / to_id) REFERENCES nodes(id)
      //   - node_segments(node_id) —— 无显式 FK 声明但语义上绑定
      //
      // 未处理的间接引用（已知，有意不清理）：
      //   - operation_log.output_node_ids / timeline_events.node_ids：JSON 数组里的 id 字符串，
      //     不是外键；查询时自带容错，保留作为历史痕迹即可。
      db.prepare(`DELETE FROM links WHERE from_id IN (${placeholders})`).run(...batch);
      db.prepare(`DELETE FROM links WHERE to_id IN (${placeholders})`).run(...batch);

      // node_versions：历史版本快照，节点删了之后失去意义
      try {
        db.prepare(`DELETE FROM node_versions WHERE node_id IN (${placeholders})`).run(...batch);
      } catch { /* 表可能不存在（旧 schema） */ }

      // strategy_feedback：策略评估信号，悬挂的 FK 会让 DELETE nodes 报错
      try {
        db.prepare(`DELETE FROM strategy_feedback WHERE node_id IN (${placeholders})`).run(...batch);
      } catch { /* 表可能不存在 */ }

      // 删除向量：nodes_vec.id 是 segment_id（`${nodeId}#${index}`），不是 node.id。
      // 必须先通过 node_segments 查出 segment_id，再按 segment_id 删 nodes_vec；
      // 如果先 DELETE FROM node_segments 就永远找不到 segment_id，导致向量残留。
      try {
        const segRows = db.prepare(
          `SELECT segment_id FROM node_segments WHERE node_id IN (${placeholders})`,
        ).all(...batch) as Array<{ segment_id: string }>;
        const delVec = db.prepare('DELETE FROM nodes_vec WHERE id = ?');
        for (const row of segRows) delVec.run(row.segment_id);
      } catch { /* nodes_vec / node_segments 可能不存在 */ }

      // 删除 node_segments（必须在 nodes_vec 之后，在 nodes 之前）
      try {
        db.prepare(`DELETE FROM node_segments WHERE node_id IN (${placeholders})`).run(...batch);
      } catch { /* 表可能不存在 */ }

      // 删除节点本身
      db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...batch);

      // 删除 FTS 索引条目（通过 trigger 自动处理，但 rebuild 更保险）
      // nodes 的 DELETE trigger 会自动清理 FTS
    }

    // 删除 sync state
    db.prepare(`DELETE FROM ${syncTable} WHERE source_id = ?`).run(sourceId);

    // 清理 Notion pending relations（如果存在）
    if (toolType === 'notion') {
      try {
        db.prepare('DELETE FROM notion_pending_relations WHERE source_id = ?').run(sourceId);
      } catch { /* table may not exist */ }
    }

    // 删除 note_sources 记录
    db.prepare('DELETE FROM note_sources WHERE id = ?').run(sourceId);

    // 清理 metadata 中的 full_scan 标记
    db.prepare(`DELETE FROM metadata WHERE key = ?`).run(`${toolType}_full_scan_completed_${sourceId}`);
  })();

  log.info(`回退完成: 删除 ${allNodeIds.size} 个节点及相关链接`);
}
