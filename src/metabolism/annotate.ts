// ============================================================
// 记忆 — 节点标注（近实时）
//
// 对新入库的原始节点做 LLM 标注（维度/tags），
// 带邻居上下文，批量处理以降低调用次数。
// 由 daemon 每 3 分钟触发一次。
// ============================================================

import type Database from 'better-sqlite3';
import type { BrainNode, NodeType } from '../types.js';
import { updateNode, getNode, parseTags } from '../db/nodes.js';
import { getVectorForNode, searchVectors } from '../db/vectors.js';
import { createLink, linkExists } from '../db/links.js';
import { isVecLoaded } from '../db/connection.js';
import { callLLM } from '../llm/client.js';
import { isLlmConfigured } from '../config.js';
import { getPrompt, getParam, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { getGraphVocabulary } from '../db/stats.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';

const log = createLogger('annotate');

// 以下常量均可通过策略文件 annotate 覆盖
const getAnnotateParam = <T extends number>(key: string, fallback: T): T =>
  getParam('annotate', key, fallback) as T;
const MAX_BATCH_SIZE = () => getAnnotateParam('batch_size', 30);
const NEIGHBOR_COUNT = () => getAnnotateParam('neighbor_count', 3);
const CONTENT_BUDGET = () => getAnnotateParam('content_budget', 8000);
const MAX_CONTENT_PER_NODE = () => getAnnotateParam('max_content_per_node', 1500);
const NEIGHBOR_PREVIEW = () => getAnnotateParam('neighbor_preview_length', 300);
// ---- Fallback System Prompt ----

const ANNOTATE_SYSTEM = `你是记忆标注器。对新入库的记忆在三个维度上评分，标注标签，并为缺少标题的记忆生成标题。

三个维度（每个 0.0-1.0）：
- specificity: 这条记忆有多绑定具体情景？
  0.0 = 完全通用的规律/知识（"冰糖可以提味"）
  1.0 = 完全绑定特定时间地点（"昨天和老李吃了火锅"）

- subjectivity: 这条记忆有多个人化/主观？
  0.0 = 纯客观事实（"React 使用虚拟 DOM"）
  1.0 = 纯个人偏好/感受（"我喜欢简洁的设计"）

- actuality: 这条记忆有多确定/已确立？
  0.0 = 纯猜测/设想（"也许该试试冥想"）
  1.0 = 已确认的事实/已做的决定（"项目选了 React"）

一致性规则（必须严格遵守）:
- 标签必须与已有列表中的写法完全一致。如已有"TideMind"，不要写"Tide-Mind"或"tide_mind"。
- 仅在已有标签无法准确描述时才创建新的。
- 标签应具体有辨识度，避免过于宽泛（如"技术"）。
- 同一概念只保留一种写法，不要创建含义相同但拼写/格式不同的变体。

标题原则（仅对标注为「需要标题」的记忆生成）:
- 标题是对内容的高度浓缩，捕捉核心主题，而非机械截取开头
- 5-30 字，不加引号、不加句号、不加"关于"等前缀词
- 已有标题的记忆省略 title 字段

输出 JSON 数组，每个元素必须包含 index 字段（对应记忆编号）:
[{ "index": 1, "specificity": 0.7, "subjectivity": 0.3, "actuality": 0.9, "tags": ["标签1"], "title": "标题" }]

只有标注为「需要标题」的记忆才需要输出 title 字段。

只输出 JSON 数组。`;

// ---- 核心函数 ----

/**
 * 执行一轮节点标注
 *
 * 找到未经 LLM 标注的节点（refinement === 0），
 * 按 token 预算动态分批，附带邻居上下文和已有标签体系。
 * 使用 index 匹配而非位置匹配，避免 LLM 返回数组长度不一致导致张冠李戴。
 */
export async function runAnnotation(db: Database.Database): Promise<{
  annotated: number;
  skipped: number;
}> {
  if (!isLlmConfigured()) return { annotated: 0, skipped: 0 };

  const maxNodes = MAX_BATCH_SIZE();
  const rawNodes = findUnannotatedNodes(db, maxNodes);
  if (rawNodes.length === 0) return { annotated: 0, skipped: 0 };

  // 按 token 预算动态分批
  const batches = splitIntoBatches(rawNodes);

  // 获取图谱词汇表（标签，所有批次共用）
  const vocab = getGraphVocabulary(db);

  let totalAnnotated = 0;
  let totalSkipped = 0;

  for (const batch of batches) {
    // 为每个节点获取向量邻居
    const nodesWithContext = batch.map(node => ({
      node,
      neighbors: isVecLoaded() ? getTopNeighbors(db, node.id, NEIGHBOR_COUNT()) : [],
      existingTags: parseTags(node.tags),
    }));

    const fallbackPrompt = buildAnnotatePrompt(nodesWithContext, vocab.tags);
    const system = getPrompt('annotate', ANNOTATE_SYSTEM);

    try {
      const response = await callLLM({
        prompt: renderUserPrompt('annotate', {
          frequent_tags: vocab.tags.join(', '),
          nodes_with_context: nodesWithContext.map(({ node, neighbors, existingTags }, i) => {
            const titleHint = node.title ? `（已有标题: ${node.title}）` : '（需要标题）';
            const parts = [`记忆 ${i + 1}${titleHint}: ${node.content.slice(0, MAX_CONTENT_PER_NODE())}`];
            if (existingTags.length > 0) parts.push(`  来源标签: [${existingTags.join(', ')}]`);
            if (neighbors.length > 0) parts.push(`  相关记忆: [${neighbors.map(n => `"${n.content}"`).join(', ')}]`);
            return parts.join('\n');
          }).join('\n\n'),
        }, fallbackPrompt),
        system,
        ...getLLMOptions('annotate'),
        maxTokens: 4096,
        operationName: 'annotate',
      });

      const annotations = parseAnnotations(response);

      // 按 index 匹配（从 1 开始）
      const annByIndex = new Map<number, AnnotationResult>();
      for (const ann of annotations) {
        if (ann.index != null) annByIndex.set(ann.index, ann);
      }

      let annotated = 0;
      for (let i = 0; i < batch.length; i++) {
        const node = batch[i];
        const ann = annByIndex.get(i + 1); // prompt 中编号从 1 开始
        if (!ann) continue;

        // 合并标签：保留已有 + LLM 补充
        const currentTags = parseTags(node.tags);
        const mergedTags = [...new Set([...currentTags, ...(ann.tags ?? [])])];

        // 校验维度分数在 0-1 范围
        const clamp = (v: number) => Math.max(0, Math.min(1, v));
        const specificity = typeof ann.specificity === 'number' ? clamp(ann.specificity) : undefined;
        const subjectivity = typeof ann.subjectivity === 'number' ? clamp(ann.subjectivity) : undefined;
        const actuality = typeof ann.actuality === 'number' ? clamp(ann.actuality) : undefined;

        // 双写：维度 + 从维度派生 legacy type + 标题
        const patch: Record<string, unknown> = {
          tags: mergedTags.length > 0 ? JSON.stringify(mergedTags) : undefined,
          refinement: 0.1,
        };
        // 仅在节点尚无标题时写入 LLM 生成的标题
        if (ann.title && !node.title) {
          patch.title = ann.title;
        }
        if (specificity !== undefined) patch.specificity = specificity;
        if (subjectivity !== undefined) patch.subjectivity = subjectivity;
        if (actuality !== undefined) patch.actuality = actuality;
        if (specificity !== undefined && subjectivity !== undefined && actuality !== undefined) {
          const { dimensionsToLegacyType } = await import('../utils/dimensions.js');
          patch.type = dimensionsToLegacyType({ specificity, subjectivity, actuality });
        }

        updateNode(db, node.id, patch as any);

        // 即时建立 tagged 链接：检查标注后的 tags 是否有对应的已存在 tag 节点
        if (mergedTags.length > 0) {
          linkToExistingTagNodes(db, node.id, node.content, mergedTags);
        }

        annotated++;
      }

      totalAnnotated += annotated;
      totalSkipped += batch.length - annotated;
    } catch (err) {
      log.error('节点标注失败:', (err as Error).message);
      totalSkipped += batch.length;
    }
  }

  if (totalAnnotated > 0) {
    log.info(`标注完成: ${totalAnnotated}/${rawNodes.length} 个节点 (${batches.length} 批)`);
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'annotate',
      title: JSON.stringify({ key: 'annotated', params: { count: totalAnnotated } }),
      detail: { annotated: totalAnnotated, skipped: totalSkipped, total: rawNodes.length },
      node_ids: rawNodes.slice(0, 30).map(n => n.id),
    });
  }
  return { annotated: totalAnnotated, skipped: totalSkipped };
}

