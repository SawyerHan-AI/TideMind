import Anthropic from '@anthropic-ai/sdk';
import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fetch as undiciFetch, Agent } from 'undici';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { estimateVersionedCost } from './pricing.js';
import { clearEmbeddingTokenCache } from './embedding.js';
import { now } from '../utils/time.js';
import { processThinkTags } from './thinking.js';
import {
  assertRouteCallable,
  resolveLLMRoute,
  type ResolvedLLMRoute,
} from './route.js';
import {
  assertConnectionHealthCallable,
  releaseConnectionHealthProbe,
  recordConnectionFailure,
  recordConnectionSuccess,
  type LLMCallEvent,
  type LLMConnectionErrorKind,
} from './connection-health.js';
import { noteActiveLLMRoute } from './invocation-context.js';
import { CliLLMError, runCliLLM, shutdownCliRuntime } from './cli/index.js';

const log = createLogger('llm');

// ─────────────────────────────────────────────────────────────
// 长生成 fetch 路径 (2026-05-21 问题 A 修复)
// ─────────────────────────────────────────────────────────────
//
// 真相: Vertex AI `rawPredict` 和 Gemini `generateContent` 是**非流式** API——
// 客户端必须等服务端把所有 max_tokens 生成完才返回 HTTP response headers。
// Sonnet-4-6 生成速度约 40 tokens/秒,所以 max_tokens >= 2500 几乎必然超 60 秒。
//
// Node 22+ 内置 fetch 是基于 undici 的 fetch shim,但**shim 自己写死 `headersTimeout
// = 60_000`**(跟 npm undici 默认 300_000 不同)。触发后抛 `fetch failed`,被
// Anthropic SDK 包装成 `Connection error.` **没有 HTTP 状态码**——光看错误根本
// 无法诊断,会以为是网络/region/SDK 问题。
//
// daemon 内部 callLLM 的 `setTimeout(() => controller.abort(), timeoutMs)`
// (standard tier 180s / heavy tier 300s) 永远等不到——内置 fetch 在 60s 时已经先 kill。
//
// 修复: 用 npm undici 包的 fetch + 自定义 Agent dispatcher,把 headersTimeout /
// bodyTimeout 拉高到 1500_000ms (25 分钟,heavy tier 1200s + 300s buffer)。
//
// 2026-05-21:数值从 360_000 → 1500_000。tier timeout 全档抬高
// (60/180/300 → 360/600/1200)给慢 provider 更宽余量,避免 LLM 长生成误触超时;
// dispatcher 同步抬到 heavy + 5min。
//
// 为什么自定义 fetch 而不是 fetchOptions.dispatcher: npm 装的 undici 的 Agent 跟
// `globalThis.fetch` (Node 内置 undici shim) 的 Agent 是不同的 JS class——internal
// Symbol 不互通,通过 RequestInit.dispatcher 传 npm Agent 给内置 fetch 会被 silently
// 忽略或 internal validation 失败。custom fetch 让整条调用链全走 npm undici,dispatcher
// 一致。
//
// 复现实验: tests/manual/maxtokens-timeout.mjs (max_tokens=50/1000/4000/10000 阶梯,
// 4000/10000 恰好在 60.5s/60.9s timeout)。
//
// 复杂度评估: 给 SDK 传 `fetch: longRunningFetch` 即可,SDK 内部其他逻辑
// (重试、序列化、错误包装) 不受影响。**注意**:
//   - 5 处 SDK 构造 (Anthropic / Vertex × legacy 单例 + per-connection 路径) 都
//     需要 `fetch: longRunningFetch`
//   - 2 处裸 fetch (`callGeminiLLM` / `callOpenAICompatibleLLM`) 都需要 `undiciFetch`
//     + `dispatcher: longRunningDispatcher`
//   任何一处遗漏都会复现 60s timeout。Vertex auth (OAuth token 刷新) 走
//   google-auth-library 的 gaxios,不经过此 fetch,不受影响 (实测确认)。
const longRunningDispatcher = new Agent({
  headersTimeout: 1500_000,
  bodyTimeout: 1500_000,
  // keepAliveTimeout 保持 undici 默认 (4_000ms),不破坏 socket 复用语义。
  // clientTtl: 24h 后空闲 Pool 自动释放——daemon 长跑时避免用户切多个 region 累积
  // origin Pool(每个 Pool ~ KB 级,理论上无限增长,实际影响微小但顺手加)。
  clientTtl: 24 * 60 * 60 * 1000,
});
const activeCallAbortControllers = new Set<AbortController>();
let llmRuntimeStopping = false;
let llmShutdownPromise: Promise<void> | null = null;
const activeCallDrainWaiters = new Set<() => void>();

// 类型: Anthropic SDK 的 Fetch 类型签名是 standard fetch,undici fetch 跟它有
// 微小差异 (Response / Request / RequestInit 类型来源不同,Headers 内部互不识别
// 但 fetch 内部 duck-typing 兼容,实测 200 OK)。运行时兼容,类型断言绕开 TS 检查。
//
// 注意:longRunningFetch 内部 spread `...init` 后强制覆盖 dispatcher——这是预期
// (我们就是要保证整条 LLM 调用链全走同一个 dispatcher),不要把它当 bug 来"修"。
const longRunningFetch = ((url: string | URL | Request, init?: RequestInit) =>
  undiciFetch(url as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: longRunningDispatcher } as Parameters<typeof undiciFetch>[1])
) as unknown as typeof fetch;

/**
 * 关闭 LLM client 的 undici dispatcher,释放所有 keep-alive socket。
 * 应在 Electron 主进程 before-quit 时调用,避免 in-flight 请求挂住 process exit
 * (2026-05-21 backlog: quit-and-install 主进程卡 5+ 分钟 95% CPU 的潜在贡献者)。
 *
 * close() 等所有 in-flight 完成,destroy() 立刻 kill。daemon shutdown 场景用
 * destroy() 更激进——用户已经按 quit,不需要等 25 分钟 LLM 响应。
 */
export function shutdownLLMClient(): Promise<void> {
  llmRuntimeStopping = true;
  if (llmShutdownPromise) return llmShutdownPromise;
  const current = shutdownLLMClientInternal().catch(error => {
    if (llmShutdownPromise === current) llmShutdownPromise = null;
    throw error;
  });
  llmShutdownPromise = current;
  return current;
}

async function shutdownLLMClientInternal(): Promise<void> {
  const failures: unknown[] = [];
  for (const controller of activeCallAbortControllers) {
    controller.abort(new Error('LLM runtime is shutting down'));
  }
  try {
    await shutdownCliRuntime();
  } catch (err) {
    log.warn(`shutdownLLMClient: CLI runtime shutdown failed: ${(err as Error).message}`);
    failures.push(err);
  }
  try {
    await longRunningDispatcher.destroy();
  } catch (err) {
    log.warn(`shutdownLLMClient: dispatcher destroy failed: ${(err as Error).message}`);
    failures.push(err);
  }
  if (activeCallAbortControllers.size > 0) {
    await new Promise<void>(resolve => activeCallDrainWaiters.add(resolve));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'LLM runtime shutdown did not complete');
  }
}

