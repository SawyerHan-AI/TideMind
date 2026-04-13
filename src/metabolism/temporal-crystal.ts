// ============================================================
// 思考（涌现）— 时间结晶
//
// 发现跨时间维度的模式和演变：
// 1. 同主题时间链：同一话题在不同时间点的演变轨迹
// 2. 跨主题共振：不同话题在相近时间段的关联
// 3. 周期性回访：定期出现的主题模式
// ============================================================

import type Database from 'better-sqlite3';
import type { BrainNode } from '../types.js';
import { getNode, updateNode } from '../db/nodes.js';
import { createLink, linkExists } from '../db/links.js';
import { isLlmConfigured } from '../config.js';
import { callLLM } from '../llm/client.js';
import { getParam, getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';
import { updateConnectivity } from '../graph/maturity.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';

const log = createLogger('temporal-crystal');

const FALLBACK_SYSTEM = `你是一个时间维度的知识分析器。你的任务是从一组按时间排列的记忆片段中，发现跨时间的模式和演变。

分析以下按时间排列的记忆片段，找出：
1. 核心主题是如何随时间演变的
2. 有哪些关键转折点或认知升级
3. 是否存在被遗忘但有价值的早期洞察

输出 JSON:
{
  "pattern_type": "evolution" | "resonance" | "periodic",
  "title": "一句话标题",
  "insight": "2-3句话的深度分析",
  "key_node_ids": ["涉及的关键节点ID"],
  "confidence": 0.0-1.0
}

只输出 JSON。`;

export interface TemporalCrystalResult {
  analyzed: number;
  crystals_created: number;
}

/**
 * 时间结晶：发现跨时间维度的模式
 */
export async function runTemporalCrystal(db: Database.Database): Promise<TemporalCrystalResult> {
  if (!isLlmConfigured()) {
    log.debug('时间结晶跳过: LLM 未配置');
    return { analyzed: 0, crystals_created: 0 };
  }

  const minNodes = getParam('temporal-crystal', 'gate_min_nodes', 200);
  const totalNodes = (db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND is_superseded = 0').get() as { cnt: number }).cnt;
  if (totalNodes < minNodes) {
    log.debug(`时间结晶跳过: 节点数 ${totalNodes} < 门控 ${minNodes}`);
    return { analyzed: 0, crystals_created: 0 };
  }

  let analyzed = 0;
  let crystals_created = 0;

  // --- 模式 1: 同主题时间链 ---
  const evolutionResult = await findTopicEvolution(db);
  analyzed += evolutionResult.analyzed;
  crystals_created += evolutionResult.created;

  // --- 模式 2: 跨主题共振 ---
  const resonanceResult = await findCrossTopicResonance(db);
  analyzed += resonanceResult.analyzed;
  crystals_created += resonanceResult.created;

  if (crystals_created > 0) {
    log.info(`时间结晶: 分析=${analyzed} 新结晶=${crystals_created}`);
    logTimelineEvent(db, {
      type: 'think_emerge',
      subtype: 'crystal_update',
      title: JSON.stringify({ key: 'temporal_crystal', params: { count: crystals_created } }),
      detail: { analyzed, crystals_created },
      important: 1,
    });
  }

  return { analyzed, crystals_created };
}

/**
 * 模式 1: 同主题时间链
 *
 * 找到核心标签（is_tag=1）下的节点，按时间排序，发现演变轨迹
 */
async function findTopicEvolution(db: Database.Database): Promise<{ analyzed: number; created: number }> {
  const maxTopics = getParam('temporal-crystal', 'max_topics', 3);
  const minNodesPerTopic = getParam('temporal-crystal', 'min_nodes_per_topic', 5);

  // 找核心标签（is_tag=1 的图节点）及其关联节点数
  const coreTags = db.prepare(`
    SELECT t.content as tag, COUNT(DISTINCT n.id) as cnt
    FROM nodes t
    JOIN nodes n ON n.heat > 0.01 AND n.is_meta = 0 AND n.is_tag = 0 AND n.is_superseded = 0
      AND EXISTS (SELECT 1 FROM json_each(n.tags) je WHERE je.value = t.content)
    WHERE t.is_tag = 1 AND t.heat > 0.01 AND t.is_superseded = 0
    GROUP BY t.content
    HAVING cnt >= ?
    ORDER BY cnt DESC
    LIMIT ?
  `).all(minNodesPerTopic, maxTopics) as Array<{ tag: string; cnt: number }>;

  let analyzed = 0;
  let created = 0;

  for (const topic of coreTags) {
    // 获取该标签下的时间线
    const nodes = db.prepare(`
      SELECT id, content, created, heat
      FROM nodes
      WHERE EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = ?)
        AND heat > 0.01 AND is_meta = 0 AND is_crystal = 0 AND is_superseded = 0
      ORDER BY created ASC
      LIMIT 20
    `).all(topic.tag) as Array<{ id: string; content: string; created: string; heat: number }>;

    if (nodes.length < minNodesPerTopic) continue;
    analyzed++;

    // 检查是否已有该标签的时间结晶
    const existingCrystal = db.prepare(`
      SELECT 1 FROM nodes
      WHERE is_crystal = 1 AND tags LIKE ? AND content LIKE '%时间演变%' AND is_superseded = 0
      LIMIT 1
    `).get(`%"${topic.tag}"%`);

    if (existingCrystal) continue;

    try {
      const timelinePrompt = nodes.map((n, i) =>
        `[${i + 1}] ${n.created.slice(0, 10)} | ${n.content.slice(0, 150)}`,
      ).join('\n');
      const fallbackTcPrompt = `主题: ${topic.tag}\n\n按时间排列的记忆:\n${timelinePrompt}\n\n分析这个主题的知识演变轨迹。`;

      const response = await callLLM({
        prompt: renderUserPrompt('temporal-crystal', {
          topic: topic.tag,
          timeline: timelinePrompt,
        }, fallbackTcPrompt),
        system: getPrompt('temporal-crystal', FALLBACK_SYSTEM),
        ...getLLMOptions('temporal-crystal'),
        maxTokens: 500,
        operationName: 'temporal-crystal',
      });

      const result = parseLLMJson<{
        pattern_type?: string;
        title?: string;
        insight: string;
        key_node_ids?: string[];
        confidence: number;
      }>(response);
      if (!result || result.confidence < 0.5) continue;

      // 创建结晶节点
      const crystalId = generateId();
      const crystalContent = `[时间演变] ${topic.tag}: ${result.insight}`;

      db.prepare(`
        INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
          maturity_score, is_crystal, specificity, subjectivity, actuality,
          tags, created, version)
        VALUES (?, 'fact', ?, 1.0, 0.8, 0.0, 0.8, 0.5, 1, 0.2, 0.5, 0.8, ?, ?, 1)
      `).run(crystalId, crystalContent, JSON.stringify(['时间结晶', topic.tag]), now());

      // 链接到关键节点
      const keyNodes = result.key_node_ids?.filter(id => nodes.some(n => n.id === id)) ?? [];
      const nodesToLink = keyNodes.length > 0 ? keyNodes : nodes.slice(0, 5).map(n => n.id);

      for (const nodeId of nodesToLink) {
        if (!linkExists(db, crystalId, nodeId)) {
          createLink(db, {
            from_id: crystalId,
            to_id: nodeId,
            relation: [{ type: 'summarizes', confidence: result.confidence }],
            strength: result.confidence,
            auto: true,
          });
          updateConnectivity(db, nodeId);
        }
      }
      updateConnectivity(db, crystalId);
      created++;
    } catch (err) {
      log.warn(`时间结晶失败 tag=${topic.tag}: ${(err as Error).message}`);
    }
  }

  return { analyzed, created };
}

/**
 * 模式 2: 跨主题共振
 *
 * 在相近时间段（同一周）内，不同核心标签的节点之间是否有未被发现的关联
 */
async function findCrossTopicResonance(db: Database.Database): Promise<{ analyzed: number; created: number }> {
  const maxWeeks = getParam('temporal-crystal', 'max_resonance_weeks', 3);

  // 获取核心标签列表
  const coreTagRows = db.prepare(
    "SELECT content FROM nodes WHERE is_tag = 1 AND heat > 0.01 AND is_superseded = 0"
  ).all() as Array<{ content: string }>;
  const coreTagSet = new Set(coreTagRows.map(r => r.content));

  if (coreTagSet.size < 2) return { analyzed: 0, created: 0 };

  // 找最近几周有活跃节点的周
  const weeks = db.prepare(`
    SELECT strftime('%Y-W%W', created) as week, COUNT(*) as node_count
    FROM nodes
    WHERE tags IS NOT NULL AND heat > 0.01 AND is_meta = 0 AND is_superseded = 0
    GROUP BY week
    HAVING node_count >= 3
    ORDER BY week DESC
    LIMIT ?
  `).all(maxWeeks) as Array<{ week: string; node_count: number }>;

  let analyzed = 0;
  let created = 0;

  for (const week of weeks) {
    // 获取该周的节点
    const nodes = db.prepare(`
      SELECT id, content, tags, created
      FROM nodes
      WHERE strftime('%Y-W%W', created) = ? AND tags IS NOT NULL AND heat > 0.01 AND is_meta = 0 AND is_superseded = 0
      ORDER BY heat DESC
      LIMIT 15
    `).all(week.week) as Array<{ id: string; content: string; tags: string; created: string }>;

    if (nodes.length < 3) continue;

    // 按核心标签分组
    const byTag = new Map<string, typeof nodes>();
    for (const n of nodes) {
      let tags: string[] = [];
      try { tags = JSON.parse(n.tags); } catch { continue; }
      for (const tag of tags) {
        if (!coreTagSet.has(tag)) continue;
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(n);
      }
    }
    if (byTag.size < 2) continue;
    analyzed++;

    try {
      const summaryPrompt = [...byTag.entries()].map(([tag, ns]) =>
        `主题 ${tag}:\n${ns.slice(0, 3).map(n => `  - ${n.content.slice(0, 100)}`).join('\n')}`,
      ).join('\n\n');
      const fallbackResonancePrompt = `时间段: ${week.week}\n\n同一时期的不同主题记忆:\n${summaryPrompt}\n\n这些不同主题在同一时期有什么交叉点或共振？`;

      const response = await callLLM({
        prompt: renderUserPrompt('temporal-crystal', {
          topic: week.week,
          timeline: summaryPrompt,
        }, fallbackResonancePrompt),
        system: getPrompt('temporal-crystal', FALLBACK_SYSTEM),
        ...getLLMOptions('temporal-crystal'),
        maxTokens: 500,
        operationName: 'temporal-crystal',
      });

      const result = parseLLMJson<{
        pattern_type?: string;
        title?: string;
        insight: string;
        key_node_ids?: string[];
        confidence: number;
      }>(response);
      if (!result || result.confidence < 0.6) continue;
      if (result.pattern_type !== 'resonance') continue;

      // 创建结晶
      const crystalId = generateId();
      const crystalContent = `[跨主题共振] ${week.week}: ${result.insight}`;

      db.prepare(`
        INSERT INTO nodes (id, type, content, heat, refinement, connectivity, independence,
          maturity_score, is_crystal, specificity, subjectivity, actuality,
          tags, created, version)
        VALUES (?, 'fact', ?, 1.0, 0.8, 0.0, 0.8, 0.5, 1, 0.2, 0.5, 0.8, '["时间结晶","跨主题"]', ?, 1)
      `).run(crystalId, crystalContent, now());

      // 链接到涉及的节点
      const allNodes = [...new Map(nodes.map(n => [n.id, n])).values()];
      for (const n of allNodes.slice(0, 6)) {
        if (!linkExists(db, crystalId, n.id)) {
          createLink(db, {
            from_id: crystalId,
            to_id: n.id,
            relation: [{ type: 'summarizes', confidence: result.confidence }],
            strength: result.confidence,
            auto: true,
          });
        }
      }
      updateConnectivity(db, crystalId);
      created++;
    } catch (err) {
      log.warn(`跨主题共振分析失败 week=${week.week}: ${(err as Error).message}`);
    }
  }

  return { analyzed, created };
}

