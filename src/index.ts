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
import type { DigestInput, RecallInput, PrepareInput, DigestIntent, Intent, DetailLevel } from './types.js';

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
  brain_recall: '从记忆库检索信息。支持两种模式：mode="index" 返回大量轻量条目（标题+ID+摘要），mode="detail"（默认）返回完整内容+关联节点。建议先用 index 浏览，再用 node_id 深入。提供 context 参数说明"为什么查"能显著提升检索质量。',
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
    hint_topic: z.string().optional().describe('当前话题名称'),
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
    query: z.string().optional().describe('搜索关键词或语义查询'),
    node_id: z.string().optional().describe('直接按 ID 获取记忆'),
    index_ref: z.string().optional().describe('按 prepare 返回的索引条目获取'),
    source_file: z.string().optional().describe('按来源文件或资源查询'),
    from_node: z.string().optional().describe('从指定记忆出发探索关联'),
    context: z.string().optional().describe('查询背景——为什么要查这个（提升检索精度）'),
    intent: z.enum(['factual', 'exploratory', 'creative']).optional().describe('factual=找事实结论，exploratory=探索关联网络，creative=寻找意外灵感'),
    relation: z.string().optional().describe('关联类型过滤'),
    depth: z.number().optional().describe('探索深度'),
    scope: z.string().optional().describe('过滤范围（如 "tag:xxx"）'),
    type: z.string().optional().describe('过滤记忆类型'),
    created_after: z.string().optional().describe('只返回此时间之后创建的记忆（ISO 日期字符串，如 "2026-03-01"）'),
    created_before: z.string().optional().describe('只返回此时间之前创建的记忆（ISO 日期字符串，如 "2026-03-30"）'),
    include_surprise: z.boolean().optional().describe('是否返回意外关联，适合深度思考场景'),
    limit: z.number().optional().describe('返回数量上限'),
    mode: z.enum(['index', 'detail']).optional().describe('index=只返回标题+ID+摘要（量大轻量），detail=返回完整内容+关联（默认）'),
  },
  async (params) => {
    try {
      const db = getDb();
      const repo = new SqliteRepository(db);
      if (agentId) touchAgent(db, agentId);
      // 推导 source_tool：从 agentId 查 tool_type
      let sourceTool: string | undefined;
      if (agentId) {
        const agent = getAgent(db, agentId);
        sourceTool = agent?.tool_type;
      }
      const input: RecallInput = {
        query: params.query,
        node_id: params.node_id,
        index_ref: params.index_ref,
        source_file: params.source_file,
        from_node: params.from_node,
        context: params.context,
        intent: params.intent as Intent | undefined,
        relation: params.relation,
        depth: params.depth,
        scope: params.scope,
        type: params.type,
        created_after: params.created_after,
        created_before: params.created_before,
        include_surprise: params.include_surprise,
        limit: params.limit,
        mode: params.mode as RecallInput['mode'],
        agent_id: agentId ?? undefined,
        source_tool: sourceTool,
      };
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

  // 防止未捕获错误导致进程静默退出
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException:', err instanceof Error ? err.stack : String(err));
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
  });
}

main().then(() => {
  log.info('MCP server 已启动');
}).catch((err) => {
  log.error('启动失败:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
