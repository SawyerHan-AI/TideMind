import type { RecallInput, RecallOutput, RecallNode, RecallNodeLink, RecallIndexItem, BrainNode } from '../types.js';
import type { IRepository } from '../db/repository.js';
import { getParam } from '../strategy/loader.js';
import { parseTags } from '../db/nodes.js';
import { searchHybrid } from '../search/hybrid.js';
import { reconsolidateOnRecall } from '../metabolism/reconsolidate.js';
import { revalidateLinks } from '../metabolism/link-revalidate.js';
import { expandFromNode } from '../graph/expansion.js';
import { getGateStatus } from '../db/stats.js';
import { getEmbedding } from '../llm/embedding.js';
import { l2DistanceToSimilarity } from '../utils/similarity.js';
import { computeFreshness } from '../utils/freshness.js';
import { createLogger } from '../utils/logger.js';
import { pickDisplayTitle } from '../utils/display-title.js';
import { getDb } from '../db/connection.js';

const log = createLogger('recall');

/**
 * brain_recall — 按需获取信息
 *
 * 基础版：BM25 搜索 + 直接 ID 查询
 * Step 6 后加入混合搜索，Step 11 后加入读即写再巩固
 */
export async function recall(repo: IRepository, input: RecallInput): Promise<RecallOutput> {
  const startTime = Date.now();
  const recallModeHint = input.mode ?? 'detail';
  const defaultLimit = recallModeHint === 'index'
    ? getParam('recall-search', 'index_max_results', 30)
    : getParam('recall-search', 'detail_max_results', 8);
  const limit = input.limit ?? defaultLimit;
  let nodes: BrainNode[] = [];
  let usedHybridSearch = false;
  let searchScores: Map<string, number> | undefined;

  const mode = input.node_id ? 'node_id' : input.source_file ? 'source_file' : input.index_ref ? 'index_ref' : input.from_node ? 'from_node' : input.query ? 'query' : 'browse';
  log.info(`mode=${mode}${input.query ? ` query="${input.query.slice(0, 60)}"` : ''}${input.node_id ? ` id=${input.node_id}` : ''} limit=${limit}`);

  // 是否需要排除 meta 节点（用户显式查 meta 时不排除）
  const excludeMeta = input.type !== 'meta';

  // Legacy db handle for modules not yet refactored
  const db = getDb();

  // --- 按 ID 直接获取 ---
  if (input.node_id) {
    const node = repo.nodes.getNode(input.node_id);
    if (node && node.heat > 0.01) {
      nodes = [node];
    }
  }
  // --- 按来源文件查询 ---
  else if (input.source_file) {
    const escapedFile = input.source_file.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const conditions = ["source_stream LIKE ? ESCAPE '\\'", "heat > 0.01", "is_superseded = 0"];
    const params: unknown[] = [`%${escapedFile}%`];
    if (excludeMeta) { conditions.push("is_meta = 0"); }
    if (input.created_after) { conditions.push("created >= ?"); params.push(input.created_after); }
    if (input.created_before) { conditions.push("created <= ?"); params.push(input.created_before); }
    nodes = db.prepare(
      `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY created DESC LIMIT ?`,
    ).all(...params, limit) as BrainNode[];
  }
  // --- 按索引条目获取 ---
  else if (input.index_ref) {
    // index_ref format: "tag:xxx" or "node:xxx" (legacy "project:xxx" treated as tag)
    const colonIdx = input.index_ref.indexOf(':');
    const refType = colonIdx >= 0 ? input.index_ref.slice(0, colonIdx) : '';
    const refValue = colonIdx >= 0 ? input.index_ref.slice(colonIdx + 1) : '';
    if (!refValue) {
      // 无效的 index_ref 格式，返回空结果
    } else if (refType === 'tag' || refType === 'project') {
      // 基于标签过滤：查找 tags JSON 数组中包含该标签的节点
      const escapedRef = refValue.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const conditions = [`tags LIKE ? ESCAPE '\\'`, `heat > 0.01`, `is_superseded = 0`];
      const params: unknown[] = [`%"${escapedRef}"%`];
      if (excludeMeta) conditions.push('is_meta = 0');
      if (input.created_after) { conditions.push('created >= ?'); params.push(input.created_after); }
      if (input.created_before) { conditions.push('created <= ?'); params.push(input.created_before); }
      nodes = db.prepare(
        `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY heat DESC LIMIT ?`,
      ).all(...params, limit) as BrainNode[];
    } else if (refType === 'node') {
      const node = repo.nodes.getNode(refValue)
      if (node && node.heat > 0.01) nodes = [node]
    }
  }
  // --- 图遍历（支持 query 组合 rerank） ---
  else if (input.from_node) {
    nodes = expandFromNode(db, input.from_node, {
      depth: input.depth ?? 1,
      maxNodes: limit,
      minStrength: 0.3,
      intent: input.intent,
    });
    // 按关系类型过滤
    if (input.relation) {
      const startLinks = repo.links.getLinksForNode(input.from_node);
      const validTargets = new Set(
        startLinks
          .filter(l => Array.isArray(l.relation) && l.relation.some(r => r.type === input.relation))
          .map(l => l.from_id === input.from_node ? l.to_id : l.from_id)
      );
      nodes = nodes.filter(n => validTargets.has(n.id));
    }
    // P2-1: 如果同时有 query，用向量相似度 rerank
    if (input.query && nodes.length > 1) {
      log.debug(`rerank ${nodes.length} nodes by query`);
      nodes = await rerankByQuery(repo, nodes, input.query);
    }
    if (excludeMeta) nodes = nodes.filter(n => !n.is_meta);
  }
  // --- 语义搜索（混合：BM25 + 向量） ---
  else if (input.query) {
    usedHybridSearch = true;
    const results = await searchHybrid(repo, input.query, {
      limit,
      type: input.type,
      intent: input.intent,
      context: input.context,
      createdAfter: input.created_after,
      createdBefore: input.created_before,
      excludeMeta,
    });
    nodes = results.map(r => r.node);
    searchScores = new Map(results.map(r => [r.node.id, r.score]));

    // scope 基于标签过滤（支持 "project:xxx" 和 "tag:xxx" 前缀）
    if (input.scope) {
      const scopeTag = input.scope.replace(/^(project|tag):/, '');
      nodes = nodes.filter(n => {
        const tags = parseTags(n.tags);
        return tags.some(t => t === scopeTag);
      });
    }
  }
  // --- 默认:返回最近的活跃节点 ---
  else {
    // archived: false 必须显式传 — listNodes 默认不过滤 archived/is_superseded,
    // 浏览路径会混入已归档、已被取代的脏节点(用户反复看到"删除后又出现
    // 的幽灵节点"一种来源)。listNodes 在 archived===false 时同时过滤
    // is_superseded=0,所以一个 flag 解决两种脏状态。
    nodes = repo.nodes.listNodes({
      limit,
      orderBy: 'heat DESC',
      archived: false,
      createdAfter: input.created_after,
      createdBefore: input.created_before,
    });
    if (excludeMeta) nodes = nodes.filter(n => !n.is_meta);
  }

  // 图扩展（如果门控允许、有搜索结果、且首个结果质量足够高）
  // 跳过混合搜索路径：hybrid search 内部已做邻居扩展（见 hybrid.ts 91-128 行）
  const gates = getGateStatus(db);
  const topNodeQuality = nodes.length > 0 ? nodes[0].maturity_score : 0;
  if (!usedHybridSearch && gates.features.graph_expansion && nodes.length > 0 && nodes.length < limit && topNodeQuality > 0.1) {
    const preExpandCount = nodes.length;
    const expanded = expandFromNode(db, nodes[0].id, {
      depth: input.depth ?? 1,
      maxNodes: limit - nodes.length,
      intent: input.intent,
    });
    const existingIds = new Set(nodes.map(n => n.id));
    for (const expNode of expanded) {
      if (!existingIds.has(expNode.id) && !(excludeMeta && expNode.is_meta)) {
        nodes.push(expNode);
      }
    }
    if (nodes.length > preExpandCount) {
      log.debug(`图扩展: +${nodes.length - preExpandCount} nodes`);
    }
  }

  // 读即写：给命中节点加热（按排名衰减）
  // 精确查找路径（node_id、index_ref 单节点）维持固定 +0.1
  const isRankedResult = usedHybridSearch || (input.from_node != null) || (input.source_file != null) || (!input.node_id && !input.index_ref);
  let awakenedCount = 0;
  repo.transaction(() => {
    for (let i = 0; i < nodes.length; i++) {
      // Learning II 实时信号：接近休眠的节点被唤醒 → 衰减可能太快
      if (nodes[i].heat < 0.1) {
        awakenedCount++;
      }
      const delta = isRankedResult && nodes.length > 1
        ? Math.max(0.01, 0.1 * (1 - i / nodes.length))
        : 0.1;
      repo.nodes.bumpHeat(nodes[i].id, delta);
    }
  });
  if (awakenedCount > 0) {
    repo.log.logParamFeedback({
      strategy_name: 'metabolism-params',
      signal_type: 'node_awakening',
      signal_value: -1.0 * (awakenedCount / nodes.length), // 唤醒比例越高 → 衰减可能太快
      context: JSON.stringify({ awakened: awakenedCount, total: nodes.length }),
    });
  }

  // 再巩固(感知读 + 深度读判定)
  // 传入搜索分数用于感知读质量门槛
  const avgScore = searchScores && searchScores.size > 0
    ? [...searchScores.values()].reduce((a, b) => a + b, 0) / searchScores.size
    : undefined;
  // 套 try/catch:reconsolidate v0.2.15 起同步异常会 re-throw,如果让它冒到
  // recall 调用方会让整个 MCP tool call 返回错误。再巩固是尽力而为的增强
  // 逻辑,失败不应影响 recall 的主要返回。log 出来便于排查。
  try {
    reconsolidateOnRecall(db, nodes, input.context, avgScore);
  } catch (err) {
    log.error(`reconsolidateOnRecall failed (recall continues): ${(err as Error).message}`);
  }

  // 轻量发散：找一个与结果集语义相关但不在结果中的节点
  let surprises: RecallOutput['surprises'] = undefined
  if (input.include_surprise && nodes.length >= 2) {
    // Find nodes that share neighbors with result nodes but aren't in results
    const resultIds = new Set(nodes.map(n => n.id))
    const candidateIds = new Set<string>()
    for (const node of nodes.slice(0, 3)) {
      const links = repo.links.getLinksForNode(node.id)
      for (const link of links) {
        const targetId = link.from_id === node.id ? link.to_id : link.from_id
        if (!resultIds.has(targetId)) candidateIds.add(targetId)
      }
    }
    // Pick the hottest non-result neighbor as a "surprise"
    if (candidateIds.size > 0) {
      const candidateMap = repo.nodes.getNodesByIds([...candidateIds].slice(0, 5));
      const candidates = [...candidateMap.values()].filter(n => n.heat > 0.01);
      candidates.sort((a, b) => b.heat - a.heat)
      if (candidates.length > 0) {
        surprises = [{
          insight: `与搜索结果相关但不在结果中的记忆`,
          node_a_id: nodes[0].id,
          node_b_id: candidates[0].id,
          confidence: 0.5,
        }]
      }
    }
  }

  // 构建返回结果（区分 index / detail 模式）
  const recallMode = input.mode ?? 'detail';
  const maxLinksPerNode = getParam('recall-search', 'detail_max_links_per_node', 5);
  const snippetLength = getParam('recall-search', 'index_snippet_length', 80);

  let resultNodes: RecallNode[] | RecallIndexItem[];

  if (recallMode === 'index') {
    // 索引模式：轻量返回,只给标题+ID+snippet
    resultNodes = nodes.map(node => {
      const parsedTags = parseTags(node.tags);
      return {
        id: node.id,
        type: node.type,
        title: pickDisplayTitle(node.title, node.content),
        snippet: node.content.slice(0, snippetLength).replace(/\n/g, ' ').trim(),
        tags: parsedTags,
        heat: node.heat,
        created: node.created,
      } satisfies RecallIndexItem;
    });
  } else {
    // 详情模式：完整内容 + 链接（不含 content_preview）
    resultNodes = nodes.map(node => {
      const links = repo.links.getLinksForNode(node.id);
      const recallLinks: RecallNodeLink[] = [];
      for (const link of links.slice(0, maxLinksPerNode)) {
        const targetId = link.from_id === node.id ? link.to_id : link.from_id;
        const target = repo.nodes.getNode(targetId);
        if (!target) continue; // 跳过指向已删除节点的悬空链接
        recallLinks.push({
          to_id: targetId,
          to_title: pickDisplayTitle(target.title, target.content),
          to_type: target.type,
          relation: link.relation,
          strength: link.strength,
          note: link.note ?? undefined,
        });
      }

      const parsedTags = parseTags(node.tags);
      const tags = parsedTags.length > 0 ? parsedTags : undefined;

      const freshness = computeFreshness(node, recallLinks);

      return {
        id: node.id,
        type: node.type,
        title: pickDisplayTitle(node.title, node.content),
        content: node.content,
        maturity: {
          heat: node.heat,
          refinement: node.refinement,
          connectivity: node.connectivity,
          independence: node.independence,
        },
        links: recallLinks,
        source_ref: node.source_stream ?? undefined,
        tags,
        freshness,
      } satisfies RecallNode;
    });
  }

  // 记录操作
  const opId = repo.log.logOperation({
    operation: 'recall',
    input_summary: input.query ?? input.node_id ?? input.from_node ?? 'browse',
    context: input.context,
    output_node_ids: nodes.map(n => n.id),
    tool: input.source_tool,
    agent_id: input.agent_id,
  });

  // 策略反馈记录
  repo.log.logStrategyFeedback({
    strategy_name: 'recall-search',
    operation_id: opId,
    was_used: nodes.length > 0,
    feedback_signal: nodes.length > 0
      ? Math.min(nodes.length / limit, 1.0) * 0.5
      : -0.3,
  });

  // 生成模板摘要（detail 模式才有意义）
  const summary = recallMode === 'detail'
    ? generateRecallSummary(resultNodes as RecallNode[])
    : `找到 ${resultNodes.length} 条相关记忆`;

  log.info(`返回 ${resultNodes.length} 条结果 mode=${recallMode} 耗时=${Date.now() - startTime}ms`);

  // fire-and-forget: 链接重新验证
  if (resultNodes.length > 0 && input.query) {
    revalidateLinks(db, nodes.map(n => n.id), {
      query: input.query,
      recalledNodeIds: nodes.map(n => n.id),
    }).catch(err => log.warn(`链接重新验证异步失败: ${err instanceof Error ? err.stack : String(err)}`));
  }

  return { nodes: resultNodes, mode: recallMode, summary, surprises };
}