/**
 * LLM 服务级错误：429 限流、5xx 服务端错误、401/403 认证、网络错误。
 * 与任务自身逻辑错误区分——只有此类错误应触发熔断器。
 */
export class LLMServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly connectionId: string | null = null,
  ) {
    super(message);
    this.name = 'LLMServiceError';
  }
}

let usageDb: Database.Database | null = null;

export function setUsageDb(db: Database.Database): void {
  usageDb = db;
}

// ─────────────────────────────────────────────────────────────
// LLM 真实成功信号 hook(2026-05-20 Audit A-1/A-2 修复)
// ─────────────────────────────────────────────────────────────
//
// 之前 scheduler 在 task.execute() 正常 return 后无条件调 recordLLMSuccess,
// 但很多 task(digest-retry / annotate / link-evaluate 等)在 LLM 没配置 /
// 没工作 / 内部吞掉 LLMServiceError 的情况下也会"正常 return",scheduler 误
// 当作"LLM 健康",写 llm_last_success_at + 重置熔断器。结果就是 2026-05-19
// 那种 7 天 LLM 全挂的事故,熔断器每 3 分钟被 digest-retry 重置一次,健康度
// gate 永远放行 pending-link-gc,整个"长期不可用防御"完全失效。
//
// 正确的做法:只有 callLLM 自己真的拿到 2xx response,才把"LLM 健康"这个事
// 实记录下来。core 层不能直接 import scheduler / db handle,所以走 hook 注入
// (跟 setHealthChangeListener 同样模式),由 daemon.ts 启动时把 db + 实际写入
// 函数绑进来。
//
// 设计保留 callLLM 的纯 pure / no-db-dep 特征,使本模块在 worker / 单元测试
// 等无 db 环境下仍可调用。
type LLMSuccessHook = () => void;
let llmSuccessHook: LLMSuccessHook | null = null;
export function setLLMSuccessHook(hook: LLMSuccessHook | null): void {
  llmSuccessHook = hook;
}
function notifyLLMSuccess(): void {
  if (!llmSuccessHook) return;
  try { llmSuccessHook(); } catch (err) {
    // hook 失败永远不能影响 LLM 调用结果;只记录
    log.warn(`llm success hook threw: ${(err as Error).message}`);
  }
}

// ---- Client 缓存（按 connection_id） ----
//
// 历史 bug(2026-05-09):缓存只按 connectionId 索引,首次构造时 apiKey/project_id
// 烙进 client 实例。用户在设置页改 API key → getConfig() 拿到新值,但已缓存
// client 仍持旧 key → 持续 401 直到重启 daemon。修复:缓存 key 包含 credentials
// 的稳定指纹(SHA256 前 12 位),credentials 变了自然换 cache key,旧 client
// 自然失效 → GC。clearClientCache 也提供给 settings 写入路径主动清理。

const clientCache = new Map<string, Anthropic | AnthropicVertex>();

// 旧的全局单例（向后兼容无 connection 路径）
let legacyAnthropicClient: Anthropic | null = null;
let legacyVertexClient: AnthropicVertex | null = null;
let legacyAnthropicKey = ''; // 跟踪 legacy client 当前生效的 key
let legacyVertexProject = ''; // 跟踪 legacy vertex 当前生效的 project_id

/**
 * Per-cache-entry 连续失败计数。同 cacheKey 累积 ≥ FAILURE_RESET_THRESHOLD
 * 时,callLLM 失败路径会主动 evict 该 entry,下次 call 重建 SDK 实例。
 *
 * 设计动机(2026-05-21 audit followup): daemon 长跑过程中如果 SDK client 持有的
 * undici socket pool 或 GoogleAuth token 缓存进入坏态(理论上少见,但 NordVPN/
 * Cloudflare WARP 之类的 TUN tunnel 抖动场景观察过类似异常),`clientCache` 持续
 * 复用同一个 SDK 实例,daemon 永远不能自愈。给 cache entry 加 consecutiveFailures
 * 计数,连续 N 次失败就 evict——下次 callLLM 会走 cache miss 路径建新 SDK 实例,
 * 等价于"自动重启 LLM client 但不重启 daemon"。
 *
 * 设计选择:
 * - 计数器跟 cacheKey 关联,不跟 SDK 实例关联(否则 evict 之后新建实例计数器不知道
 *   要不要继承,语义模糊)。
 * - 阈值 3 跟 callLLM 的 MAX_RETRIES 一致——3 次重试都失败说明这次 invocation 完全
 *   失败,可能 SDK state 损坏,值得 evict 重建。
 * - 成功一次清零(给短瞬 transient 错误留余地,不要因为偶发抖动就一直 evict)。
 * - clearClientCache 也清空计数,避免上次的失败"穿越"到新 cache entry。
 */
const FAILURE_RESET_THRESHOLD = 3;
const failureCounters = new Map<string, number>();

/**
 * 记录一次 cacheKey 调用结果。callLLM 在每次 invocation 完成时调用:
 * - success=true → 清零计数器(短瞬 transient 错误不应永久挂账)
 * - success=false → 累加,如果 >= FAILURE_RESET_THRESHOLD,evict cache + 重置计数
 * 返回值: 如果触发了 evict 则 true,调用方可以(可选地)记一行 log 监测自愈频率。
 */
function recordCallResult(cacheKey: string | null, success: boolean): boolean {
  if (!cacheKey) return false; // legacy / non-connection 路径不参与自愈
  if (success) {
    if (failureCounters.has(cacheKey)) failureCounters.delete(cacheKey);
    return false;
  }
  const next = (failureCounters.get(cacheKey) ?? 0) + 1;
  if (next >= FAILURE_RESET_THRESHOLD) {
    clientCache.delete(cacheKey);
    failureCounters.delete(cacheKey);
    return true;
  }
  failureCounters.set(cacheKey, next);
  return false;
}

/**
 * 清理 LLM client 缓存。配置/凭证变更时调用,避免下次请求继续用过期 client。
 * 没有副作用 — Anthropic SDK 实例不持有连接,直接 GC 即可。
 */
export function clearClientCache(): void {
  clientCache.clear();
  failureCounters.clear();
  legacyAnthropicClient = null;
  legacyVertexClient = null;
  legacyAnthropicKey = '';
  legacyVertexProject = '';
  // embedding 的 Vertex token 缓存与 SDK client 缓存共享同一批凭证,凭证变更
  // 路径(connections.ts / config.ts / llm-health 重试按钮)都只调本函数——
  // 不联动清理会让"修好了凭证却还是坏的"持续到 50 分钟窗口期满
  clearEmbeddingTokenCache();
}

