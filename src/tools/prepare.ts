import type {
  PrepareInput, PrepareOutput, PrepareProfile,
  PrepareKeystone, PrepareTag, PrepareCrystalHighlighted,
  PrepareCrystalOther, PrepareRecent,
} from '../types.js';
import type { IRepository } from '../db/repository.js';
import { getGateStatus } from '../db/stats.js';
import { getParam } from '../strategy/loader.js';
import { maybeRunMaintenance } from '../metabolism/scheduler.js';
import { ALL_TASKS } from '../metabolism/tasks.js';
import { getFailedDigests, getPendingDigestCount } from '../db/pending-digests.js';
import { createLogger } from '../utils/logger.js';
import { pickDisplayTitle } from '../utils/display-title.js';
import { sanitizeProfileContent } from '../evolution/profile-parse.js';

const log = createLogger('prepare');

/**
 * brain_prepare — 主动准备认知包
 *
 * 返回：用户画像 + 枢纽节点 + 标签索引 + 结晶 + 最近活跃 + 行为指导
 */
export async function prepare(repo: IRepository, input: PrepareInput): Promise<PrepareOutput> {
  log.info(`tool=${input.tool} detail=${input.detail_level ?? 'standard'}`);

  const db = repo.rawDb; // 过渡期：未迁移的外部函数仍需 raw db
  const gates = getGateStatus(db);

  // --- 用户画像（读取预生成的 meta 节点）---
  const profile = buildProfile(repo);

  // --- 枢纽节点 ---
  const keystones = buildKeystones(repo);

  // --- 标签索引 ---
  const tags = buildTags(repo);

  // --- 结晶 ---
  const crystals = buildCrystals(repo);

  // --- 最近活跃 ---
  const recent = buildRecent(repo);

  // --- 行为指导 ---
  let guidance = buildGuidance(gates);

  // --- Digest 重试状态 ---
  const digestStatus = getPendingDigestCount(db);
  if (digestStatus.failed > 0) {
    const failed = getFailedDigests(db);
    const failedInfo = failed.map(f => `- trace=${f.trace_id}: ${f.error_message} (${f.created})`).join('\n');
    guidance += `\n\n⚠️ ${digestStatus.failed} 条 digest 处理失败（已重试 3 次）:\n${failedInfo}`;
  }
  if (digestStatus.pending > 0) {
    guidance += `\n\n🔄 ${digestStatus.pending} 条 digest 正在等待重试处理`;
  }

  // 记录操作
  const opId = repo.log.logOperation({
    operation: 'prepare',
    input_summary: `tool=${input.tool}`,
    context: input.hint,
    tool: input.tool,
    agent_id: input.agent_id,
  });

  repo.log.logStrategyFeedback({
    strategy_name: 'prepare-assemble',
    operation_id: opId,
    feedback_signal: 0.5,
  });

  // --- 搭便车维护：fire-and-forget，不阻塞 prepare 返回 ---
  maybeRunMaintenance(db, ALL_TASKS);

  log.debug(`keystones=${keystones.length} tags=${tags.length} crystals=${crystals.highlighted.length}+${crystals.others.length} recent=${recent.length}`);
  return { profile, keystones, tags, crystals, recent, guidance };
}

/** 读取预生成的画像 meta 节点 */
function buildProfile(repo: IRepository): PrepareProfile {
  // 复杂查询暂用 rawDb，待 repo 接口扩展后迁移
  const row = repo.rawDb.prepare(
    `SELECT content, created FROM nodes
     WHERE type = 'meta' AND title = 'user-profile' AND is_superseded = 0 AND archived = 0
     ORDER BY created DESC LIMIT 1`,
  ).get() as { content: string; created: string } | undefined;

  if (row) {
    // F3 读取侧自愈:存量历史节点可能是被污染的 raw JSON(2026-06 事故,见
    // docs/design/hook-injection-overflow-fix-2026-06-11.md)。sanitizeProfileContent
    // 对健康内容原样切出 text,对污染内容重新提取,无法救回返回 null。
    // 任何分支都不把 raw JSON 当画像文本注入——下游 hook 注入受 10K 字符上限约束。
    const sanitized = sanitizeProfileContent(row.content);
    if (sanitized) {
      const structured = Object.keys(sanitized.structured).length > 0 ? sanitized.structured : undefined;
      return { text: sanitized.profileText, structured, generated_at: row.created };
    }
    // 净化失败(脏到救不回)→ 落到下面的基础统计降级,而非返回脏全文
    log.warn('画像节点内容无法净化,降级为基础统计');
  }

  // 画像尚未生成——临时拼一个基础统计
  const typeCounts = repo.rawDb.prepare(`
    SELECT type, COUNT(*) as cnt FROM nodes WHERE heat > 0.01 AND is_meta = 0 AND archived = 0 AND is_superseded = 0 GROUP BY type
  `).all() as Array<{ type: string; cnt: number }>;

  const total = typeCounts.reduce((s, t) => s + t.cnt, 0);
  if (total === 0) {
    return { text: '外脑刚刚启动，还没有记忆。', generated_at: new Date().toISOString() };
  }

  const typeStr = typeCounts.map(t => `${t.type}: ${t.cnt}`).join(', ');
  return { text: `${total} 条记忆 (${typeStr})。画像将在积累足够数据后自动生成。`, generated_at: new Date().toISOString() };
}

