// ============================================================
// Duplicate Link GC — 合并完全重复的链接（不调模型）
//
// 设计：docs/design/primary-device-selection-2026-11-20.md §10.5。
// 两台设备短暂同时整理时，可能各自在同一对节点之间建出同一条关联（链接 ID 不同，
// 同步按 ID 认，不会合并）。链接没有来源字段，无法在云端按设备把关，只能事后去重。
//
// 只合并“起点、终点、主关系类型、备注”四者都相同的链接：
//   - 同一对节点之间不同关系的多条链接是允许的（标签 + 类比等）；
//   - 标签链接、Obsidian 顺序链接区分方向；
//   - 备注不同的链接可能不是一回事，一律不动。
// 保留顺序：用户拒绝过的 > 已确认 > 待定；同级留最早创建的，再按 ID。
// 其余软删除（沿用现有的跨设备删除传播）。
// ============================================================

import type Database from 'better-sqlite3';
import { deleteLink } from '../db/links.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('duplicate-link-gc');

const MAX_GROUPS_PER_RUN = 500;

const GROUP_KEY = `from_id, to_id, COALESCE(CASE WHEN json_valid(relation) THEN json_extract(relation, '$[0].type') END, ''), COALESCE(note, '')`;

export function runDuplicateLinkGc(db: Database.Database): { groups: number; deleted: number } {
  // relation 不是合法 JSON 的历史行按“无关系类型”分组（json_valid 保护），不会抛错。
  const groups = db.prepare(`
    SELECT from_id, to_id,
           COALESCE(CASE WHEN json_valid(relation) THEN json_extract(relation, '$[0].type') END, '') AS relation_type,
           COALESCE(note, '') AS note_key
    FROM links WHERE deleted = 0
    GROUP BY ${GROUP_KEY} HAVING COUNT(*) > 1
    LIMIT ?
  `).all(MAX_GROUPS_PER_RUN) as Array<{ from_id: string; to_id: string; relation_type: string; note_key: string }>;

  const members = db.prepare(`
    SELECT id FROM links
    WHERE deleted = 0 AND from_id = ? AND to_id = ?
      AND COALESCE(CASE WHEN json_valid(relation) THEN json_extract(relation, '$[0].type') END, '') = ?
      AND COALESCE(note, '') = ?
    ORDER BY CASE status WHEN 'rejected_by_user' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
             created ASC, id ASC
  `);

  let deleted = 0;
  db.transaction(() => {
    for (const group of groups) {
      const rows = members.all(group.from_id, group.to_id, group.relation_type, group.note_key) as Array<{ id: string }>;
      for (const row of rows.slice(1)) {
        deleteLink(db, row.id);
        deleted++;
      }
    }
  })();
  if (deleted > 0) log.info(`合并重复链接：${groups.length} 组，软删除 ${deleted} 条`);
  return { groups: groups.length, deleted };
}
