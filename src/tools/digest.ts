import type { DigestInput, DigestOutput, NodeType, BrainNode } from '../types.js';
import type { IRepository } from '../db/repository.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inferDimensions } from '../utils/dimensions.js';
import { parseTags } from '../db/nodes.js';
import { appendToStream } from '../stream/writer.js';
import { generateId } from '../utils/id.js';
import { now } from '../utils/time.js';

import { isVecLoaded } from '../db/connection.js';
import { findLandingConnections } from '../graph/landing.js';
import { reconsolidateNode } from '../graph/dedup.js';
import {
  enqueuePendingDigest,
  // 修复 M25(2026-05-09):detached 异步分支历史用 dynamic import 拉这两个函数,
  // 模块解析失败(磁盘错误/损坏)时只 log 不重试 → 表里的 pending digest
  // 永远不被 fail/complete,worker 反复重抓同一条永远拒绝的输入。改成
  // 顶层 static import,启动时一次性解析,运行期 detached 分支只调函数。
  completePendingDigest,
  failPendingDigest,
} from '../db/pending-digests.js';
import { createLogger } from '../utils/logger.js';
import { tryElicit } from './elicit-helper.js';

const log = createLogger('digest');

/**
 * Digest 调用上下文。MCP 工具 handler 在调用 digest 时传入 server，
 * digest 内部可在归类模糊的决策点通过 MCP elicitation 向用户追问。
 * 非 MCP 上下文（测试、其他工具链）不传该字段即可；elicit 助手会自动 fallback。
 */
export interface DigestContext {
  server?: McpServer;
}

/**
 * brain_digest — 消化信息
 *
 * 基础版：content 直接存为单个节点（后续 Step 7 加 LLM 提取）
 *
 * 归类模糊的决策点（当 config.digest.interactive_mode === "ask" 且 client
 * 支持 elicitation 时）会通过 context.server 发起 MCP elicit 请求让用户选择。
 * 默认 silent 模式下 elicit 助手直接返回 null，走原有 fallback 行为。
 */
