import type { RecallInput } from '../types.js';

/**
 * 把 brain_recall 的旧字段 silent 映射到新字段（兼容老 skill / 老 agent）。
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §8.1 字段映射表
 *
 * 提取到独立模块（不放 index.ts）以便单测——index.ts 模块加载即启动 MCP server。
 */
export function normalizeRecallInput(
  p: Record<string, unknown>,
  agentId: string | null | undefined,
  sourceTool: string | undefined,
): RecallInput {
  const input: RecallInput = {
    query: p.query as string | undefined,
    match: p.match as 'any' | 'all' | undefined,
    context: p.context as string | undefined,
    time: p.time as RecallInput['time'],
    tags: p.tags as string[] | undefined,
    type: p.type as string | undefined,
    from_agents: p.from_agents as string[] | undefined,
    sort: p.sort as 'relevance' | 'recent' | undefined,
    limit: p.limit as number | undefined,
    mode: p.mode as RecallInput['mode'],
    node_id: p.node_id as string | undefined,
    from_node: p.from_node as string | undefined,
    relation: p.relation as string | undefined,
    depth: p.depth as number | undefined,
    vault_file: p.vault_file as string | undefined,
    agent_id: agentId ?? undefined,
    source_tool: sourceTool,
  };

  // 兼容映射 1：source_file → vault_file
  if (!input.vault_file && typeof p.source_file === 'string') {
    input.vault_file = p.source_file;
  }

  // 兼容映射 2：scope → tags。
  // 旧版 recall 前缀是可选的(recall.ts 老逻辑用 replace(/^(project|tag):/,'') 兼容
  // 裸值,旧 skill 可能传 scope:'tidemind')。这里既要识别带前缀的 "tag:xxx" /
  // "project:xxx"，也要把裸值(无前缀)直接当 tag——否则裸 scope 既不进 tags 也不进
  // input.scope，过滤条件整体蒸发，返回未过滤结果且无任何提示。
  if (!input.tags && typeof p.scope === 'string' && p.scope.length > 0) {
    const m = p.scope.match(/^(tag|project):(.+)$/);
    input.tags = [m ? m[2] : p.scope];
  }

  // 兼容映射 3：index_ref: "tag:xxx" / "project:xxx" → tags；"node:xxx" → node_id
  if (typeof p.index_ref === 'string') {
    const m = p.index_ref.match(/^(tag|project|node):(.+)$/);
    if (m) {
      if (m[1] === 'node' && !input.node_id) input.node_id = m[2];
      else if ((m[1] === 'tag' || m[1] === 'project') && !input.tags) input.tags = [m[2]];
    }
  }

  // 兼容映射 4：created_after/before → time.after/before
  if (!input.time && (typeof p.created_after === 'string' || typeof p.created_before === 'string')) {
    input.time = {
      after: typeof p.created_after === 'string' ? p.created_after : undefined,
      before: typeof p.created_before === 'string' ? p.created_before : undefined,
    };
  }

  // 反向映射：把新字段也写到老字段，让 recall.ts 主调度（读老字段名的）能拿到。
  // PR-4 主调度完整重写前的桥接：避免新字段在 recall.ts 里变成死代码（audit-1 C1/C2 修复）。
  // PR-4 完整重写后，recall.ts 应直接读新字段，此映射可移除。
  if (!input.source_file && input.vault_file) input.source_file = input.vault_file;
  if (!input.created_after && input.time?.after) input.created_after = input.time.after;
  if (!input.created_before && input.time?.before) input.created_before = input.time.before;
  // time.preset → created_after（翻译相对时间）
  if (!input.created_after && input.time?.preset) {
    const now = Date.now();
    const presetMap: Record<string, number> = {
      today: 1 * 24 * 60 * 60 * 1000,
      recent_3days: 3 * 24 * 60 * 60 * 1000,
      recent_week: 7 * 24 * 60 * 60 * 1000,
      recent_month: 30 * 24 * 60 * 60 * 1000,
      recent_3months: 90 * 24 * 60 * 60 * 1000,
    };
    const ms = presetMap[input.time.preset];
    if (ms) input.created_after = new Date(now - ms).toISOString();
  }
  // tags → scope (单 tag) — 多 tag AND 留给 PR-4 在 hybrid 里实现，单 tag 用 scope 兼容
  if (!input.scope && input.tags && input.tags.length === 1) {
    input.scope = `tag:${input.tags[0]}`;
  }

  return input;
}
