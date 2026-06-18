-- 一次性清理：删除阈值 5 时代晋升的低引用 tag 节点
-- 保留引用数 >= 25 的 tag 节点（TideMind, architecture, strategy-evolution, 架构设计）
--
-- 注意：本脚本面向单用户本地 SQLite（~/.tidemind/graph/brain.sqlite）。
--       如未来迁移到多租户后端（Postgres 等），需要在所有 nodes / links /
--       vector_segments / nodes_vec 的 WHERE 里加入 tenant_id 过滤；
--       当前 schema 里没有 tenant_id，因此这里不处理。
--
-- 执行前请备份数据库：
--   cp ~/.tidemind/graph/brain.sqlite ~/.tidemind/graph/brain.sqlite.bak
--
-- 执行：
--   sqlite3 ~/.tidemind/graph/brain.sqlite < scripts/cleanup-low-ref-tags.sql

-- 幂等：临时表可能在上一次失败后残留
DROP TABLE IF EXISTS tags_to_remove;

-- 整个脚本放在事务中，任一步失败则回滚，不会留下半删状态
BEGIN;

-- 创建临时表存储不达标的 tag 节点 ID
--
-- tag 文本的存放位置在不同生成路径下不一致:
--   - 旧路径:tag 文本写在 nodes.content
--   - batch-promote-tags.ts:nodes.content 固定为 ''、tag 文本写在 nodes.title
-- 因此统一用 COALESCE(NULLIF(title,''), content) 取 tag 文本(同 batch-promote-tags.ts
-- L99 的 `(tn.title ?? tn.content)` 逻辑)。若直接用 t.content,batch-promoted 的
-- 空串 content 会让 LIKE 退化为 '%""%' → 真实引用数恒为 0 → 把这些 tag 节点连同
-- links / 向量数据一起误删。tag_text 为空(两处都空)的异常节点显式跳过,不参与删除。
CREATE TEMP TABLE tags_to_remove AS
SELECT t.id, COALESCE(NULLIF(t.title, ''), t.content) AS tag_text
FROM nodes t
WHERE t.is_tag = 1
AND COALESCE(NULLIF(t.title, ''), t.content) <> ''
AND (
  SELECT COUNT(DISTINCT n.id)
  FROM nodes n
  WHERE n.is_tag = 0 AND n.heat > 0.01
  AND n.tags LIKE '%"' || COALESCE(NULLIF(t.title, ''), t.content) || '"%'
) < 25;

-- 报告即将删除的内容
SELECT '即将删除 ' || COUNT(*) || ' 个不达标 tag 节点:' FROM tags_to_remove;
SELECT '  - ' || tag_text FROM tags_to_remove;

-- 删除关联链接
DELETE FROM links WHERE from_id IN (SELECT id FROM tags_to_remove)
   OR to_id IN (SELECT id FROM tags_to_remove);
SELECT '已删除关联链接: ' || changes();

-- 删除向量数据
DELETE FROM nodes_vec WHERE id IN (
  SELECT segment_id FROM vector_segments WHERE node_id IN (SELECT id FROM tags_to_remove)
);
DELETE FROM vector_segments WHERE node_id IN (SELECT id FROM tags_to_remove);
SELECT '已删除向量数据';

-- 删除节点
DELETE FROM nodes WHERE id IN (SELECT id FROM tags_to_remove);
SELECT '已删除 tag 节点: ' || changes();

-- 清理临时表
DROP TABLE tags_to_remove;

COMMIT;

SELECT '清理完成。剩余 tag 节点:';
SELECT '  - ' || COALESCE(NULLIF(t.title, ''), t.content) || ' (引用数: ' || (
  SELECT COUNT(DISTINCT n.id) FROM nodes n
  WHERE n.is_tag = 0 AND n.heat > 0.01
  AND n.tags LIKE '%"' || COALESCE(NULLIF(t.title, ''), t.content) || '"%'
) || ')' FROM nodes t WHERE t.is_tag = 1 ORDER BY COALESCE(NULLIF(t.title, ''), t.content);