/**
 * 按 token 预算动态分批
 *
 * 短记忆多塞、长记忆少塞，确保每批 prompt 大小在预算内。
 */
function splitIntoBatches(nodes: BrainNode[]): BrainNode[][] {
  const budget = CONTENT_BUDGET();
  const batches: BrainNode[][] = [];
  let currentBatch: BrainNode[] = [];
  let currentSize = 0;

  for (const node of nodes) {
    const nodeSize = Math.min(node.content.length, MAX_CONTENT_PER_NODE());
    if (currentBatch.length > 0 && currentSize + nodeSize > budget) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }
    currentBatch.push(node);
    currentSize += nodeSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

// ---- 查询函数 ----

/**
 * 查找未经 LLM 标注的节点
 *
 * 判断依据：refinement === 0.0（入库时 refinement 默认为 0）
 * 排除 crystal / meta 类型（这些由系统生成，不需要标注）
 */
export function findUnannotatedNodes(db: Database.Database, limit: number): BrainNode[] {
  return db.prepare(`
    SELECT * FROM nodes
    WHERE refinement = 0.0
      AND heat > 0.01
      AND is_crystal = 0
      AND is_meta = 0
      AND is_superseded = 0
    ORDER BY created DESC
    LIMIT ?
  `).all(limit) as BrainNode[];
}

/**
 * 统计图中高频标签（用于让 LLM 复用已有标签体系）
 */
export function getFrequentTags(db: Database.Database, limit: number): string[] {
  // tags 字段是 JSON 数组字符串，需要解析后统计
  const rows = db.prepare(`
    SELECT tags FROM nodes
    WHERE tags IS NOT NULL AND heat > 0.01 AND is_superseded = 0
  `).all() as Array<{ tags: string }>;

  const counter = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
  }

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/**
 * 获取节点的 top-K 向量邻居
 */
function getTopNeighbors(
  db: Database.Database,
  nodeId: string,
  k: number,
): Array<{ content: string; tags: string[] }> {
  const embedding = getVectorForNode(db, nodeId);
  if (!embedding) return [];

  // 取更多候选以便 crystal 加权后重排
  const results = searchVectors(db, embedding, k * 2 + 1);
  const candidates: Array<{ content: string; tags: string[]; score: number }> = [];

  for (const r of results) {
    if (r.id === nodeId) continue;
    const node = getNode(db, r.id);
    if (!node || node.heat < 0.01) continue;
    // 向量相似度（distance 越小越相似）
    let score = 1 / (1 + r.distance);
    // 原则 11（下行因果）：crystal 节点在标注上下文中加权，
    // 让高层洞察更容易影响新节点的标注结果
    if (node.is_crystal) score *= 1.3;
    candidates.push({
      content: node.content.slice(0, NEIGHBOR_PREVIEW()),
      tags: parseTags(node.tags),
      score,
    });
  }

  // 按加权分数降序，取 top-k
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, k).map(({ content, tags }) => ({ content, tags }));
}

