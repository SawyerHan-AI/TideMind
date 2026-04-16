import type Database from 'better-sqlite3';
import { getNode, updateNode, parseTags } from '../db/nodes.js';
import { getLinksForNode } from '../db/links.js';
import { now } from '../utils/time.js';
import { callLLM } from '../llm/client.js';
import { DEDUP_MERGE_SYSTEM } from '../llm/prompts.js';
import { getConfig, isLlmConfigured } from '../config.js';
import { getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('dedup');

/**
 * 再巩固：更新已有节点的内容（merge 新信息）
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
  const config = getConfig();

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
      merged = result.trim() || newContent;
    } catch {
      merged = newContent;
    }
  } else {
    merged = newContent;
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
