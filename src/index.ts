#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDataDirs, getConfig } from './config.js';
import { getDb, closeDb, initVec } from './db/connection.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import { digest } from './tools/digest.js';
import { recall } from './tools/recall.js';
import { prepare } from './tools/prepare.js';
// PR-3: 砍 intent 字段后，Intent type 在 src/index.ts 不再用（recall.ts 内部
// 仍 cast 但 import 在那里）。保留 RecallInput 等其它类型。
import type { DigestInput, RecallInput, PrepareInput, DigestIntent, DetailLevel } from './types.js';

import { touchAgent, getAgent } from './db/agents.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';

const log = createLogger('server');
const migrationLog = createLogger('migrate');

// 初始化
// 必须在 loadConfig / 打开 DB 之前完成一次性数据目录迁移（~/.external-brain → ~/.tidemind）
migrateDataDirIfNeeded(migrationLog);
loadConfig();
ensureDataDirs();

// Agent 身份（通过环境变量注入，每个 MCP 进程对应一个 Agent）
const agentId = process.env.EB_AGENT_ID ?? null;
if (!agentId) {
  // 没有 agentId 时 touchAgent 会被静默跳过，导致 agent 活跃度/调用归属信号丢失。
  // 必须在启动阶段 warn 出来，让部署者能发现环境变量漏配的问题。
  log.warn('EB_AGENT_ID 未设置：agent 活跃度追踪将被跳过（touchAgent 不会执行）');
}

// 从 package.json 读取版本号
function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', 'package.json'),   // 从 dist/ 运行
    join(__dirname, '..', '..', 'package.json'), // 其他情况
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8'));
      if (pkg.name === 'tidemind') return pkg.version;
    } catch { /* skip */ }
  }
  log.warn('package.json 未找到，版本回落到 0.0.0');
  return '0.0.0';
}

const server = new McpServer({
  name: 'tidemind',
  version: getVersion(),
});

// --- 加载 MCP 工具描述（可在客户端编辑）---
const defaultDescriptions: Record<string, string> = {
  brain_prepare: '每次新对话开始时立刻调用。返回用户画像、枢纽节点索引、标签索引、结晶摘要和最近活跃记忆。每条索引包含 ID，可用 brain_recall(node_id) 获取详情。',
  brain_recall: '从记忆库检索。支持多维度叠加：query（关键词/语义）+ match（any 默认 / all）+ time + tags + type + from_agents 任意组合。结果分 exact_matches / related_matches 两段，永不空返。要按位置取记忆用 node_id / from_node / vault_file override 入口。',
  brain_digest: '将信息存入记忆库。每次响应用户后，将本轮有实质内容的交互记录下来。也可用于纠正错误记忆或归档过时信息。',
};

function loadMcpDescriptions(): Record<string, string> {
  try {
    const config = getConfig();
    const descPath = join(config.general.data_dir, 'mcp-descriptions.json');
    if (existsSync(descPath)) {
      const loaded = JSON.parse(readFileSync(descPath, 'utf-8'));
      return { ...defaultDescriptions, ...loaded };
    }
  } catch (err) {
    process.stderr.write(`[warn] MCP descriptions 加载失败: ${(err as Error).message}\n`);
  }
  return defaultDescriptions;
}

const mcpDesc = loadMcpDescriptions();