/**
 * 模板生成 recall 摘要（不依赖 LLM，避免阻塞）
 */
function generateRecallSummary(nodes: RecallNode[]): string {
  if (nodes.length === 0) return '未找到相关记忆';

  // 统计节点类型
  const typeCounts = new Map<string, number>();
  for (const node of nodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  }
  const typeDesc = [...typeCounts.entries()]
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');

  // 提取唯一标签
  const allTags = [...new Set(nodes.flatMap(n => n.tags ?? []))];
  const tagDesc = allTags.length > 0 ? `，涉及标签 ${allTags.slice(0, 5).join('、')}` : '';

  // 取前 3 个节点的标题或内容作为主题提示
  const topicHints = nodes.slice(0, 3)
    .map(n => n.title ?? n.content.slice(0, 20).replace(/\n/g, ' ').trim())
    .filter(Boolean);
  const topicDesc = topicHints.length > 0 ? `，主题包括 ${topicHints.join('、')}` : '';

  return `找到 ${nodes.length} 条相关记忆（${typeDesc}）${tagDesc}${topicDesc}`;
}

/**
 * 用 query 的向量相似度对候选节点 rerank
 * 用于 from_node + query 组合路径
 */
async function rerankByQuery(repo: IRepository, nodes: BrainNode[], query: string): Promise<BrainNode[]> {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return nodes; // embedding 不可用，保持原序

  const scored: Array<{ node: BrainNode; similarity: number }> = [];
  for (const node of nodes) {
    const nodeEmbedding = repo.vectors.getVectorForNode(node.id);
    if (!nodeEmbedding) {
      // 没有 embedding 的节点放到末尾，给一个低分
      scored.push({ node, similarity: -1 });
      continue;
    }
    // 计算 L2 距离然后转余弦相似度
    if (queryEmbedding.length !== nodeEmbedding.length) {
      scored.push({ node, similarity: -1 });
      continue;
    }
    let sumSq = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      const diff = queryEmbedding[i] - nodeEmbedding[i];
      sumSq += diff * diff;
    }
    scored.push({ node, similarity: l2DistanceToSimilarity(Math.sqrt(sumSq)) });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.map(s => s.node);
}
