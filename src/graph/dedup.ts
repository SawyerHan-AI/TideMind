import type Database from 'better-sqlite3';
import { getNode, updateNode, parseTags } from '../db/nodes.js';
import { now } from '../utils/time.js';
import { callLLM } from '../llm/client.js';
import { DEDUP_MERGE_SYSTEM } from '../llm/prompts.js';
import { isLlmConfigured } from '../config.js';
import { getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('dedup');

/**
 * 再巩固：更新已有节点的内容（merge 新信息）
 *
 * 数据保全不变量：在任何失败/降级路径上，宁可保留旧 node.content 也不要
 * 替换成 newContent 片段。newContent 是触发 dedup 的"新写入"，往往只是
 * 已有记忆的一小段或临近内容，直接覆盖等于把旧记忆抹掉换成碎片。
 * 因此：LLM 未配置 / 抛错 / 返回内容明显短于原文（疑似幻觉丢字）时
 * 都保留旧内容，仅做热度/标签合并；只有 LLM 成功并通过长度防御后才落库。
 */
export async function reconsolidateNode(
  db: Database.Database,
  nodeId: string,
  newContent: string,
  reason: string = '去重合并',
  opts?: { newTags?: string[] },
): Promise<void> {
  const node = getNode(db, nodeId);
  if (!node) return;

  let merged: string;

  if (isLlmConfigured() && node.content !== newContent) {
    try {
      const result = await callLLM({
        system: getPrompt('dedup-merge', DEDUP_MERGE_SYSTEM),
        prompt: renderUserPrompt('dedup-merge', {
          existing_content: node.content,
          new_content: newContent,
        }, `已有记忆:\n${node.content}\n\n新信息（较新，冲突时优先）:\n${newContent}`),
        ...getLLMOptions('dedup-merge'),
        maxTokens: 500,
        operationName: 'dedup',
      });
      const candidate = result.trim();
      if (!candidate) {
        // LLM 返回空 → 保留旧内容
        log.warn(`去重合并跳过 target=${nodeId}: LLM 返回空，保留原内容`);
        merged = node.content;
      } else if (
        candidate.length < node.content.length * 0.5 &&
        candidate.length < newContent.length
      ) {
        // 防御：合并结果显著短于原文且短于新内容 → 疑似 LLM 幻觉丢字，保留旧内容
        log.warn(
          `去重合并被拒 target=${nodeId}: 合并结果长度 ${candidate.length} 远小于原内容 ${node.content.length}，疑似数据丢失，保留原内容`,
        );
        merged = node.content;
      } else {
        merged = candidate;
      }
    } catch (err) {
      // LLM 调用失败 → 保留旧内容，不要用 newContent 覆盖
      log.warn(
        `去重合并跳过 target=${nodeId}: LLM 调用失败 (${(err as Error).message})，保留原内容`,
      );
      merged = node.content;
    }
  } else {
    // LLM 未配置或新旧内容相同 → 保留旧内容（不冒险用 newContent 替换）
    merged = node.content;
  }

  // 合并内容 + 标签
  const patch: Record<string, unknown> = {};
  if (merged !== node.content) {
    log.info(`去重合并 target=${nodeId} reason="${reason}"`);
    patch.content = merged;
  }

  // 合并标签（去重）
  if (opts?.newTags && opts.newTags.length > 0) {
    const existingTags = parseTags(node.tags);
    const mergedTags = [...new Set([...existingTags, ...opts.newTags])];
    patch.tags = JSON.stringify(mergedTags);
  }

  if (Object.keys(patch).length > 0) {
    updateNode(db, nodeId, patch as any, reason);
  }

  // 更新热度和再巩固时间
  db.prepare(`
    UPDATE nodes SET heat = MIN(heat + 0.3, 10.0), last_reconsolidated = ? WHERE id = ?
  `).run(now(), nodeId);
}