// ---- Prompt 构建 ----

function buildAnnotatePrompt(
  nodesWithContext: Array<{
    node: BrainNode;
    neighbors: Array<{ content: string; tags: string[] }>;
    existingTags: string[];
  }>,
  frequentTags: string[],
): string {
  const parts: string[] = [];

  if (frequentTags.length > 0) {
    parts.push(`已有标签（必须优先复用已有写法）: ${frequentTags.join(', ')}`);
    parts.push('');
  }

  for (let i = 0; i < nodesWithContext.length; i++) {
    const { node, neighbors, existingTags } = nodesWithContext[i];
    const titleHint = node.title ? `（已有标题: ${node.title}）` : '（需要标题）';
    parts.push(`记忆 ${i + 1}${titleHint}: ${node.content.slice(0, MAX_CONTENT_PER_NODE())}`);
    if (existingTags.length > 0) {
      parts.push(`  来源标签: [${existingTags.join(', ')}]`);
    }
    if (neighbors.length > 0) {
      const neighborStrs = neighbors.map(n => `"${n.content}"`).join(', ');
      parts.push(`  相关记忆: [${neighborStrs}]`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ---- 响应解析 ----

interface AnnotationResult {
  index?: number;
  specificity?: number;
  subjectivity?: number;
  actuality?: number;
  /** @deprecated 旧的分类字段，新 prompt 不再输出 */
  type?: string;
  tags?: string[];
  title?: string;
}

function parseAnnotations(response: string): AnnotationResult[] {
  const parsed = parseLLMJson<Array<Record<string, unknown>>>(response);
  if (!Array.isArray(parsed)) return [];

  return parsed.map((item, posIndex) => ({
    index: typeof item.index === 'number' ? item.index : posIndex + 1,
    specificity: typeof item.specificity === 'number' ? item.specificity : undefined,
    subjectivity: typeof item.subjectivity === 'number' ? item.subjectivity : undefined,
    actuality: typeof item.actuality === 'number' ? item.actuality : undefined,
    type: typeof item.type === 'string' ? item.type : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((t: unknown) => typeof t === 'string') : undefined,
    title: typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined,
  }));
}

// ---- 即时 tagged 链接 ----

/**
 * 标注完成后，为节点的 tags 建立到已存在 tag 节点的 tagged 链接。
 *
 * 强度启发式（与 tag-promote 一致）：
 * - 内容提及标签文本 → 0.7，否则 0.4
 * - 唯一标签 → +0.1
 */
function linkToExistingTagNodes(
  db: Database.Database,
  nodeId: string,
  nodeContent: string,
  tags: string[],
): void {
  const minStrength = getParam('metabolism-params', 'tag_link_min_strength', 0.3);

  // 批量查找已存在的 tag 节点（优先用 title 匹配，兼容旧数据用 content）
  const tagNodes = db.prepare(
    "SELECT id, title, content FROM nodes WHERE is_tag = 1 AND heat > 0.01 AND is_superseded = 0",
  ).all() as Array<{ id: string; title: string | null; content: string }>;
  const tagNodeMap = new Map(tagNodes.map(tn => [tn.title ?? tn.content, tn.id]));

  for (const tag of tags) {
    const tagNodeId = tagNodeMap.get(tag);
    if (!tagNodeId) continue; // tag 节点不存在，等 tag-promote 创建
    if (linkExists(db, nodeId, tagNodeId)) continue;

    const contentMention = nodeContent.toLowerCase().includes(tag.toLowerCase()) ? 0.7 : 0.4;
    const concentrationBonus = tags.length === 1 ? 0.1 : 0;
    const strength = Math.min(0.8, contentMention + concentrationBonus);

    if (strength < minStrength) continue;

    createLink(db, {
      from_id: nodeId,
      to_id: tagNodeId,
      relation: [{ type: 'tagged', confidence: 0.9 }],
      strength,
      auto: true,
      status: 'confirmed',
    });
  }
}