// 导出供测试:验证 mtime+size 进入指纹
export function fingerprintCreds(obj: unknown, credPath?: string): string {
  // 稳定指纹:对 JSON 序列化后取 SHA256 前 12 位 hex(等价于 48 bit 抗碰撞,
  // 单台 Mac 上几乎不可能撞)。不暴露原 key,纯粹用作 cache key 区分。
  //
  // F8: Vertex 凭证存放在外部文件(creds 对象里只是 projectId/region),
  // 用户重新上传 JSON 后 creds 对象往往未变(同 projectId),需要把文件 mtime+size
  // 也纳入指纹,否则 cache 命中导致继续用旧 key file。
  let s = JSON.stringify(obj ?? {});
  if (credPath) {
    try {
      const stat = fs.statSync(credPath);
      s += `:${stat.mtimeMs}:${stat.size}`;
    } catch {
      // 文件不存在 / 不可读时用 base 指纹,保持向后兼容
    }
  }
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

// 关键:所有 Anthropic / AnthropicVertex 构造函数必须显式传 maxRetries: 0。
// SDK 默认 maxRetries=2,我们外层已有 MAX_RETRIES=3 的重试循环 →
// 不关掉 SDK 内置重试,worst case 会变成 3*3=9 次 LLM 调用,直接捅穿超时档。
// 外层重试是唯一应当存在的重试机制(可控的 backoff + Retry-After 处理)。
function getLegacyAnthropicClient(): Anthropic {
  const config = getConfig();
  const currentKey = config.anthropic.api_key || '';
  // key 变化时自动失效旧 client
  if (legacyAnthropicClient && legacyAnthropicKey === currentKey) return legacyAnthropicClient;
  legacyAnthropicClient = new Anthropic({
    apiKey: currentKey || undefined,
    maxRetries: 0,
    fetch: longRunningFetch, // 见模块顶部 longRunningFetch 注释:避免 undici 60s headersTimeout 截断长生成请求
    timeout: 1500_000, // 跟 longRunningDispatcher 的 1500s 对齐,避免 SDK 默认 600s 永远跑不到
  });
  legacyAnthropicKey = currentKey;
  return legacyAnthropicClient;
}

async function getLegacyVertexClient(): Promise<AnthropicVertex> {
  const config = getConfig();
  const currentProject = config.vertex.project_id || '';
  if (legacyVertexClient && legacyVertexProject === currentProject) return legacyVertexClient;

  const credPath = path.join(getDataDir(), 'vertex-credentials.json');
  const hasCredFile = fs.existsSync(credPath);

  if (hasCredFile) {
    const { GoogleAuth } = await import('google-auth-library');
    legacyVertexClient = new AnthropicVertex({
      projectId: currentProject || undefined,
      region: config.vertex.region || 'us-central1',
      maxRetries: 0,
      fetch: longRunningFetch, // 见模块顶部 longRunningFetch 注释
      timeout: 1500_000, // 跟 longRunningDispatcher 1500s 对齐
      googleAuth: new GoogleAuth({
        keyFile: credPath,
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
      }),
    });
  } else {
    legacyVertexClient = new AnthropicVertex({
      projectId: currentProject || undefined,
      region: config.vertex.region || 'us-central1',
      maxRetries: 0,
      fetch: longRunningFetch, // 见模块顶部 longRunningFetch 注释
      timeout: 1500_000, // 跟 longRunningDispatcher 1500s 对齐
    });
  }
  legacyVertexProject = currentProject;
  return legacyVertexClient;
}

/** 连接解析结果 */
interface ConnectionInfo {
  client: Anthropic | AnthropicVertex;
  providerType: string;
  geminiApiKey?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  /**
   * cacheKey: 用于 recordCallResult 跟踪连续失败计数,callLLM 失败时累加,
   * 达阈值会 evict 该 entry 触发下次 cache miss 重建 SDK 实例。
   * 非 SDK 路径 (gemini / ollama / openai-compatible) 不参与自愈,留空。
   */
  cacheKey?: string;
}

/** 根据 connection_id 获取或创建 client */
async function getClientByConnection(connectionId: string): Promise<ConnectionInfo> {
  // 查数据库
  if (!usageDb) throw new Error('数据库未初始化');
  const conn = usageDb.prepare('SELECT provider_type, credentials FROM model_connections WHERE id = ?').get(connectionId) as {
    provider_type: string; credentials: string;
  } | undefined;
  if (!conn) throw new Error(`模型连接 ${connectionId} 不存在`);

  // 加 try/catch:credentials 列若被外部修改/损坏(手工 SQL / 迁移 bug),裸 JSON.parse
  // 抛 SyntaxError → callLLM 走的不是 LLMServiceError 分支,scheduler 当作"代码 bug"
  // 让任务 fail 而不进熔断。包装成 LLMServiceError 让熔断逻辑接管。
  let creds: Record<string, string>;
  try {
    creds = JSON.parse(conn.credentials);
  } catch (err) {
    throw new LLMServiceError(`credentials 解析失败 connection=${connectionId}: ${(err as Error).message}`);
  }

  // Gemini 不使用 Anthropic SDK，返回特殊标记
  if (conn.provider_type === 'gemini') {
    return { client: null as unknown as Anthropic, providerType: 'gemini', geminiApiKey: creds.api_key };
  }

  // Ollama LLM 走 OpenAI 兼容端点
  if (conn.provider_type === 'ollama') {
    const baseUrl = (creds.url || 'http://localhost:11434') + '/v1';
    return { client: null as unknown as Anthropic, providerType: 'ollama', openaiBaseUrl: baseUrl };
  }

  // OpenAI Compatible — 规范化 base URL，确保包含 /v1 后缀
  if (conn.provider_type === 'openai-compatible') {
    const baseUrl = normalizeBaseUrl(creds.base_url || '');
    return {
      client: null as unknown as Anthropic,
      providerType: 'openai-compatible',
      openaiBaseUrl: baseUrl,
      openaiApiKey: creds.api_key,
    };
  }

  // 检查缓存:cache key 包含 credentials 指纹,credentials 变了换 cache key
  // F8: Vertex 需要把外部 key file 的 mtime/size 纳入指纹,以便重新上传后失效缓存。
  let credsFp: string;
  let vertexActualPath: string | undefined;
  if (conn.provider_type === 'vertex') {
    const dataDir = getDataDir();
    const credPath = path.join(dataDir, `vertex-credentials-${connectionId}.json`);
    const fallbackPath = path.join(dataDir, 'vertex-credentials.json');
    vertexActualPath = fs.existsSync(credPath) ? credPath : (fs.existsSync(fallbackPath) ? fallbackPath : undefined);
    credsFp = fingerprintCreds(creds, vertexActualPath);
  } else {
    credsFp = fingerprintCreds(creds);
  }
  const cacheKey = `${connectionId}:${credsFp}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return { client: cached, providerType: conn.provider_type, cacheKey };

  // 清掉同 connectionId 的旧 fingerprint entry — daemon 长跑 + 频繁改凭证
  // 会让 Map 持续增长(每个 SDK 实例 ~1 MB)。新 fingerprint 命中前先剔旧。
  for (const k of clientCache.keys()) {
    if (k.startsWith(`${connectionId}:`) && k !== cacheKey) clientCache.delete(k);
  }

  let client: Anthropic | AnthropicVertex;

  if (conn.provider_type === 'anthropic') {
    // maxRetries: 0 → 关闭 SDK 内置重试,详见上方 getLegacyAnthropicClient 注释
    // fetch: longRunningFetch → 见模块顶部注释,避免 undici 60s headersTimeout 截断
    client = new Anthropic({ apiKey: creds.api_key || undefined, maxRetries: 0, fetch: longRunningFetch, timeout: 1500_000 });
  } else if (conn.provider_type === 'vertex') {
    if (vertexActualPath) {
      const { GoogleAuth } = await import('google-auth-library');
      client = new AnthropicVertex({
        projectId: creds.project_id || undefined,
        region: creds.region || 'us-central1',
        maxRetries: 0,
        fetch: longRunningFetch, // 见模块顶部 longRunningFetch 注释
      timeout: 1500_000, // 跟 longRunningDispatcher 1500s 对齐
        googleAuth: new GoogleAuth({
          keyFile: vertexActualPath,
          scopes: 'https://www.googleapis.com/auth/cloud-platform',
        }),
      });
    } else {
      client = new AnthropicVertex({
        projectId: creds.project_id || undefined,
        region: creds.region || 'us-central1',
        maxRetries: 0,
        fetch: longRunningFetch, // 见模块顶部 longRunningFetch 注释
      timeout: 1500_000, // 跟 longRunningDispatcher 1500s 对齐
      });
    }
  } else {
    throw new Error(`不支持的 provider 类型: ${conn.provider_type}`);
  }

  clientCache.set(cacheKey, client);
  return { client, providerType: conn.provider_type, cacheKey };
}

async function getClaudeClient(provider: 'anthropic' | 'vertex'): Promise<Anthropic | AnthropicVertex> {
  return provider === 'vertex' ? await getLegacyVertexClient() : getLegacyAnthropicClient();
}

// ---- Gemini LLM (REST API) ----

async function callGeminiLLM(options: {
  modelId: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  timeoutMs: number;
  apiKeyOverride?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const config = getConfig();
  const apiKey = options.apiKeyOverride || config.gemini.api_key;
  if (!apiKey) throw new Error('Gemini API key 未配置');

  // 用 x-goog-api-key header 而非 ?key= query string,避免 API key 出现在
  // 错误日志、URL 截图或 fetch 错误堆栈里(高危泄漏面)。
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.modelId}:generateContent`;

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
    { role: 'user', parts: [{ text: options.prompt }] },
  ];

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: options.maxTokens,
    },
  };

  if (options.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const fetchSignal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;
  // 用 undiciFetch + longRunningDispatcher,跟 SDK 路径走同一个 dispatcher,
  // 避免 Node 内置 fetch 60s headersTimeout 截断 (Gemini generateContent 是
  // 非流式,大 maxOutputTokens 同样会撞)。详见模块顶部注释。
  const resp = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: fetchSignal,
    dispatcher: longRunningDispatcher,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new LLMServiceError(`Gemini API error: ${resp.status} ${errText}`, resp.status);
  }

  const data = await resp.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  // Gemini 对 safety 拦截返回 HTTP 200 + 空 candidates + promptFeedback.blockReason。
  // 不能当成功返回空串:下游 parseLLMJson('') 静默跳过,且空串会走 recordCallResult(true)
  // + notifyLLMSuccess 污染健康信号,用户看到"零产出但一切正常"。
  const candidate = data.candidates?.[0];
  if (!candidate && data.promptFeedback?.blockReason) {
    throw new LLMServiceError(`Gemini prompt blocked: ${data.promptFeedback.blockReason}`);
  }

  const text = candidate?.content?.parts?.[0]?.text ?? '';
  // 思考模型(2.5/3.x)的内部 thoughts 计入 maxOutputTokens,预算耗尽时
  // finishReason=MAX_TOKENS 且 content.parts 缺失 → 空文本。与 Claude 路径的
  // missing-text-block warn 对齐,留可诊断信号。
  if (!text) {
    log.warn(`Gemini 响应无文本 finishReason=${candidate?.finishReason ?? 'unknown'} blockReason=${data.promptFeedback?.blockReason ?? 'none'}`);
  }
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

  return { text, inputTokens, outputTokens };
}

