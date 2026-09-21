import { z } from 'zod';

/** Shared source of truth for MCP and native-host tool contracts. */
export const DEFAULT_BRAIN_TOOL_DESCRIPTIONS = {
  brain_prepare: '每次新对话开始时立刻调用。返回用户画像、枢纽节点索引、标签索引、结晶摘要和最近活跃记忆。每条索引包含 ID，可用 brain_recall(node_id) 获取详情。',
  brain_recall: '从记忆库检索。支持多维度叠加：query（关键词/语义）+ match（any 默认 / all）+ time + tags + type + from_agents 任意组合。结果分 exact_matches / related_matches 两段，永不空返。要按位置取记忆用 node_id / from_node / vault_file override 入口。',
  brain_digest: '将信息存入记忆库。每次响应用户后，将本轮有实质内容的交互记录下来。也可用于纠正错误记忆或归档过时信息。',
};

export const BRAIN_TOOL_INPUT_SHAPES = {
  brain_prepare: {
    tool: z.string().describe('当前工具名称'),
    // 历史 bug(2026-05-09 修 M19):`hint_topic` 在 schema 声明过但
    // PrepareInput 没该字段、handler 也从未读出 — 客户端按 schema 传进来会
    // 被静默丢弃。移除 schema 定义,避免 MCP 工具契约与实际行为不一致。
    // 调用方有"话题"语义需求时统一走 hint 字段。
    files: z.array(z.string()).optional().describe('当前相关的文件或资源'),
    hint: z.string().optional().describe('用户的第一句话或对话主题'),
    integration_probe: z.string().max(128).optional()
      .describe('仅供 Tide Mind 管理的宿主使用说明在明确要求时回传接入识别值；普通调用不要填写'),
    detail_level: z.enum(['brief', 'standard', 'deep']).optional().describe('返回详细程度：brief 用于快速问答，deep 用于复杂讨论'),
  },
  brain_recall: {
    // ── 搜索维度 ──
    query: z.string().max(2000).optional().describe('搜索关键词或语义查询（最长 2000 字）'),
    match: z.enum(['any', 'all']).default('any').describe('any (默认)=OR 召回，全命中的天然排前；all=严格 AND，全词必含'),
    context: z.string().max(2000).optional().describe('查询背景——为什么要查（明文进入 embedding，提升语义召回）'),

    // ── 过滤维度（跟 query AND） ──
    time: z.object({
      preset: z.enum(['today', 'recent_3days', 'recent_week', 'recent_month', 'recent_3months']).optional(),
      after: z.string().max(64).optional().describe('ISO 日期'),
      before: z.string().max(64).optional().describe('ISO 日期'),
    }).optional().describe('时间窗，preset 和 after/before 可同时传取交集'),
    tags: z.array(z.string().max(64)).max(20).optional().describe('标签数组，多值 AND'),
    type: z.enum(['fact', 'context', 'preference', 'idea', 'crystal', 'meta']).optional(),
    from_agents: z.array(z.string().max(64)).max(10).optional().describe('按来源工具类型过滤（如 claude-code / codex / gemini / logseq / obsidian / notion / apple-notes，对应节点 source_tool），多值 OR'),

    // ── 返回控制 ──
    sort: z.enum(['relevance', 'recent']).optional().describe('默认：有 query → relevance；无 query → recent'),
    // 不给 .default()：MCP SDK 会在调用 handler 前把 zod default 填进 params，
    // 那样 recall.ts 按 mode 计算的策略默认值(detail=8 / index=30，用户可在
    // recall-search 策略文件里调)会被恒定的 50 顶掉变成死代码。留 optional，让
    // recall.ts 的 `input.limit ?? defaultLimit` 真正生效。
    limit: z.number().int().min(1).max(200).optional(),
    mode: z.enum(['index', 'detail']).default('detail').describe('index=轻量索引；detail=完整内容+关联'),

    // ── Override 入口（传了忽略上面所有搜索/过滤） ──
    node_id: z.string().max(256).optional(),
    from_node: z.string().max(256).optional(),
    relation: z.string().max(256).optional().describe('仅 from_node 路径：按关系类型过滤'),
    depth: z.number().int().min(1).max(3).default(1).describe('仅 from_node 路径：扩展深度'),
    vault_file: z.string().max(512).optional().describe('vault 内文件路径'),

    // ── 兼容字段（normalizeInput 内部映射，1-2 版本后清理）──
    source_file: z.string().max(512).optional().describe('[兼容] 已重命名为 vault_file'),
    scope: z.string().max(256).optional().describe('[兼容] 改用 tags'),
    index_ref: z.string().max(256).optional().describe('[兼容] 改用 tags 或 node_id'),
    created_after: z.string().max(64).optional().describe('[兼容] 改用 time.after'),
    created_before: z.string().max(64).optional().describe('[兼容] 改用 time.before'),

    // ── 已废弃字段（handler 检测到返回 hint）──
    // SPIKE-0 验证 z.unknown().optional() 可用：值会保留到 handler
    intent: z.unknown().optional().describe('[DEPRECATED v0.2.77] 旧版语义意图。新版按 sort 控制排序。传入会被检测并返回升级 hint。'),
    include_surprise: z.unknown().optional().describe('[DEPRECATED v0.2.77] 已合并到 related_matches。传入会被检测并返回升级 hint。'),
  },
  brain_digest: {
    content: z.string().describe('要记住的内容，聚焦一个主题'),
    title: z.string().optional().describe('记忆标题（可选）'),
    source: z.object({
      tool: z.string(),
      session: z.string().optional(),
      files: z.array(z.string()).optional(),
    }).optional().describe('信息来源'),
    context: z.string().optional().describe('为什么值得记住、未来什么场景下可能有用'),
    tags: z.array(z.string()).optional().describe('内容标签（如有）'),
    target_node: z.string().optional().describe('纠正或归档的目标记忆 ID'),
    target_link: z.object({
      from: z.string(),
      to: z.string(),
    }).optional().describe('要断开的关联'),
    intent: z.enum(['new', 'correction', 'archive']).optional().describe('new=新记忆，correction=纠正已有记忆，archive=归档过时记忆'),
    async: z.boolean().optional().describe('是否异步处理（默认 true）'),
  },
};

export type BrainToolName = keyof typeof BRAIN_TOOL_INPUT_SHAPES;
