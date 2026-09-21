#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRAIN_TOOL_INPUT_SHAPES, DEFAULT_BRAIN_TOOL_DESCRIPTIONS as defaultDescriptions } from './mcp-tool-contracts.js';
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
import {
  digestResultProducedActivity,
  shouldRecordMcpActivity,
} from './agent-integration-recognition.js';

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
const activityGenerationToken = process.env.EB_ACTIVITY_GENERATION_TOKEN ?? null;
if (!agentId) {
  // 没有 agentId 时宿主活动无法归属到 exact Installation。
  // 必须在启动阶段 warn 出来，让部署者能发现环境变量漏配的问题。
  log.warn('EB_AGENT_ID 未设置：不会生成宿主活动验证证据');
}
if (!hostVariant) log.warn('EB_HOST_VARIANT 未设置：不会生成宿主活动验证证据');
if (!activityGenerationToken) log.warn('EB_ACTIVITY_GENERATION_TOKEN 未设置：不会生成宿主活动验证证据');

const tideMindVersion = getTideMindVersion();
const activityWarnings = new Set<string>();

function recordMcpActivity(db: ReturnType<typeof getDb>, signalName: HostActivitySignal): void {
  if (!agentId || !hostVariant || !activityGenerationToken) return;
  try {
    const result = recordHostActivityEvidence(db, {
      agentId,
      hostVariant,
      componentKey: 'memory_tools',
      signalName,
      tideMindVersion,
      activityGenerationToken,
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
  BRAIN_TOOL_INPUT_SHAPES.brain_prepare,
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
        // OpenCode V2 has no lifecycle API.  For that exact host, a generic
        // prepare call proves only MCP availability; it becomes instruction
        // recognition evidence only when the managed Skill supplied its
        // stable proof phrase in this same MCP process/generation.
        if (shouldRecordMcpActivity({
          hostVariant,
          signalName: 'brain_prepare',
          instructionProbe: params.integration_probe,
        })) {
          recordMcpActivity(db, 'brain_prepare');
        }
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
  BRAIN_TOOL_INPUT_SHAPES.brain_recall,
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
  BRAIN_TOOL_INPUT_SHAPES.brain_digest,
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
      if (digestResultProducedActivity(result)) {
        recordMcpActivity(db, 'brain_digest');
      }
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
