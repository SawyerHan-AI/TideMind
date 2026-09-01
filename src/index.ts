#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ensureDataDirs, getConfig } from './config.js';
import { getDb, closeDb, initVec } from './db/connection.js';
import { SqliteRepository } from './db/sqlite-repository.js';
import { digest } from './tools/digest.js';
import { recall } from './tools/recall.js';
import { normalizeRecallInput } from './tools/recall-input.js';
import { prepare } from './tools/prepare.js';
// PR-3: 砍 intent 字段后，Intent type 在 src/index.ts 不再用（recall.ts 内部
// 仍 cast 但 import 在那里）。RecallInput 随 normalizeRecallInput 移到
// ./tools/recall-input.js,此处不再 import。
import type { DigestInput, PrepareInput, DigestIntent, DetailLevel } from './types.js';

import { getAgent } from './db/agents.js';
import { recordHostActivityEvidence, type HostActivitySignal } from './db/agent-host-activity.js';
import { createLogger } from './utils/logger.js';
import { migrateDataDirIfNeeded } from './utils/migrate-data-dir.js';
import { shutdownLLMClient } from './llm/client.js';
import { waitForBackgroundWork } from './utils/background-work.js';
import { getTideMindVersion } from './utils/app-version.js';

const log = createLogger('server');
const migrationLog = createLogger('migrate');

// 初始化
// 必须在 loadConfig / 打开 DB 之前完成一次性数据目录迁移（~/.external-brain → ~/.tidemind）
migrateDataDirIfNeeded(migrationLog);
loadConfig();
ensureDataDirs();

// Agent 身份（通过环境变量注入，每个 MCP 进程对应一个 Agent）
const agentId = process.env.EB_AGENT_ID ?? null;
const hostVariant = process.env.EB_HOST_VARIANT ?? null;
if (!agentId) {
  // 没有 agentId 时宿主活动无法归属到 exact Installation。
  // 必须在启动阶段 warn 出来，让部署者能发现环境变量漏配的问题。
  log.warn('EB_AGENT_ID 未设置：不会生成宿主活动验证证据');
}
if (!hostVariant) log.warn('EB_HOST_VARIANT 未设置：不会生成宿主活动验证证据');

const tideMindVersion = getTideMindVersion();
const activityWarnings = new Set<string>();

function recordMcpActivity(db: ReturnType<typeof getDb>, signalName: HostActivitySignal): void {
  if (!agentId || !hostVariant) return;
  try {
    const result = recordHostActivityEvidence(db, {
      agentId,
      hostVariant,
      componentKey: 'memory_tools',
      signalName,
      tideMindVersion,
    });
    if (result.status === 'rejected' && !activityWarnings.has(result.reason)) {
      activityWarnings.add(result.reason);
      log.warn(`MCP 宿主活动证据被拒绝：${result.reason}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!activityWarnings.has(reason)) {
      activityWarnings.add(reason);
      log.warn(`MCP 宿主活动证据不可用：${reason}`);
    }
  }
}

const server = new McpServer({
  name: 'tidemind',
  version: tideMindVersion,
});
let mcpStopping = false;
let activeMcpHandlers = 0;
const mcpHandlerDrainWaiters = new Set<() => void>();

function enterMcpHandler(): boolean {
  if (mcpStopping) return false;
  activeMcpHandlers++;
  return true;
}

function leaveMcpHandler(): void {
  activeMcpHandlers--;
  if (activeMcpHandlers === 0) {
    for (const resolve of mcpHandlerDrainWaiters) resolve();
    mcpHandlerDrainWaiters.clear();
  }
}

function waitForMcpHandlers(): Promise<void> {
  if (activeMcpHandlers === 0) return Promise.resolve();
  return new Promise(resolve => mcpHandlerDrainWaiters.add(resolve));
}

const mcpStoppingResult = {
  isError: true as const,
  content: [{ type: 'text' as const, text: 'Tide Mind 正在安全退出，已停止接收新请求。' }],
};

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
    if (!enterMcpHandler()) return mcpStoppingResult;
    try {
      try {
        const db = getDb();
        const repo = new SqliteRepository(db);
        const input: PrepareInput = {
          tool: params.tool,
          files: params.files,
          hint: params.hint,
          detail_level: params.detail_level as DetailLevel | undefined,
          agent_id: agentId ?? undefined,
        };
        const result = await prepare(repo, input);
        recordMcpActivity(db, 'brain_prepare');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('brain_prepare 失败:', msg);
        return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
      }
    } finally {
      leaveMcpHandler();
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
  async (params: unknown) => {
    if (!enterMcpHandler()) return mcpStoppingResult;
    try {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
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
      recordMcpActivity(db, 'brain_recall');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('brain_recall 失败:', msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
    } finally {
      leaveMcpHandler();
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

// normalizeRecallInput 已移到 ./tools/recall-input.js(便于单测，见顶部 import)。

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
    if (!enterMcpHandler()) return mcpStoppingResult;
    try {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
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
      recordMcpActivity(db, 'brain_digest');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('brain_digest 失败:', msg);
      return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
    }
    } finally {
      leaveMcpHandler();
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

  // 优雅退出：先停止 MCP admission，再关闭 LLM runtime 并排空脱离请求的后台
  // recall work，最后才 close DB。CLI kill verification / ambiguous 收口失败时
  // 必须保留进程和数据库，不能用固定 timeout 强退。
  let shutdownPromise: Promise<void> | null = null;
  async function gracefulShutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    const current = (async () => {
      mcpStopping = true;
      if (server) await server.close();
      await shutdownLLMClient();
      await waitForMcpHandlers();
      await waitForBackgroundWork();
      try {
        closeDb();
      } catch (err) {
        log.warn('close-db-failed:', err instanceof Error ? err.message : String(err));
      }
      process.exit(0);
    })().catch(error => {
      log.error('graceful shutdown failed; process and DB kept alive:', error);
      shutdownPromise = null;
    });
    shutdownPromise = current;
    return current;
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