// ============================================================
// brain_prepare — 对话开始时调用，获取认知包
// ============================================================
server.tool(
  'brain_prepare',
  mcpDesc.brain_prepare,
  {
    tool: z.string().describe('当前工具名称'),
    // 历史 bug(2026-05-09 修 M19):`hint_topic` 在 schema 声明过但
    // PrepareInput 没该字段、handler 也从未读出 — 客户端按 schema 传进来会
    // 被静默丢弃。移除 schema 定义,避免 MCP 工具契约与实际行为不一致。
    // 调用方有"话题"语义需求时统一走 hint 字段。
    files: z.array(z.string()).optional().describe('当前相关的文件或资源'),
    hint: z.string().optional().describe('用户的第一句话或对话主题'),
    detail_level: z.enum(['brief', 'standard', 'deep']).optional().describe('返回详细程度：brief 用于快速问答，deep 用于复杂讨论'),
  },
  async (params) => {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
      if (agentId) touchAgent(db, agentId);
      const input: PrepareInput = {
        tool: params.tool,
        files: params.files,
        hint: params.hint,
        detail_level: params.detail_level as DetailLevel | undefined,
        agent_id: agentId ?? undefined,
      };
      const result = await prepare(repo, input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('brain_prepare 失败:', msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

// ============================================================
// brain_recall — 按需获取记忆
// ============================================================
server.tool(
  'brain_recall',
  mcpDesc.brain_recall,
  {
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
    limit: z.number().int().min(1).max(200).default(50),
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
  async (params: unknown) => {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
      if (agentId) touchAgent(db, agentId);

      // 推导 source_tool
      let sourceTool: string | undefined;
      if (agentId) {
        const agent = getAgent(db, agentId);
        sourceTool = agent?.tool_type;
      }

      // 1. 废弃字段检测 → 返回结构化 hint
      const p = params as Record<string, unknown>;
      const deprecated: string[] = [];
      if ('intent' in p && p.intent !== undefined) deprecated.push('intent');
      if ('include_surprise' in p && p.include_surprise !== undefined) deprecated.push('include_surprise');
      if (deprecated.length > 0) {
        return makeDeprecatedFieldsError(deprecated);
      }

      // 2. 全空 + 无 override → reject
      // 注意：context 不算 search dim。设计 §5.2 — context 是给 query 提供检索意图,
      // 单独传 context 没有 query 时没东西可 embed,等同于空输入。v0.2.81 之前
      // hasSearchDim 包含 context,导致只传 context 时跑空 pipeline 而非 reject。
      const hasSearchDim = p.query !== undefined;
      const hasFilterDim = p.time !== undefined || p.tags !== undefined || p.type !== undefined || p.from_agents !== undefined;
      const hasOverride = p.node_id !== undefined || p.from_node !== undefined || p.vault_file !== undefined || p.source_file !== undefined;
      const hasCompat = p.scope !== undefined || p.index_ref !== undefined || p.created_after !== undefined || p.created_before !== undefined;
      if (!hasSearchDim && !hasFilterDim && !hasOverride && !hasCompat) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'brain_recall 至少需要一个有效输入：query / 过滤维度 (time/tags/type/from_agents) / override (node_id/from_node/vault_file) 之一。context 单独传无效，需要配合 query。' }],
        };
      }

      // 3. time.after > before 检查
      const time = p.time as { after?: string; before?: string } | undefined;
      if (time?.after && time?.before && time.after > time.before) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'time.after 不能晚于 time.before' }],
        };
      }

      // 4. normalizeInput: 兼容字段映射到新字段
      const input = normalizeRecallInput(p, agentId, sourceTool);

      const result = await recall(repo, input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('brain_recall 失败:', msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

/**
 * 把废弃字段告知 agent 并引导用户升级 Skill。
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §8.5
 */
function makeDeprecatedFieldsError(fields: string[]): { isError: true; content: { type: 'text'; text: string }[] } {
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: `brain_recall 已升级到新版（v0.2.77）。\n\n` +
        `检测到废弃参数：${fields.join(', ')}\n\n` +
        `请打开 TideMind，进入「设置 → External Integration」，按页面顶部提示重新生成 Skill。\n\n` +
        `或临时去掉这些参数重新调用。\n\n` +
        `详见 https://tidemind.ai/help/upgrade`,
    }],
  };
}

/**
 * 把旧字段 silent 映射到新字段。
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §8.1 字段映射表
 */
function normalizeRecallInput(
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

  // 兼容映射 2：scope: "tag:xxx" / "project:xxx" → tags
  if (!input.tags && typeof p.scope === 'string') {
    const m = p.scope.match(/^(tag|project):(.+)$/);
    if (m) input.tags = [m[2]];
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

// ============================================================
// brain_digest — 消化信息到外脑
// ============================================================
server.tool(
  'brain_digest',
  mcpDesc.brain_digest,
  {
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
  async (params) => {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
      if (agentId) touchAgent(db, agentId);
      const input: DigestInput = {
        content: params.content,
        title: params.title,
        source: params.source,
        context: params.context,
        tags: params.tags,
        target_node: params.target_node,
        target_link: params.target_link,
        intent: params.intent as DigestIntent | undefined,
        async: params.async,
        agent_id: agentId ?? undefined,
      };
      // 传入 server 让 digest 在归类模糊时可通过 MCP elicitation 向用户追问
      const result = await digest(repo, input, { server });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('brain_digest 失败:', msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
  },
);

// ============================================================
// 启动服务器
// ============================================================
async function main() {
  // 加载 sqlite-vec 扩展，启用向量搜索 + 着陆连接
  await initVec();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅退出：异步 flush MCP transport → close db → exit
  // 10s 超时兜底,避免 transport 卡住时永远退不出去。
  async function gracefulShutdown(): Promise<void> {
    const SHUTDOWN_TIMEOUT_MS = 10_000;
    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(() => {
        log.warn('shutdown timeout 10s 到期，强制退出');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS).unref(),
    );
    const closePromise = (async () => {
      try {
        if (server) await server.close();
      } catch (err) {
        log.warn('server-close-failed:', err instanceof Error ? err.message : String(err));
      }
      try {
        closeDb();
      } catch (err) {
        log.warn('close-db-failed:', err instanceof Error ? err.message : String(err));
      }
    })();
    await Promise.race([closePromise, timeoutPromise]);
    process.exit(0);
  }
  process.on('SIGINT', () => { void gracefulShutdown(); });
  process.on('SIGTERM', () => { void gracefulShutdown(); });
}

// 修复 M20(2026-05-09):全局错误 handler 挪到模块顶层。历史在 main() 内
// 注册,从模块加载到 server.connect 完成的整段启动期(loadConfig / TOML 解析 /
// schema migration 等同步或异步抛错)没有 handler,Node 22+ 默认行为是进程
// 退出且无日志,运维只看到"daemon 起不来"无线索。daemon.ts 已是顶层注册,
// 这里对齐。
//
// 2026-05-21 audit F10:统一 daemon.ts / index.ts 的 unhandled handler 行为:
//  - 不再用 stderr.write 兜底(模块顶层 import 已完成,createLogger 可用)
//  - 都走 log.error + setTimeout exit(1),让进程在异常态下不残留
//  - 1s delay 给日志写盘时间,Railway / file logger 都能 drain
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  setTimeout(() => process.exit(1), 1000);
});

main().then(() => {
  log.info('MCP server 已启动');
}).catch((err) => {
  log.error('启动失败:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
