import type Database from 'better-sqlite3';
import type { DigestInput, DigestOutput, NodeType } from '../types.js';
import { inferDimensions } from '../utils/dimensions.js';
import { createNode, getNode, updateNode, archiveNode, parseTags } from '../db/nodes.js';
import { deleteLink } from '../db/links.js';
import { logOperation, logStrategyFeedback, logTimelineEvent, logParamFeedback } from '../db/log.js';
import { appendToStream } from '../stream/writer.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';

import { insertSegmentVectors, getVectorForNode } from '../db/vectors.js';
import { isVecLoaded } from '../db/connection.js';
import { findLandingConnections } from '../graph/landing.js';
import { reconsolidateNode } from '../graph/dedup.js';
import { enqueuePendingDigest } from '../db/pending-digests.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('digest');

/**
 * brain_digest — 消化信息
 *
 * 基础版：content 直接存为单个节点（后续 Step 7 加 LLM 提取）
 */
export async function digest(db: Database.Database, input: DigestInput): Promise<DigestOutput> {
  const traceId = generateId();
  log.info(`intent=${input.intent ?? 'new'} contentLen=${input.content.length} async=${input.async !== false} trace=${traceId}`);

  // --- 纠正已有节点 ---
  if (input.intent === 'correction' && input.target_node) {
    const existing = getNode(db, input.target_node);
    if (!existing) {
      log.warn(`correction 目标节点不存在: ${input.target_node}`);
      return { status: 'rejected', trace_id: traceId, reject_reason: `目标节点 ${input.target_node} 不存在` };
    }

    updateNode(db, input.target_node, { content: input.content }, 'correction');
    log.info(`correction target=${input.target_node}`);
    const updated = getNode(db, input.target_node)!;

    // Stream 先写（获取锚点引用）
    const corrStreamRef = appendToStream({
      tool: input.source?.tool,
      session: input.source?.session,
      content: `[纠正] ${input.content}`,
    });

    // 纠正记录：完整保留修改前后内容
    const correctionNode = createNode(db, {
      type: 'meta',
      is_meta: 1,
      content: [
        `## 纠正记忆`,
        ``,
        `**节点**: ${input.target_node}`,
        `**修改前**:`,
        existing.content,
        ``,
        `**修改后**:`,
        input.content,
        input.context ? `\n**纠正原因**: ${input.context}` : '',
      ].filter(Boolean).join('\n'),
      source_tool: input.source?.tool,
      source_session: input.source?.session,
      source_stream: corrStreamRef,
      heat: 0.3,
    });

    logOperation(db, {
      operation: 'digest',
      input_summary: `correction: ${input.target_node}`,
      context: input.context,
      output_node_ids: [input.target_node, correctionNode.id],
      tool: input.source?.tool,
      session: input.source?.session,
      agent_id: input.agent_id,
    });

    // Learning II 实时信号：correction = 标注质量负反馈
    logParamFeedback(db, {
      strategy_name: 'annotate',
      signal_type: 'correction',
      signal_value: -1.0,
      context: JSON.stringify({ target_node: input.target_node }),
    });

    return {
      status: 'processed',
      trace_id: traceId,
      updated_nodes: [{ id: updated.id, content: updated.content, version: updated.version }],
    };
  }

  // --- 断开错误链接 ---
  if (input.intent === 'correction' && input.target_link) {
    log.info(`unlink ${input.target_link.from} → ${input.target_link.to}`);
    const link = db.prepare(
      'SELECT * FROM links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    ).get(input.target_link.from, input.target_link.to, input.target_link.to, input.target_link.from) as { id: string } | undefined;

    if (link) {
      deleteLink(db, link.id);
    }

    logOperation(db, {
      operation: 'digest',
      input_summary: `unlink: ${input.target_link.from} → ${input.target_link.to}`,
      context: input.context,
      tool: input.source?.tool,
      session: input.source?.session,
      agent_id: input.agent_id,
    });

    return { status: 'processed', trace_id: traceId };
  }

  // --- 归档 ---
  if (input.intent === 'archive' && input.target_node) {
    log.info(`archive target=${input.target_node}`);
    archiveNode(db, input.target_node);

    logOperation(db, {
      operation: 'digest',
      input_summary: `archive: ${input.target_node}`,
      context: input.context,
      tool: input.source?.tool,
      session: input.source?.session,
      agent_id: input.agent_id,
    });

    return {
      status: 'processed',
      trace_id: traceId,
      archived_nodes: [input.target_node],
    };
  }

  // --- 常规消化：存储新内容 ---

  // 质量门控：第一层 — 硬拒绝（零信息内容）
  // 有 title 的节点（如标签节点）允许 content 为空
  const trimmed = input.content.trim();
  if (trimmed.length < 5 && !input.title) {
    log.info(`内容被拒绝: 长度=${trimmed.length} 不足5字符`);
    return {
      status: 'rejected',
      trace_id: traceId,
      reject_reason: `内容过短（${trimmed.length}字符），至少需要5字符`,
    };
  }

  // 质量门控：第二层 — 启发式质量评估（影响初始热度）
  const qualityHeat = assessContentQuality(trimmed);

  // Stream 日志先写（原始记录）
  const streamRef = appendToStream({
    tool: input.source?.tool,
    session: input.source?.session,
    content: input.content,
    files: input.source?.files,
  });

  // 异步模式（默认）：stream 已写入，后台处理其余部分
  if (input.async !== false) {
    Promise.resolve().then(async () => {
      try {
        await processDigestContent(db, input, streamRef, traceId, qualityHeat);
      } catch (err) {
        log.error('异步 digest 处理失败:', (err as Error).message);
        logOperation(db, {
          operation: 'digest',
          input_summary: `[FAILED] ${input.content.slice(0, 80)}`,
          context: `Error: ${(err as Error).message}`,
          tool: input.source?.tool,
          session: input.source?.session,
          agent_id: input.agent_id,
        });
        try {
          enqueuePendingDigest(db, traceId, JSON.stringify(input), (err as Error).message);
        } catch (enqueueErr) {
          log.error('Failed to enqueue digest for retry:', (enqueueErr as Error).message);
        }
      }
    });
    return { status: 'accepted', trace_id: traceId };
  }

  // 同步模式（async === false）：完整处理后返回
  const result = await processDigestContent(db, input, streamRef, traceId, qualityHeat);

  return {
    status: 'processed',
    trace_id: traceId,
    created_nodes: result.nodes,
    created_links: result.links.length > 0 ? result.links : undefined,
  };
}

/**
 * 消化内容的核心处理逻辑（纯机械路径，不调 LLM）
 *
 * 不调用 LLM。存原文 + 继承标签/type + embedding + 着陆连接。
 * LLM 标注（维度评分、补充标签）由节点标注任务近实时处理完成。
 */
async function processDigestContent(
  db: Database.Database,
  input: DigestInput,
  streamRef: string,
  traceId: string,
  qualityHeat: number = 1.0,
): Promise<{
  nodes: Array<{ id: string; content: string; type: NodeType }>;
  links: Array<{ from_id: string; to_id: string; relation: string }>;
}> {
  const dims = inferDimensions(input.content);
  const node = createNode(db, {
    content: input.content.trim(),
    title: input.title,
    specificity: dims.specificity,
    subjectivity: dims.subjectivity,
    actuality: dims.actuality,
    source_tool: input.source?.tool,
    source_session: input.source?.session,
    source_stream: streamRef,
    source_timestamp: now(),
    tags: input.tags,
    heat: input.initialHeat ?? qualityHeat,
    created: input.created,
  });
  const createdNodes = [{ id: node.id, content: node.content, type: node.type }];
  const createdLinks: Array<{ from_id: string; to_id: string; relation: string }> = [];

  if (isVecLoaded()) {
    // title 和 content 拼接用于 embedding，title 在前获得更高注意力权重
    const embeddingText = node.title
      ? `${node.title}\n\n${node.content}`
      : node.content;
    const links = await generateAndStoreEmbedding(db, node.id, embeddingText);
    createdLinks.push(...links);
  }

  log.info(`创建节点 id=${node.id} type=${node.type} dims=[${dims.specificity.toFixed(1)},${dims.subjectivity.toFixed(1)},${dims.actuality.toFixed(1)}] links=${createdLinks.length}`);

  const opId = logOperation(db, {
    operation: 'digest',
    input_summary: input.content.slice(0, 100),
    context: input.context,
    output_node_ids: createdNodes.map(n => n.id),
    tool: input.source?.tool,
    session: input.source?.session,
    agent_id: input.agent_id,
  });

  logStrategyFeedback(db, {
    strategy_name: 'digest-extract',
    operation_id: opId,
    node_id: createdNodes[0]?.id,
    was_used: true,
    feedback_signal: 0.5,
  });

  return { nodes: createdNodes, links: createdLinks };
}

/**
 * 启发式内容质量评估（无 LLM 时的兜底）
 *
 * 返回建议的初始热度（0.3-1.0）：
 * - 低质量内容降权，在搜索中排名靠后，更快被自然衰减淘汰
 * - 如果后来被访问，热度会回升——自我修正机制
 * - LLM 路径中 LLM 自己评估的 heat 会覆盖这个值
 */
function assessContentQuality(content: string): number {
  // 纯 URL / 文件路径（无附加说明）
  if (/^(https?:\/\/\S+|[\/~][\w\/.%-]+)$/s.test(content)) return 0.3;

  // 内容长度评估（中英文分别计算）
  const hasChineseChars = /[\u4e00-\u9fff]/.test(content);
  const effectiveLength = hasChineseChars
    ? content.replace(/\s/g, '').length
    : content.split(/\s+/).length;

  if (effectiveLength < 10) return 0.3;
  if (effectiveLength < 20) return 0.5;

  return 1.0;
}

/**
 * 异步生成 embedding + 存储 + 着陆连接
 */
async function generateAndStoreEmbedding(
  db: Database.Database,
  nodeId: string,
  content: string,
): Promise<Array<{ from_id: string; to_id: string; relation: string }>> {
  // 多段 embedding：长内容自动拆分为多个 segment
  const inserted = await insertSegmentVectors(db, nodeId, content);
  if (inserted === 0) {
    log.debug(`embedding 插入失败 node=${nodeId}`);
    return [];
  }

  // 用第一个 segment 的 embedding 做着陆连接
  const embedding = getVectorForNode(db, nodeId);
  if (!embedding) return [];

  const landing = findLandingConnections(db, nodeId, embedding);
  log.debug(`着陆结果 node=${nodeId} action=${landing.action} confirmed=${landing.confirmedLinks.length} pending=${landing.pendingLinks.length}`);
  if (landing.action === 'merge' && landing.mergeTarget) {
    log.info(`去重合并 node=${nodeId} → target=${landing.mergeTarget}`);
    // 读取刚创建的源节点的 tags，合并到目标节点
    const sourceNode = getNode(db, nodeId);
    const srcTags = parseTags(sourceNode?.tags ?? null);
    await reconsolidateNode(db, landing.mergeTarget, content, '去重合并', {
      newTags: srcTags.length > 0 ? srcTags : undefined,
    });
    archiveNode(db, nodeId);
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'dedup_merge',
      title: JSON.stringify({ key: 'dedup_merged' }),
      detail: { source_id: nodeId, target_id: landing.mergeTarget },
      node_ids: [landing.mergeTarget, nodeId],
    });
    return [];
  }

  if (landing.confirmedLinks.length > 0 || landing.pendingLinks.length > 0) {
    logTimelineEvent(db, {
      type: 'memory',
      subtype: 'landing_connection',
      title: JSON.stringify({ key: 'landing_connections', params: { count: landing.confirmedLinks.length + landing.pendingLinks.length } }),
      detail: {
        node_id: nodeId,
        confirmed_count: landing.confirmedLinks.length,
        pending_count: landing.pendingLinks.length,
      },
      node_ids: [nodeId, ...landing.confirmedLinks.map(l => l.to_id), ...landing.pendingLinks.map(l => l.to_id)],
    });
  }

  const links: Array<{ from_id: string; to_id: string; relation: string }> = [];
  for (const link of [...landing.confirmedLinks, ...landing.pendingLinks]) {
    const primaryType = Array.isArray(link.relation) && link.relation.length > 0 ? link.relation[0].type : 'analogous';
    links.push({ from_id: link.from_id, to_id: link.to_id, relation: primaryType });
  }
  return links;
}

/**
 * Digest 重试入口 — 供代谢任务 digest-retry 调用
 *
 * 重新执行 processDigestContent，使用原始 input 和 traceId。
 */
export async function processDigestRetry(
  db: Database.Database,
  input: DigestInput,
  traceId: string,
): Promise<void> {
  const qualityHeat = assessContentQuality(input.content.trim());
  // retry 不重复写 stream，复用原始 traceId 作为引用
  await processDigestContent(db, input, `retry:${traceId}`, traceId, qualityHeat);
  log.info(`Digest retry succeeded: trace=${traceId}`);
}