// ---- OpenAI Compatible LLM (Ollama / vLLM / LM Studio / OpenRouter 等) ----

async function callOpenAICompatibleLLM(options: {
  baseUrl: string;       // 含 /v1，如 http://localhost:11434/v1
  modelId: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  timeoutMs: number;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; thinkingTokens: number }> {
  const url = `${options.baseUrl}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) {
    messages.push({ role: 'system', content: options.system });
  }
  messages.push({ role: 'user', content: options.prompt });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  const oaTimeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const oaFetchSignal = options.signal
    ? AbortSignal.any([oaTimeoutSignal, options.signal])
    : oaTimeoutSignal;
  // 用 undiciFetch + longRunningDispatcher,避免 Node 内置 fetch 60s headersTimeout
  // 截断 (stream: false 非流式,Ollama / LM Studio 等长生成同样会撞)。详见模块顶部注释。
  const resp = await undiciFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.modelId,
      messages,
      max_tokens: options.maxTokens,
      stream: false,
    }),
    signal: oaFetchSignal,
    dispatcher: longRunningDispatcher,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new LLMServiceError(`OpenAI-compatible API error: ${resp.status} ${errText}`, resp.status);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const rawText = data.choices?.[0]?.message?.content ?? '';
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const rawOutputTokens = data.usage?.completion_tokens ?? 0;

  // 提取 <think>...</think> 标签 + 处理 max_tokens 截断在 <think> 内部的孤立形态。
  // 抽到 thinking.ts 让 S8 修复路径可测;行为与旧 inline 实现完全一致。
  const { text, thinkingTokens } = processThinkTags(rawText);
  // 避免下溢:某些 provider 不把 <think> 计入 completion_tokens,thinkingTokens
  // 估算值可能大于 rawOutputTokens。此时把 output 视为 0,thinking 保留。
  const outputTokens = Math.max(0, rawOutputTokens - thinkingTokens);

  return { text, inputTokens, outputTokens, thinkingTokens };
}

// ---- Common ----

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * 按模型档位分层设置 LLM 调用超时（等待模型响应的总时长）。
 *
 * 2026-05-21 重订(60/180/300 → 360/600/1200):
 *   外脑所有 LLM 调用都是后台异步任务(crystal/bridge/embedding 准备/批量回填),
 *   没有用户在 UI 同步等的 chat 形态,**对延迟不敏感**。原 60/180/300 是按
 *   "Haiku/Flash 直调 < 15s / Sonnet 直调 < 60s / Opus thinking < 4min" 的
 *   快路径假设设的;遇到慢 provider 时 light tier 60s 容易撞,放宽余量更稳。
 *
 * 新档位都给极宽余量,P99 不会误杀:
 * - light: 360s 余量
 * - standard: 600s 余量
 * - heavy: 1200s 余量(Opus extended thinking 4-5min 也容得下)
 *
 * 代价:LLM 真挂时 daemon 等的久(light 6min, heavy 20min)才能 abort 触发熔断器。
 * 但外脑熔断器逻辑本来就是按"连续 N 次失败"开,单次 timeout 不致命。
 *
 * 注意:scheduler 本身没有 tick 级 timeout,只依赖这里作为唯一的"等模型响应"
 * 上限。dispatcher (longRunningDispatcher) 的 headersTimeout/bodyTimeout 同步
 * 抬到 1500s(heavy + 5min buffer),改这里时记得同步那边。
 */
export const TIMEOUT_MS_BY_TIER: Record<'light' | 'standard' | 'heavy', number> = {
  light: 360_000,
  standard: 600_000,
  heavy: 1200_000,
};

/**
 * 规范化 OpenAI-compatible base URL：
 *  - 去掉尾部 `/`（无论多少）
 *  - 不以 `/v1` 结尾则追加 `/v1`
 *
 * 抽 export 以便测试 import 真源（避免 inline-copy 漂移）。
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/\/+$/, '');
  return cleaned.endsWith('/v1') ? cleaned : cleaned + '/v1';
}

/**
 * 判断错误是否可重试。
 *
 * 覆盖的超时/中止形态（容易被漏掉）：
 * - `AbortSignal.timeout(ms)` 触发时抛出的 DOMException：name === 'TimeoutError'，
 *   message 形如 "The operation was aborted due to timeout"。
 * - 我们自己用 AbortController + setTimeout 触发的 abort：Claude SDK 路径表现为
 *   `APIUserAbortError`（见下方专属分支），裸 fetch 路径表现为 name === 'AbortError'。
 * - Anthropic SDK 的 `APIConnectionTimeoutError`（status 为 undefined，
 *   所以上面的 `APIError` 分支不一定能命中），以及其父类 `APIConnectionError`。
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return true;
  }
  // APIUserAbortError 必须在 APIError 分支之前分流:它 extends APIError 且
  // status=undefined、name 不是 'AbortError',否则会被下面的 status 判定误判为
  // 不可重试。Claude 路径的 tier 超时(AbortController + setTimeout)经 SDK 抛的
  // 正是这个类——语义上等同 TimeoutError,应重试。外部用户取消同样表现为
  // APIUserAbortError,由 callLLM 在重试判定前用 options.signal.aborted 拦截,
  // 不会走到这里。
  if (err instanceof Anthropic.APIUserAbortError) {
    return true;
  }
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof LLMServiceError) {
    return err.statusCode === 429 || (err.statusCode != null && err.statusCode >= 500);
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    if (msg.includes('aborted due to timeout')) return true;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
  }
  return false;
}

/**
 * 判断错误是否是 LLM 服务级错误(比 isRetryable 范围更广,包含 401/403)。
 *
 * **只看结构化 statusCode / status 字段**,不再对 err.message 做数字正则。
 * 历史上 `/\b(401|403|429|5\d{2})\b/` 会对任何文本里的这些数字误判 —— 比如
 * 连接串里的 `:5432` Postgres port、行号 "line 429"、错误代码里的 500 等都
 * 会触发假阳。同时结构化的 `error_code: rate_limit_exceeded` / 明文
 * `rate_limit_exceeded` 但 HTTP status 缺失的情况又会漏判。
 *
 * 新策略:
 * - `LLMServiceError.statusCode` 有值 → 只对 401/403/429/5xx 判 true
 * - `Anthropic.APIError.status` → 400 视为非服务错误(context overflow 等),其它为 true
 * - 网络/超时类错误(APIConnectionError / TimeoutError / AbortError / ECONNREFUSED 等)
 *   直接 true
 * - 其它 Error 一律 false(由 scheduler 的 circuit breaker 以别的信号感知)
 */
export function isServiceError(err: unknown): boolean {
  // 网络/超时类错误一律视为服务级错误(进熔断器)
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return true;
  }
  if (err instanceof Anthropic.APIError) {
    // 400 含 context overflow / 输入格式错误 —— 不是服务不可用,不要打熔断器
    if (err.status === 400) return false;
    return true;
  }
  if (err instanceof LLMServiceError) {
    const code = err.statusCode;
    if (code === undefined) {
      // 无 status 的 LLMServiceError 通常是 provider 侧字符串错误(例如 Ollama "not ok"),
      // 我们在抛出时已经显式包装,保守视为服务错误。
      return true;
    }
    return code === 401 || code === 403 || code === 429 || code >= 500;
  }
  if (err instanceof Error) {
    const msg = err.message;
    // 超时 / abort —— AbortSignal.timeout 产生的 DOMException 和我们手动 abort 的都算
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    if (msg.includes('aborted due to timeout')) return true;
    // 典型的 Node 网络错误 code/子串 —— 这些不会和"消息里刚好含数字"混淆
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
  }
  return false;
}

function getErrorStatus(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError) return err.status;
  return undefined;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('LLM call aborted'));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('LLM call aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 判断模型是否已移除 manual extended thinking。
 *
 * API 事实(Anthropic 迁移文档): Opus 4.7 及之后(4.8、Fable 系列)发送
 * thinking:{type:'enabled', budget_tokens} 直接 400 invalid_request_error,
 * 只接受 adaptive。Opus 4.6 / Sonnet 4.6 上 budget_tokens 处于 deprecated
 * 过渡期仍可用,不在此列。用户自定义模型配置 + 策略 thinking_mode=manual 的
 * 组合会踩这个 400,callLLM 据此降级为 adaptive 而不是让任务永久失败。
 */
export function manualThinkingUnsupported(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes('claude-fable')) return true;
  const m = id.match(/claude-opus-(\d+)-(\d+)/);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 4 || (major === 4 && minor >= 7);
  }
  return false;
}

function logUsage(
  route: ResolvedLLMRoute,
  actualModel: string | null,
  operationName: string | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
  thinkingTokens: number | null,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
  reasoningTokens = 0,
): void {
  if (!usageDb) return;
  try {
    const pricedModel = actualModel ?? route.modelAlias;
    let estimatedCost: number | null = null;
    let estimatedCostKind: 'api_estimate' | 'api_equivalent' | 'not_applicable' | 'unavailable';
    let pricingTableVersion: string | null = null;
    if (route.billingMode === 'local_compute') {
      estimatedCostKind = 'not_applicable';
    } else if (inputTokens === null || outputTokens === null || thinkingTokens === null) {
      estimatedCostKind = 'unavailable';
    } else {
      const estimate = estimateVersionedCost(
        pricedModel,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheCreateTokens,
        cacheReadTokens,
      );
      estimatedCost = estimate.estimatedCost;
      estimatedCostKind = estimate.kind === 'unavailable'
        ? 'unavailable'
        : route.billingMode === 'account_cli'
          ? 'api_equivalent'
          : 'api_estimate';
      pricingTableVersion = estimate.pricingTableVersion;
    }
    // created 统一走 JS ISO：下游 initialization.ts 用 `created >= ?` 和 ISO 字符串
    // 比较，若写 datetime('now') 字面量(无 Z、空格分隔)字符串序会错乱。
    //
    // input_tokens 列记完整 prompt 规模:Anthropic 的 usage.input_tokens 只是未缓存
    // 余量,prompt caching 命中时大头在 cache_creation/cache_read 两项,不折算进去
    // 用量面板的 token 数会系统性低估。成本已按 write 1.25x / read 0.1x 分档折算。
    usageDb.prepare(
      `INSERT INTO llm_usage_log (
        model, operation, input_tokens, output_tokens, thinking_tokens,
        estimated_cost, provider_type, connection_id, connection_name_snapshot,
        source_type, billing_mode, estimated_cost_kind, pricing_table_version,
        provider_reported_cost, provider_reported_cost_kind,
        cached_input_tokens, reasoning_tokens, invocation_outcome, created
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'success', ?)`
    ).run(
      pricedModel,
      operationName ?? null,
      inputTokens ?? 0,
      outputTokens ?? 0,
      thinkingTokens ?? 0,
      estimatedCost,
      route.providerType,
      route.connectionId,
      route.connectionName,
      route.sourceType,
      route.billingMode,
      estimatedCostKind,
      pricingTableVersion,
      cacheCreateTokens + cacheReadTokens,
      reasoningTokens,
      now(),
    );
  } catch { /* 用量记录失败不影响主流程 */ }
}

function healthErrorFrom(error: unknown): {
  kind: LLMConnectionErrorKind;
  message: string;
  needsUserAction?: boolean;
  retryAt?: number | null;
} {
  if (error instanceof CliLLMError) {
    const supportedKinds = new Set<LLMConnectionErrorKind>([
      'not_installed',
      'unsupported_version',
      'not_authenticated',
      'wrong_auth_method',
      'quota',
      'rate_limit',
      'capacity',
      'model_unavailable',
      'permission_policy',
      'timeout',
      'aborted',
      'ambiguous_outcome',
      'process_crash',
      'protocol',
      'transient',
    ]);
    return {
      kind: supportedKinds.has(error.kind as LLMConnectionErrorKind)
        ? error.kind as LLMConnectionErrorKind
        : 'protocol',
      message: error.message,
      needsUserAction: error.options.needsUserAction,
      retryAt: error.options.retryAt ?? null,
    };
  }
  const status = getErrorStatus(error);
  const message = (error as Error)?.message ?? String(error);
  if (status === 401 || status === 403) {
    return { kind: 'not_authenticated', message, needsUserAction: true };
  }
  if (status === 429) return { kind: 'rate_limit', message };
  if (/abort/i.test((error as Error)?.name ?? '')) return { kind: 'aborted', message };
  if (/timeout|timed out|UND_ERR_HEADERS_TIMEOUT/i.test(message)) {
    return { kind: 'timeout', message };
  }
  return { kind: 'transient', message };
}

export function recordConnectionSuccessBestEffort(
  db: Database.Database,
  event: LLMCallEvent,
  providerLabel: string,
): void {
  try {
    recordConnectionSuccess(db, event);
  } catch (error) {
    log.error(`${providerLabel} 调用已完成，但连接健康状态记录失败: ${(error as Error).message}`);
  }
}

export async function callLLM(options: {
  prompt: string;
  system?: string;
  model?: 'light' | 'standard' | 'heavy';
  maxTokens?: number;
  /**
   * thinking 配置。两种形态:
   * - { mode: 'adaptive' }                  让模型自己决定推理深度(Opus 4.6+ 推荐)
   * - { mode: 'manual', budget }            手动指定 thinking token 预算
   * - { budget }                            兼容旧形态,等同于 manual
   */
  thinking?: { mode?: 'manual' | 'adaptive'; budget?: number };
  operationName?: string;
  /**
   * 外部 abort signal。设置后用户 abort 会立即取消正在飞行的 LLM 网络请求。
   * 与内部超时 controller 通过 AbortSignal.any 合并：任一触发都会中止请求。
   */
  signal?: AbortSignal;
}): Promise<string> {
  if (llmRuntimeStopping) {
    throw new Error('LLM runtime is shutting down');
  }
  // 调用前先检查外部 signal——避免在已 abort 状态下还发起一次完整的 LLM 调用
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('LLM call aborted');
  }
  const runtimeAbortController = new AbortController();
  const callSignal = options.signal
    ? AbortSignal.any([options.signal, runtimeAbortController.signal])
    : runtimeAbortController.signal;
  const config = getConfig();
  const tier = options.model ?? 'standard';
  const route = resolveLLMRoute(tier, usageDb);
  assertRouteCallable(route);
  const routeIsCli = route.providerType === 'claude-cli' || route.providerType === 'codex-cli';
  const probeAttempts = routeIsCli ? 1 : MAX_RETRIES;
  const probeLeaseMs = (
    TIMEOUT_MS_BY_TIER[tier] * probeAttempts
    + (probeAttempts - 1) * 600_000
    + 60_000
  );
  const healthProbeToken = usageDb
    ? assertConnectionHealthCallable(
        usageDb,
        route.scopeId,
        Date.now(),
        probeLeaseMs,
      )
    : null;
  activeCallAbortControllers.add(runtimeAbortController);
  try {
  noteActiveLLMRoute(tier, route.connectionId);
  const modelId = route.modelAlias;
  const connectionId = route.connectionId;
  const provider = route.providerType;

  const maxTokens = options.maxTokens ?? 2048;

  // 全局注入时间上下文 — 所有 LLM 调用都获得时间感知能力。
  //
  // 关键:不要把 timeStr 拼进 `system` 字符串然后整块打 cache_control ——
  // 每分钟刷新一次的时间会让 cache key 每次都变,命中率永远是 0。
  // Claude 路径专门把 stable system(带 cache)和 time 后缀(不带 cache)拆开,
  // 见下方 systemField 构造。对 Gemini / OpenAI-compatible 这些没有
  // prompt-cache 语义的 provider,仍然按单一字符串传(拼接成 stableSystem + time)。
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = new Date().toLocaleString('zh-CN', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const timeSuffix = `[系统时间: ${timeStr}, 时区: ${tz}]`;
  const stableSystem = options.system ?? '';
  // 给非 Claude provider 用的完整 system 字符串(拼接形态)
  const system = stableSystem ? stableSystem + '\n\n' + timeSuffix : timeSuffix;

  // 解析实际使用的 provider 类型和 client（connection 优先，循环外一次性解析）
  let resolvedProvider = provider;
  let resolvedGeminiApiKey: string | undefined;
  let resolvedOpenaiBaseUrl: string | undefined;
  let resolvedOpenaiApiKey: string | undefined;
  let resolvedClient: Anthropic | AnthropicVertex | null = null;
  let resolvedCacheKey: string | null = null;
  if (
    connectionId
    && resolvedProvider !== 'claude-cli'
    && resolvedProvider !== 'codex-cli'
  ) {
      const connInfo = await getClientByConnection(connectionId);
      resolvedProvider = connInfo.providerType as typeof provider;
      resolvedGeminiApiKey = connInfo.geminiApiKey;
      resolvedOpenaiBaseUrl = connInfo.openaiBaseUrl;
      resolvedOpenaiApiKey = connInfo.openaiApiKey;
      resolvedClient = connInfo.client;
      resolvedCacheKey = connInfo.cacheKey ?? null;
  }

  const timeoutMs = TIMEOUT_MS_BY_TIER[tier];

  let lastError: unknown;
  const callStart = Date.now();
  log.debug(`调用 model=${modelId} provider=${resolvedProvider} connection=${connectionId ?? 'legacy'} op=${options.operationName ?? 'unknown'} tier=${tier} timeoutMs=${timeoutMs} promptLen=${options.prompt.length}`);

  const isCliProvider = resolvedProvider === 'claude-cli' || resolvedProvider === 'codex-cli';
  const maxAttempts = isCliProvider ? 1 : MAX_RETRIES;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (callSignal.aborted) {
        throw callSignal.reason ?? new Error('LLM call aborted');
      }
      // ---- 本机订阅 CLI 路径（固定单次，不套 HTTP retry） ----
      if (resolvedProvider === 'claude-cli' || resolvedProvider === 'codex-cli') {
        if (!usageDb || !connectionId) {
          throw new CliLLMError('protocol', '本机订阅连接数据库尚未初始化');
        }
        const result = await runCliLLM(usageDb, getDataDir(), {
          connectionId,
          providerType: resolvedProvider,
          modelAlias: modelId,
          system,
          prompt: options.prompt,
          maxOutputTokens: maxTokens,
          thinking: options.thinking,
          timeoutMs,
          operationName: options.operationName,
          signal: callSignal,
          purpose: 'background',
        });
        try {
          logUsage(
            route,
            result.actualModel,
            options.operationName,
            result.inputTokens,
            result.outputTokens,
            0,
            0,
            result.cachedInputTokens ?? 0,
            result.reasoningTokens ?? 0,
          );
        } catch (error) {
          log.error(`CLI 调用已完成，但用量记录失败: ${(error as Error).message}`);
        }
        const event: LLMCallEvent = {
          scopeId: route.scopeId,
          connectionId,
          providerType: route.providerType,
          modelAlias: modelId,
          actualModel: result.actualModel,
          outcome: 'success',
          probeToken: healthProbeToken,
        };
        recordConnectionSuccessBestEffort(usageDb, event, 'CLI');
        log.debug(`完成 CLI op=${options.operationName ?? 'unknown'} model=${result.actualModel ?? modelId} 耗时=${Date.now() - callStart}ms`);
        return result.text;
      }

      // ---- Gemini 路径 ----
      if (resolvedProvider === 'gemini') {
        const geminiOpts: Parameters<typeof callGeminiLLM>[0] = {
          modelId, prompt: options.prompt, system, maxTokens, timeoutMs,
          signal: callSignal,
        };
        if (resolvedGeminiApiKey) {
          geminiOpts.apiKeyOverride = resolvedGeminiApiKey;
        }
        const result = await callGeminiLLM(geminiOpts);
        logUsage(route, modelId, options.operationName, result.inputTokens, result.outputTokens, 0);
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} 耗时=${Date.now() - callStart}ms`);
        recordCallResult(resolvedCacheKey, true);
        if (usageDb) {
          recordConnectionSuccessBestEffort(usageDb, {
              scopeId: route.scopeId,
              connectionId: route.connectionId,
              providerType: route.providerType,
              modelAlias: modelId,
              actualModel: modelId,
              outcome: 'success',
              probeToken: healthProbeToken,
            }, 'Gemini');
        }
        if (route.connectionId === null) notifyLLMSuccess();
        return result.text;
      }

      // ---- OpenAI Compatible 路径（Ollama / openai-compatible） ----
      if (resolvedProvider === 'ollama' || resolvedProvider === 'openai-compatible') {
        if (!resolvedOpenaiBaseUrl) {
          throw new LLMServiceError(`OpenAI-compatible base URL 未配置 (provider=${resolvedProvider})`);
        }
        const result = await callOpenAICompatibleLLM({
          baseUrl: resolvedOpenaiBaseUrl,
          modelId,
          prompt: options.prompt,
          system,
          maxTokens,
          timeoutMs,
          apiKey: resolvedOpenaiApiKey,
          signal: callSignal,
        });
        logUsage(
          route,
          modelId,
          options.operationName,
          result.inputTokens,
          result.outputTokens,
          result.thinkingTokens,
        );
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} thinking=${result.thinkingTokens} 耗时=${Date.now() - callStart}ms`);
        recordCallResult(resolvedCacheKey, true);
        if (usageDb) {
          recordConnectionSuccessBestEffort(usageDb, {
              scopeId: route.scopeId,
              connectionId: route.connectionId,
              providerType: route.providerType,
              modelAlias: modelId,
              actualModel: modelId,
              outcome: 'success',
              probeToken: healthProbeToken,
            }, 'OpenAI-compatible');
        }
        if (route.connectionId === null) notifyLLMSuccess();
        return result.text;
      }

      // ---- Claude 路径（Anthropic / Vertex） ----
      const client = resolvedClient ?? await getClaudeClient(resolvedProvider as 'anthropic' | 'vertex');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // 合并内部超时 signal 与外部 abort signal：任一触发都中止请求
      const signalForCall: AbortSignal = AbortSignal.any([controller.signal, callSignal]);

      try {
        // thinking 配置:adaptive 不传 budget,manual 传 budget,否则关闭
        const thinkingOpt = options.thinking;
        let isAdaptive = thinkingOpt?.mode === 'adaptive';
        const thinkingBudget = thinkingOpt?.budget;
        let useManualThinking = !isAdaptive && thinkingBudget !== undefined && thinkingBudget > 0;
        // Opus 4.7+/Fable 已移除 manual thinking(budget_tokens → 400),manual 配置
        // 在这些模型上必然失败且 400 不进熔断器、不会自愈——降级为 adaptive 兜底。
        if (useManualThinking && manualThinkingUnsupported(modelId)) {
          if (attempt === 0) {
            log.warn(`model=${modelId} 不支持 manual extended thinking(budget_tokens 会 400),已降级为 adaptive op=${options.operationName ?? 'unknown'}`);
          }
          useManualThinking = false;
          isAdaptive = true;
        }
        if (isAdaptive && thinkingBudget !== undefined && thinkingBudget > 0 && thinkingOpt?.mode === 'adaptive') {
          log.debug(`adaptive thinking 模式忽略传入的 budget=${thinkingBudget}（由模型自决推理深度）`);
        }
        const ADAPTIVE_THINKING_RESERVE = 8192; // adaptive 模式给 max_tokens 加的兜底
        // Anthropic 要求 budget_tokens **严格小于** max_tokens。此前用
        // `maxTokens + budget` 得到 max_tokens == budget_tokens 的等值,会触发
        // 400 invalid_request_error。+1 保证严格小于,又不改变用户传入的 maxTokens 语义。
        const adjustedMaxTokens = useManualThinking
          ? maxTokens + (thinkingBudget ?? 0) + 1
          : isAdaptive
          ? maxTokens + ADAPTIVE_THINKING_RESERVE
          : maxTokens;

        // prompt caching:对 *稳定* system 前缀加 cache_control,时间后缀另起一个
        // 不带 cache_control 的 text block。
        //
        // 为什么必须拆分:Anthropic ephemeral cache 的 key 是带 cache_control 的
        // 那个 block 的完整文本。若把每分钟都变的 timeStr 拼进该 block,cache 永远 miss。
        // 拆开后,stable 前缀复用命中,时间变动只影响末尾小 block(不参与 cache 计算)。
        const cacheEnabled = config.llm.prompt_cache_enabled !== false;
        let systemField: Anthropic.MessageCreateParamsNonStreaming['system'];
        if (cacheEnabled && stableSystem) {
          systemField = [
            { type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: timeSuffix },
          ];
        } else if (cacheEnabled && !stableSystem) {
          // 没有用户 system → 只有时间后缀,不值得缓存,直接走字符串形态
          systemField = timeSuffix;
        } else {
          // 缓存关闭 → 单字符串形态,内含时间后缀
          systemField = system;
        }

        const thinkingField = useManualThinking
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget! } }
          : isAdaptive
          ? { thinking: { type: 'adaptive' as const } }
          : {};

        const createParams: Anthropic.MessageCreateParamsNonStreaming = {
          model: modelId,
          max_tokens: adjustedMaxTokens,
          system: systemField,
          messages: [{ role: 'user', content: options.prompt }],
          ...thinkingField,
        };

        const response = await client.messages.create(
          createParams,
          { signal: signalForCall },
        );

        const cacheCreate = (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
        const cacheRead = (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
        // thinking tokens 包含在 output_tokens 中，无独立计数字段。
        // cache 两项必须入账:input_tokens 只是未缓存余量,prompt cache 默认开启时
        // 漏记会让用量面板与成本估算系统性低估(write 1.25x / read 0.1x 计费,非 0)。
        logUsage(
          route,
          response.model,
          options.operationName,
          response.usage.input_tokens,
          response.usage.output_tokens,
          0,
          cacheCreate,
          cacheRead,
        );
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${response.usage.input_tokens}+${response.usage.output_tokens} cache_create=${cacheCreate} cache_read=${cacheRead} 耗时=${Date.now() - callStart}ms`);
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock) {
          log.warn(`LLM 响应不含 text block op=${options.operationName ?? 'unknown'} blocks=${response.content.map(b => b.type).join(',')}`);
        }
        recordCallResult(resolvedCacheKey, true);
        if (usageDb) {
          recordConnectionSuccessBestEffort(usageDb, {
              scopeId: route.scopeId,
              connectionId: route.connectionId,
              providerType: route.providerType,
              modelAlias: modelId,
              actualModel: response.model,
              outcome: 'success',
              probeToken: healthProbeToken,
            }, 'Anthropic/Vertex');
        }
        if (route.connectionId === null) notifyLLMSuccess();
        return textBlock ? textBlock.text : '';
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      // 外部 signal 已 abort(用户取消):SDK 会丢弃自定义 reason 抛 APIUserAbortError,
      // 裸 fetch 路径抛的形态也不稳定。这里统一还原成外部 reason 原样上抛(与函数
      // 入口的 pre-call 检查语义对齐),不重试、不计失败、不包装成 LLMServiceError——
      // 否则上游(init-session 等)会把"用户取消"误判成服务故障。
      if (callSignal.aborted) {
        throw options.signal?.aborted
          ? options.signal.reason ?? err
          : callSignal.reason ?? err;
      }
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) break;

      // 指数退避 + 抖动,避免 thundering herd
      const backoffMs = BASE_DELAY_MS * Math.pow(2, attempt);
      const jitterMs = Math.floor(Math.random() * BASE_DELAY_MS);
      let waitMs = backoffMs + jitterMs;
      if (err instanceof Anthropic.APIError && err.status === 429) {
        // Retry-After 既可能是数字秒("60"),也可能是 HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
        const retryAfter = (err.headers as Record<string, string> | undefined)?.['retry-after'];
        let retryMs = 0;
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter, 10);
          if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
            retryMs = retrySeconds * 1000;
          } else {
            const parsedDate = Date.parse(retryAfter);
            if (Number.isFinite(parsedDate)) {
              retryMs = Math.max(0, parsedDate - Date.now());
            }
          }
          // 兜底封顶 600s(跟 standard tier 新值 600s 对齐)。原 180s 上限在
          // standard tier 抬到 600s 后会让"标准 tier 任务的 Anthropic
          // retry-after"被截断,触发提前重试再次 429。服务器明确指令 > 我们的
          // 保守假设。
          // 2026-05-21:从 180_000 → 600_000,跟 TIMEOUT_MS_BY_TIER.standard 对齐。
          retryMs = Math.min(retryMs, 600_000);
        }
        if (retryMs > 0) waitMs = Math.max(waitMs, retryMs);
      }

      // 失败诊断: 把 err.cause?.code 也打出来。Anthropic SDK 把 fetch 错误包装成
      // `Connection error.` 抹掉细节,但 cause 链通常保留 undici 的错误码
      // (UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT / UND_ERR_CONNECT_TIMEOUT
      //  / ECONNRESET / ETIMEDOUT 等),光看 message 完全分辨不了真网络错 vs
      // headersTimeout 之类 client-side abort。2026-05-21 问题 A 就是因为
      // 没打 cause.code 调试浪费了好几个小时。
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const causeInfo = cause?.code ? ` cause.code=${cause.code}` : '';
      log.warn(`请求失败 (attempt ${attempt + 1}/${maxAttempts}) ${waitMs}ms 后重试: ${(err as Error).message}${causeInfo}`);
      await abortableDelay(waitMs, callSignal);
    }
  }

  const finalCause = (lastError as { cause?: { code?: string } }).cause;
  const finalCauseInfo = finalCause?.code ? ` cause.code=${finalCause.code}` : '';
  log.error(`调用失败 (重试用尽) op=${options.operationName ?? 'unknown'}: ${(lastError as Error)?.message}${finalCauseInfo}`);

  // 记录失败累计;>= FAILURE_RESET_THRESHOLD 时 evict cache entry,下次重建 SDK 实例
  // (避免 SDK 内部状态损坏后 daemon 无法自愈)。详见 recordCallResult 注释。
  const evicted = recordCallResult(resolvedCacheKey, false);
  if (evicted) {
    log.warn(`LLM client 连续失败 ${FAILURE_RESET_THRESHOLD} 次,已 evict cache entry connection=${connectionId},下次调用将重建 SDK 实例`);
  }

  if (usageDb && lastError) {
    const healthError = healthErrorFrom(lastError);
    try {
      recordConnectionFailure(usageDb, {
        scopeId: route.scopeId,
        connectionId: route.connectionId,
        providerType: route.providerType,
        modelAlias: route.modelAlias,
        outcome: healthError.kind === 'ambiguous_outcome'
          ? 'ambiguous'
          : healthError.kind === 'aborted'
            ? 'aborted'
            : healthError.kind === 'capacity'
              ? 'capacity_deferred'
              : 'definite_failure',
        error: healthError,
        probeToken: healthProbeToken,
      });
    } catch (error) {
      log.error(`LLM 调用已失败，连接健康状态记录也失败: ${(error as Error).message}`);
    }
  }

  if (lastError instanceof CliLLMError) throw lastError;

  // 包装为 LLMServiceError，便于 scheduler 区分
  if (isServiceError(lastError)) {
    throw new LLMServiceError(
      (lastError as Error).message,
      getErrorStatus(lastError),
      route.connectionId,
    );
  }
  throw lastError;
  } finally {
    activeCallAbortControllers.delete(runtimeAbortController);
    if (activeCallAbortControllers.size === 0) {
      for (const resolve of activeCallDrainWaiters) resolve();
      activeCallDrainWaiters.clear();
    }
    if (usageDb && healthProbeToken) {
      try {
        releaseConnectionHealthProbe(usageDb, route.scopeId, healthProbeToken);
      } catch (error) {
        log.warn(`half-open probe lease cleanup failed: ${(error as Error).message}`);
      }
    }
  }
}