export async function digest(repo: IRepository, input: DigestInput, context?: DigestContext): Promise<DigestOutput> {
  const traceId = generateId();
  log.info(`intent=${input.intent ?? 'new'} contentLen=${input.content.length} async=${input.async !== false} trace=${traceId}`);

  // Legacy db handle for modules not yet refactored
  // 通过 repo.rawDb 取得和 repo 共享的连接，避免绕过测试中的 mock repo（之前
  // 直接调 getDb() 会在测试里打开另一个真实 DB，让 mock 完全失效）。
  const db = repo.rawDb;

  // --- 纠正已有节点 ---
  if (input.intent === 'correction' && input.target_node) {
    const existing = repo.nodes.getNode(input.target_node);

    // A 场景：target_node 不存在。ask 模式下让用户挑正确的目标；silent 模式走硬拒 fallback
    if (!existing) {
      const resolved = await resolveMissingCorrectionTarget(repo, input, context?.server);
      if (resolved.kind === 'skip') {
        return { status: 'rejected', trace_id: traceId, reject_reason: '用户取消本次纠正' };
      }
      if (resolved.kind === 'new') {
        // 用户选"当作新记忆保存"：改写 intent 为 new，fall-through 到下面常规消化路径
        input = { ...input, intent: 'new', target_node: undefined };
      } else if (resolved.kind === 'retarget') {
        // 改写 target_node，下面 correction 分支会用新 ID 重新 getNode 拿到 existing
        input = { ...input, target_node: resolved.targetId };
      } else {
        // fallback 硬拒（silent 模式、capability 不支持、用户 decline/cancel、无候选节点）
        log.warn(`correction 目标节点不存在: ${input.target_node}`);
        return { status: 'rejected', trace_id: traceId, reject_reason: `目标节点 ${input.target_node} 不存在` };
      }
    }
  }

  // 只有仍然是 correction 且 existing 有效时走下面的 correction 处理
  if (input.intent === 'correction' && input.target_node) {
    const existing = repo.nodes.getNode(input.target_node);
    if (!existing) {
      // 并发场景：在上面 resolve 流程与这里之间，另一个进程可能 archive 掉该节点。
      // 之前用 `!` 非空断言会在 existing 为 null 时访问 .content 抛 TypeError。
      log.warn(`correction 目标节点在处理中消失: ${input.target_node}`);
      return { status: 'rejected', trace_id: traceId, reject_reason: `目标节点 ${input.target_node} 已不存在（可能被并发归档）` };
    }
    repo.nodes.updateNode(input.target_node, { content: input.content }, 'correction');
    log.info(`correction target=${input.target_node}`);
    const updated = repo.nodes.getNode(input.target_node);
    if (!updated) {
      // updateNode 之后 getNode 再次返回 null：目标节点在并发窗口里被硬删。
      // 避免非空断言崩溃，返回 rejected 让调用方看到可解释的错误。
      log.warn(`correction 更新后目标节点消失: ${input.target_node}`);
      return { status: 'rejected', trace_id: traceId, reject_reason: `目标节点 ${input.target_node} 在纠正过程中消失` };
    }

    // Stream 先写（获取锚点引用）
    const corrStreamRef = appendToStream({
      tool: input.source?.tool,
      session: input.source?.session,
      content: `[纠正] ${input.content}`,
    });

    // 纠正记录：完整保留修改前后内容
    const correctionNode = repo.nodes.createNode({
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

    repo.log.logOperation({
      operation: 'digest',
      input_summary: `correction: ${input.target_node}`,
      context: input.context,
      output_node_ids: [input.target_node, correctionNode.id],
      tool: input.source?.tool,
      session: input.source?.session,
      agent_id: input.agent_id,
    });

    // Learning II 实时信号：correction = 标注质量负反馈
    repo.log.logParamFeedback({
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
    // 使用 .all 而非 .get：同一对节点之间可能存在多条链接（不同 relation 或重复），
    // 原先 .get 只删一条会留下残余链接，导致反复 unlink 依然有历史关系。
    const links = db.prepare(
      'SELECT id FROM links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    ).all(input.target_link.from, input.target_link.to, input.target_link.to, input.target_link.from) as Array<{ id: string }>;

    for (const link of links) {
      repo.links.deleteLink(link.id);
    }
    log.debug(`unlink removed ${links.length} link(s) between ${input.target_link.from} and ${input.target_link.to}`);

    repo.log.logOperation({
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
    repo.nodes.archiveNode(input.target_node);

    repo.log.logOperation({
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
    // 先写入 pending_digests 条目（同步），确保即使进程崩溃也能重试
    try {
      enqueuePendingDigest(db, traceId, JSON.stringify(input), 'pre-processing');
    } catch (enqueueErr) {
      log.error('Failed to pre-enqueue digest:', (enqueueErr as Error).message);
    }
    // 这段 detached 异步块历史上漏过异常：外层 Promise.resolve().then(...) 如果在
     // 进入内部 try 之前同步抛错（例如顶层 `await import(...)` 模块解析失败），会
     // 变成 unhandledRejection 静默丢失。末尾 .catch 兜底确保至少 log 出来。
     // 另外清理 pending 条目的 try/catch 之前是 `catch {}` 吞一切，换成 warn log
     // 让 DB 故障（比如磁盘满、锁冲突）可观测。
    Promise.resolve().then(async () => {
      try {
        await processDigestContent(repo, input, streamRef, traceId, qualityHeat);
        // 处理成功，删除 pending 条目(M25:不再 dynamic import,直接用顶部 static import)
        try {
          const pending = db.prepare(
            "SELECT id FROM pending_digests WHERE trace_id = ? AND status = 'pending'"
          ).get(traceId) as { id: string } | undefined;
          if (pending) {
            completePendingDigest(db, pending.id);
          }
        } catch (cleanupErr) {
          log.warn(`digest-cleanup-failed trace=${traceId}: ${(cleanupErr as Error).message}`);
        }
      } catch (err) {
        log.error('异步 digest 处理失败:', (err as Error).message);
        repo.log.logOperation({
          operation: 'digest',
          input_summary: `[FAILED] ${input.content.slice(0, 80)}`,
          context: `Error: ${(err as Error).message}`,
          tool: input.source?.tool,
          session: input.source?.session,
          agent_id: input.agent_id,
        });
        // pending 条目已存在，更新错误信息以供重试(M25:static import)
        try {
          const pending = db.prepare(
            "SELECT id FROM pending_digests WHERE trace_id = ?"
          ).get(traceId) as { id: string } | undefined;
          if (pending) {
            failPendingDigest(db, pending.id, (err as Error).message);
          }
        } catch (updateErr) {
          log.error('Failed to update pending digest status:', (updateErr as Error).message);
        }
      }
    }).catch(err => log.error(`digest-detached-failed trace=${traceId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
    return { status: 'accepted', trace_id: traceId };
  }

  // 同步模式（async === false）：完整处理后返回
  const result = await processDigestContent(repo, input, streamRef, traceId, qualityHeat);

  return {
    status: 'processed',
    trace_id: traceId,
    created_nodes: result.nodes,
    created_links: result.links.length > 0 ? result.links : undefined,
  };
}

/**
 * 解析 correction 请求里 target_node 不存在的情况：通过 MCP elicit 让用户
 * 选择（纠正另一条已有记忆 / 当作新记忆 / 跳过）。
 *
 * 返回值：
 *   - 'retarget'：用户选了某条候选，改用该 ID 继续走 correction 逻辑
 *   - 'new'：用户选了"当作新记忆"，调用方应把 intent 改为 new 走常规消化
 *   - 'skip'：用户明确取消
 *   - 'fallback'：elicit 未发起（silent 模式 / 不支持 / 节流 / 无候选）或用户 decline；
 *     调用方应按既有硬拒路径返回 rejected
 */
type ResolveResult =
  | { kind: 'skip' }
  | { kind: 'new' }
  | { kind: 'retarget'; targetId: string; existing: BrainNode }
  | { kind: 'fallback' };

async function resolveMissingCorrectionTarget(
  repo: IRepository,
  input: DigestInput,
  server: McpServer | undefined,
): Promise<ResolveResult> {
  // 按热度取 top 5 活跃节点作为候选。热度兼顾"最近被访问/被引用"，比纯 created DESC
  // 更能命中用户想纠正的对象。
  const candidates = repo.nodes.listNodes({ archived: false, orderBy: 'heat DESC', limit: 5 });
  if (candidates.length === 0) return { kind: 'fallback' };

  const candidateOptions = candidates.map(c => ({
    const: c.id,
    title: `纠正：${c.title ?? c.content.slice(0, 40)}`,
  }));

  const result = await tryElicit(server, `correction-missing:${input.target_node}`, {
    mode: 'form' as const,
    message: `未找到 ID "${input.target_node}" 对应的记忆。请选择如何处理：`,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          title: '处理方式',
          oneOf: [
            { const: '__skip__', title: '跳过本次纠正' },
            { const: '__new__', title: '当作新记忆保存' },
            ...candidateOptions,
          ],
        },
      },
      required: ['action'],
    },
  });

  if (!result || result.action !== 'accept') return { kind: 'fallback' };
  const action = result.content?.action;
  if (typeof action !== 'string') return { kind: 'fallback' };
  if (action === '__skip__') return { kind: 'skip' };
  if (action === '__new__') return { kind: 'new' };

  const existing = repo.nodes.getNode(action);
  if (!existing) return { kind: 'fallback' };
  return { kind: 'retarget', targetId: action, existing };
}

/**
 * 消化内容的核心处理逻辑（纯机械路径，不调 LLM）
 *
 * 不调用 LLM。存原文 + 继承标签/type + embedding + 着陆连接。
 * LLM 标注（维度评分、补充标签）由节点标注任务近实时处理完成。
 */
async function processDigestContent(
  repo: IRepository,
  input: DigestInput,
  streamRef: string,
  traceId: string,
  qualityHeat: number = 1.0,
): Promise<{
  nodes: Array<{ id: string; content: string; type: NodeType }>;
  links: Array<{ from_id: string; to_id: string; relation: string }>;
}> {
  const dims = inferDimensions(input.content);
  const node = repo.nodes.createNode({
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
    // skipDedupMerge: 调用方持有自己的身份/去重机制（logseq/obsidian/notion
    // /apple-notes 的 file+segment，property-promote 的精确匹配）。
    // 只建 landing 链接，不做向量归并——避免不同段落因相似度被误并。
    const links = await generateAndStoreEmbedding(
      repo, node.id, embeddingText, input.skipDedupMerge === true,
    );
    createdLinks.push(...links);
  }

  log.info(`创建节点 id=${node.id} type=${node.type} dims=[${dims.specificity.toFixed(1)},${dims.subjectivity.toFixed(1)},${dims.actuality.toFixed(1)}] links=${createdLinks.length}`);

  const opId = repo.log.logOperation({
    operation: 'digest',
    input_summary: input.content.slice(0, 100),
    context: input.context,
    output_node_ids: createdNodes.map(n => n.id),
    tool: input.source?.tool,
    session: input.source?.session,
    agent_id: input.agent_id,
  });

  repo.log.logStrategyFeedback({
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
  if (/^(https?:\/\/\S+|[/~][\w/.%-]+)$/s.test(content)) return 0.3;

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
 *
 * @param skipDedupMerge 调用方持有外部身份（logseq/obsidian 等），跳过向量归并。
 *   landing 的链接分支（confirmed/pending）仍会正常执行。
 */
async function generateAndStoreEmbedding(
  repo: IRepository,
  nodeId: string,
  content: string,
  skipDedupMerge: boolean = false,
): Promise<Array<{ from_id: string; to_id: string; relation: string }>> {
  // Legacy db handle for modules not yet refactored
  // 用 repo.rawDb 保持和上层一致，避免绕过测试 mock。
  const db = repo.rawDb;

  // 多段 embedding：长内容自动拆分为多个 segment
  const inserted = await repo.vectors.insertSegmentVectors(nodeId, content);
  if (inserted === 0) {
    log.debug(`embedding 插入失败 node=${nodeId}`);
    return [];
  }

  // 用第一个 segment 的 embedding 做着陆连接
  const embedding = repo.vectors.getVectorForNode(nodeId);
  if (!embedding) return [];

  const landing = findLandingConnections(db, nodeId, embedding, { skipDedupMerge });
  log.debug(`着陆结果 node=${nodeId} action=${landing.action} confirmed=${landing.confirmedLinks.length} pending=${landing.pendingLinks.length}`);
  if (landing.action === 'merge' && landing.mergeTarget) {
    log.info(`去重合并 node=${nodeId} → target=${landing.mergeTarget}`);
    // 读取刚创建的源节点的 tags，合并到目标节点
    const sourceNode = repo.nodes.getNode(nodeId);
    const srcTags = parseTags(sourceNode?.tags ?? null);
    await reconsolidateNode(db, landing.mergeTarget, content, '去重合并', {
      newTags: srcTags.length > 0 ? srcTags : undefined,
    });
    repo.nodes.archiveNode(nodeId);
    // 清理被归档节点的向量数据和分段数据,避免残留占用空间和干扰搜索。
    //
    // 必须走 repo.vectors.deleteVector() 而非直接 `DELETE FROM nodes_vec
    // WHERE id = ?` — nodes_vec.id 存的是 `${nodeId}#${segmentIndex}`,
    // 用裸 nodeId 永远删不到,归档节点的 embedding 会残留,搜索中再次出现
    // "归档幽灵"。repo.vectors.deleteVector 内部通过 node_segments 找到所有
    // segmentId 再精确删除。
    try {
      repo.vectors.deleteVector(nodeId);
    } catch { /* nodes_vec 可能未加载 */ }
    repo.log.logTimelineEvent({
      type: 'memory',
      subtype: 'dedup_merge',
      title: JSON.stringify({ key: 'dedup_merged' }),
      detail: { source_id: nodeId, target_id: landing.mergeTarget },
      node_ids: [landing.mergeTarget, nodeId],
    });
    return [];
  }

  if (landing.confirmedLinks.length > 0 || landing.pendingLinks.length > 0) {
    repo.log.logTimelineEvent({
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
  repo: IRepository,
  input: DigestInput,
  traceId: string,
): Promise<void> {
  const qualityHeat = assessContentQuality(input.content.trim());
  // retry 不重复写 stream，复用原始 traceId 作为引用
  await processDigestContent(repo, input, `retry:${traceId}`, traceId, qualityHeat);
  log.info(`Digest retry succeeded: trace=${traceId}`);
}
