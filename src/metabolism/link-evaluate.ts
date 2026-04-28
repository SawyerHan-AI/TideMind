// ============================================================
// 思考（关联）— 链接评估
//
// 统一处理：自动创建的链接的关系类型评估 + 待确认链接的有效性判断。
// 合并了旧的 refine-links 和 pending-links 两个任务。
// ============================================================

import type Database from 'better-sqlite3';
import type { BrainNode, BrainLink, RelationType, LinkRelation } from '../types.js';
import { getNode } from '../db/nodes.js';
import { updateLinkStatus, updateLinkRelation, deleteLink } from '../db/links.js';
import { isLlmConfigured } from '../config.js';
import { callLLM } from '../llm/client.js';
import { getParam, getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { createLogger } from '../utils/logger.js';
import { parseLLMJson } from '../llm/json-parse.js';

const log = createLogger('link-evaluate');

const VALID_RELATIONS = new Set<string>([
  'caused_by', 'continues', 'updates', 'supports', 'contradicts',
  'summarizes', 'part_of', 'analogous', 'tagged',
]);

const FALLBACK_SYSTEM = `你是关系评估器。判断多对记忆之间的关系是否成立，以及具体的关系类型。

判断原则：
- "有意义的关联"不是"有任何共同点"。两条记忆仅共享常见词汇或属于同一大领域，不算有意义。有意义意味着：了解其中一条后，对另一条的理解会改变。
- 关系类型描述的是 A 对 B 的关系方向。选择时想象一条从 A 指向 B 的箭头。
- 当多种关系类型都能成立时，选择最核心、最具信息量的那个。
- confidence 反映确定程度，应有区分度：显而易见的关系给高分，需要推理才能看出的给中等分，勉强成立的给低分。

关系类型（A 对 B 的关系）:
- caused_by: A 是因为 B 才产生的（B 是原因，A 是结果）
- continues: A 是 B 的延续或后续发展（B 在先，A 在后，同一条线上）
- updates: A 替代/修正了 B（B 是旧版本，A 是新版本）
- supports: A 为 B 提供证据或论据（A 是证据，B 是结论）
- contradicts: A 和 B 内容矛盾（无方向性）
- summarizes: A 是对 B 的概括或抽象（A 更抽象，B 更具体）
- part_of: A 是 B 的一部分或从属于 B（A 是局部，B 是整体）
- analogous: A 和 B 在不同领域有结构相似性（无方向性）
- tagged: A 和 B 属于同一分类或标签（无方向性，仅用于纯分类关系）

输出 JSON 数组:
[{ "index": 1, "valid": true, "relation": "...", "confidence": 0.0-1.0 }]

如果关联不成立:
[{ "index": 1, "valid": false }]

只输出 JSON 数组。`;

const BATCH_SIZE = 10;
const CONTENT_PER_LINK = 500;

type LinkRow = BrainLink & { auto: number };

export interface LinkEvaluateResult {
  evaluated: number;
  confirmed: number;
  deleted: number;
}

/**
 * 评估最近创建的链接
 *
 * 统一处理 auto-created 链接和 pending 链接：
 * - 判断关系是否成立
 * - 确定准确的关系类型
 * - 确认或删除
 */
export async function runLinkEvaluate(db: Database.Database): Promise<LinkEvaluateResult> {
  if (!isLlmConfigured()) return { evaluated: 0, confirmed: 0, deleted: 0 };

  const lookbackHours = getParam('link-evaluate', 'lookback_hours', 48);
  const maxLinks = getParam('link-evaluate', 'max_links_per_run', 50);
  const pendingExpireDays = getParam('link-evaluate', 'pending_expire_days', 7);

  // 无界先清理过期 pending 链接:原逻辑把过期判定放到 LIMIT ? 之后的 JS 循环里,
  // 意味着当 pending 堆积 > maxLinks(50) 时,超出 LIMIT 的那些"年纪更大的"
  // pending 链接永远进不来,也永远不会过期被清,只能无限累积。
  // 这里在任何 LIMIT 之前先无界 DELETE 所有超过 pending_expire_days 的 pending,
  // 保证过期清理不被 per-run 预算挤掉。
  const expiredCutoff = `-${pendingExpireDays} days`;
  const purgedExpired = db.prepare(
    `DELETE FROM links
     WHERE status = 'pending' AND created < datetime('now', ?)`,
  ).run(expiredCutoff).changes;

  // 收集需要评估的链接（合并 auto 新链接 + pending 链接）
  const recentAutoLinks = db.prepare(`
    SELECT * FROM links
    WHERE auto = 1
      AND status != 'confirmed'
      AND created > datetime('now', ?)
    ORDER BY created DESC
    LIMIT ?
  `).all(`-${lookbackHours} hours`, maxLinks) as LinkRow[];

  const pendingLinks = db.prepare(`
    SELECT * FROM links
    WHERE status = 'pending'
    ORDER BY created ASC
    LIMIT ?
  `).all(maxLinks) as LinkRow[];

  // 合并去重（pending 链接可能也在 recent auto 中）
  const seen = new Set<string>();
  const allLinks: LinkRow[] = [];
  for (const link of [...recentAutoLinks, ...pendingLinks]) {
    if (!seen.has(link.id)) {
      seen.add(link.id);
      allLinks.push(link);
    }
  }

  if (allLinks.length === 0) return { evaluated: 0, confirmed: 0, deleted: purgedExpired };

  // 先处理过期的 pending 链接 — 过期一律删,不再留 strength>=0.5 的 pending
  // 链接。之前加 strength<0.5 的意图是"高强度的再留一轮机会",但 pending
  // 本身就意味着 LLM 没来得及/没配置来确认,留着只会让 pending 越积越多、
  // evaluator 每次都要扫过它们。强度本身就是创建者自评,不应作为保护条件。
  //
  // 上面无界 DELETE 已经把过期 pending 清掉了,这里是一道 JS 侧兜底(防止
  // 同 tick 内 datetime('now') 与 JS Date.now 的秒级误差漏掉边界行)。
  let deleted = purgedExpired;
  const toEvaluate: LinkRow[] = [];
  for (const link of allLinks) {
    if (link.status === 'pending') {
      const daysSinceCreation = (Date.now() - new Date(link.created).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCreation > pendingExpireDays) {
        deleteLink(db, link.id);
        deleted++;
        continue;
      }
    }
    toEvaluate.push(link);
  }

  // 预加载节点
  const nodeCache = new Map<string, BrainNode>();
  for (const link of toEvaluate) {
    for (const id of [link.from_id, link.to_id]) {
      if (!nodeCache.has(id)) {
        const n = getNode(db, id);
        if (n) nodeCache.set(id, n);
      }
    }
  }

  // 过滤掉节点已不存在的链接
  const validLinks = toEvaluate.filter(l =>
    nodeCache.has(l.from_id) && nodeCache.has(l.to_id),
  );

  if (validLinks.length === 0) return { evaluated: 0, confirmed: 0, deleted };

  // 批量 LLM 评估
  let confirmed = 0;
  const batches = [];
  for (let i = 0; i < validLinks.length; i += BATCH_SIZE) {
    batches.push(validLinks.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    const result = await evaluateBatch(db, batch, nodeCache);
    confirmed += result.confirmed;
    deleted += result.deleted;
  }

  const evaluated = validLinks.length;

  if (evaluated > 0) {
    log.info(`链接评估: 评估=${evaluated} 确认=${confirmed} 删除=${deleted}`);
    logTimelineEvent(db, {
      type: 'think_associate',
      subtype: 'link_classify',
      title: JSON.stringify({ key: 'links_evaluated', params: { count: evaluated } }),
      detail: { evaluated, confirmed, deleted },
    });
  }

  return { evaluated, confirmed, deleted };
}

async function evaluateBatch(
  db: Database.Database,
  links: LinkRow[],
  nodeCache: Map<string, BrainNode>,
): Promise<{ confirmed: number; deleted: number }> {
  let confirmed = 0;
  let deleted = 0;

  try {
    // 构建 prompt
    const parts: string[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const from = nodeCache.get(link.from_id);
      const to = nodeCache.get(link.to_id);
      if (!from || !to) continue;
      parts.push(`--- 对 ${i + 1} ---`);
      parts.push(`A [${from.type}]: ${from.content.slice(0, CONTENT_PER_LINK)}`);
      parts.push(`B [${to.type}]: ${to.content.slice(0, CONTENT_PER_LINK)}`);
      parts.push('');
    }

    const fallbackPrompt = parts.join('\n');
    const response = await callLLM({
      prompt: renderUserPrompt('link-evaluate', {
        link_pairs: fallbackPrompt,
      }, fallbackPrompt),
      system: getPrompt('link-evaluate', FALLBACK_SYSTEM),
      ...getLLMOptions('link-evaluate'),
      maxTokens: 2048,
      operationName: 'link-evaluate',
    });

    const results = parseBatchResults(response);
    const resultByIndex = new Map<number, { valid: boolean; relation?: string; confidence?: number }>();
    for (const r of results) {
      if (r.index != null) resultByIndex.set(r.index, r);
    }

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const result = resultByIndex.get(i + 1);

      if (!result) continue; // LLM 没返回这对的结果，跳过

      if (!result.valid) {
        // 关系不成立 → 删除
        deleteLink(db, link.id);
        deleted++;
      } else if (result.relation && VALID_RELATIONS.has(result.relation)) {
        // 关系成立 → 更新关系类型并确认
        const confidence = result.confidence ?? 0.7;
        const newRelation: LinkRelation[] = [{ type: result.relation as RelationType, confidence }];
        updateLinkRelation(db, link.id, newRelation);
        if (link.status === 'pending') {
          updateLinkStatus(db, link.id, 'confirmed');
        }
        confirmed++;
      }
    }
  } catch (err) {
    log.warn(`链接评估批次失败: ${(err as Error).message}`);
  }

  return { confirmed, deleted };
}

function parseBatchResults(response: string): Array<{
  index: number;
  valid: boolean;
  relation?: string;
  confidence?: number;
}> {
  const parsed = parseLLMJson<Array<Record<string, unknown>>>(response);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(item => typeof item.index === 'number' && typeof item.valid === 'boolean')
    .map(item => ({
      index: item.index as number,
      valid: item.valid as boolean,
      relation: typeof item.relation === 'string' ? item.relation : undefined,
      confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
    }));
}
