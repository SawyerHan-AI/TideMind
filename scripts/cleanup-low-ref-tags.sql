-- 一次性清理：删除阈值 5 时代晋升的低引用 tag 节点
-- 保留引用数 >= 25 的 tag 节点（TideMind, architecture, strategy-evolution, 架构设计）
--
-- 执行前请备份数据库：
--   cp ~/.tidemind/graph/brain.sqlite ~/.tidemind/graph/brain.sqlite.bak
--
-- 执行：
--   sqlite3 ~/.tidemind/graph/brain.sqlite < scripts/cleanup-low-ref-tags.sql

-- 创建临时表存储不达标的 tag 节点 ID
CREATE TEMP TABLE tags_to_remove AS
SELECT t.id, t.content
FROM nodes t
WHERE t.is_tag = 1
AND (
  SELECT COUNT(DISTINCT n.id)
  FROM nodes n
  WHERE n.is_tag = 0 AND n.heat > 0.01
  AND n.tags LIKE '%"' || t.content || '"%'
) < 25;

-- 报告即将删除的内容
SELECT '即将删除 ' || COUNT(*) || ' 个不达标 tag 节点:' FROM tags_to_remove;
SELECT '  - ' || content FROM tags_to_remove;

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

SELECT '清理完成。剩余 tag 节点:';
SELECT '  - ' || content || ' (引用数: ' || (
  SELECT COUNT(DISTINCT n.id) FROM nodes n
  WHERE n.is_tag = 0 AND n.heat > 0.01 AND n.tags LIKE '%"' || t.content || '"%'
) || ')' FROM nodes t WHERE t.is_tag = 1 ORDER BY content;