/** 枢纽节点——每个知识簇的代表 */
function buildKeystones(repo: IRepository): PrepareKeystone[] {
  const maxKeystones = getParam('prepare-assemble', 'max_keystones', 15);

  const rows = repo.rawDb.prepare(`
    SELECT n.id, n.title, n.content, n.type, COUNT(l.id) as link_count FROM nodes n
    LEFT JOIN links l ON (l.from_id = n.id OR l.to_id = n.id) AND l.deleted = 0
    WHERE n.is_keystone = 1 AND n.is_superseded = 0 AND n.archived = 0 AND n.heat > 0.01
    GROUP BY n.id
    ORDER BY link_count DESC
    LIMIT ?
  `).all(maxKeystones) as Array<{ id: string; title: string | null; content: string; type: string; link_count: number }>;

  return rows.map(r => ({
    id: r.id,
    title: pickDisplayTitle(r.title, r.content),
    type: r.type as PrepareKeystone['type'],
    link_count: r.link_count,
  }));
}

/** 标签索引——覆盖知识领域 */
function buildTags(repo: IRepository): PrepareTag[] {
  const maxTags = getParam('prepare-assemble', 'max_tags', 30);

  const rows = repo.rawDb.prepare(`
    SELECT n.id, n.title, n.content, COUNT(l.id) as link_count FROM nodes n
    LEFT JOIN links l ON (l.from_id = n.id OR l.to_id = n.id) AND l.deleted = 0
    WHERE n.is_tag = 1 AND n.is_superseded = 0 AND n.archived = 0 AND n.heat > 0.01
    GROUP BY n.id
    ORDER BY link_count DESC
    LIMIT ?
  `).all(maxTags) as Array<{ id: string; title: string | null; content: string; link_count: number }>;

  return rows.map(r => ({
    id: r.id,
    title: pickDisplayTitle(r.title, r.content) ?? r.id,
    link_count: r.link_count,
  }));
}

/** 结晶——高阶认知 */
function buildCrystals(repo: IRepository): PrepareOutput['crystals'] {
  const maxHighlighted = getParam('prepare-assemble', 'max_crystals_highlighted', 8);
  const maxTotal = getParam('prepare-assemble', 'max_crystals_total', 20);
  const snippetLength = getParam('prepare-assemble', 'crystal_snippet_length', 80);

  const allCrystals = repo.rawDb.prepare(`
    SELECT id, title, content, heat FROM nodes
    WHERE is_crystal = 1 AND is_superseded = 0 AND archived = 0 AND heat > 0.01
    ORDER BY heat DESC
    LIMIT ?
  `).all(maxTotal) as Array<{ id: string; title: string | null; content: string; heat: number }>;

  const highlighted: PrepareCrystalHighlighted[] = allCrystals.slice(0, maxHighlighted).map(c => ({
    id: c.id,
    title: pickDisplayTitle(c.title, c.content),
    snippet: c.content.slice(0, snippetLength).replace(/\n/g, ' ').trim(),
    heat: c.heat,
  }));

  const others: PrepareCrystalOther[] = allCrystals.slice(maxHighlighted).map(c => ({
    id: c.id,
    title: pickDisplayTitle(c.title, c.content),
  }));

  return { highlighted, others };
}

/** 最近活跃——时序补充 */
function buildRecent(repo: IRepository): PrepareRecent[] {
  const maxRecent = getParam('prepare-assemble', 'max_recent', 15);
  const windowHours = getParam('prepare-assemble', 'recent_window_hours', 48);

  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // 最近创建 + 最近被 recall 过的节点，合并去重
  // 用 last_reconsolidated 作为"最近活跃"的代理（recall 会触发 bumpHeat，但更可靠的信号是 last_reconsolidated）
  const rows = repo.rawDb.prepare(`
    SELECT id, title, content, type,
      CASE
        WHEN last_reconsolidated IS NOT NULL AND last_reconsolidated > created
          THEN last_reconsolidated
        ELSE created
      END as latest_activity
    FROM nodes
    WHERE is_superseded = 0 AND archived = 0 AND is_meta = 0
      AND (
        created > ?
        OR (last_reconsolidated IS NOT NULL AND last_reconsolidated > ?)
      )
    ORDER BY latest_activity DESC
    LIMIT ?
  `).all(cutoff, cutoff, maxRecent) as Array<{ id: string; title: string | null; content: string; type: string; latest_activity: string }>;

  return rows.map(r => ({
    id: r.id,
    title: pickDisplayTitle(r.title, r.content),
    type: r.type as PrepareRecent['type'],
    timestamp: r.latest_activity,
  }));
}

function buildGuidance(gates: ReturnType<typeof getGateStatus>): string {
  const parts: string[] = [];

  if (gates.node_count === 0) {
    parts.push('外脑刚启动，请积极使用 brain_digest 存储本次对话中的关键决策、想法和发现。');
  } else {
    parts.push('对话中遇到需要历史上下文的问题时，使用 brain_recall 查询。记得提供 context 参数说明查询背景。');
    parts.push('brain_recall 支持多维度叠加：query + time/tags/type/from_agents 任意组合，结果分 exact_matches / related_matches 两段永不空返。多关键词默认 OR 召回——不要堆同义词。');
  }

  if (gates.node_count < 50) {
    parts.push('当前记忆较少，向量搜索尚未激活。请持续积累记忆。');
  }

  parts.push('每次响应用户后，使用 brain_digest 记录本轮交互中的实质内容。');

  return parts.join('\n');
}
