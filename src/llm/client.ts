import Anthropic from '@anthropic-ai/sdk';
import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { estimateCost } from './pricing.js';
import { now } from '../utils/time.js';
import { processThinkTags } from './thinking.js';

const log = createLogger('llm');

/**
 * LLM 服务级错误：429 限流、5xx 服务端错误、401/403 认证、网络错误。
 * 与任务自身逻辑错误区分——只有此类错误应触发熔断器。
 */
export class LLMServiceError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
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
 * 清理 LLM client 缓存。配置/凭证变更时调用,避免下次请求继续用过期 client。
 * 没有副作用 — Anthropic SDK 实例不持有连接,直接 GC 即可。
 */
export function clearClientCache(): void {
  clientCache.clear();
  legacyAnthropicClient = null;
  legacyVertexClient = null;
  legacyAnthropicKey = '';
  legacyVertexProject = '';
}

function fingerprintCreds(obj: unknown): string {
  // 稳定指纹:对 JSON 序列化后取 SHA256 前 12 位 hex(等价于 48 bit 抗碰撞,
  // 单台 Mac 上几乎不可能撞)。不暴露原 key,纯粹用作 cache key 区分。
  const s = JSON.stringify(obj ?? {});
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
    const rawUrl = (creds.base_url || '').replace(/\/+$/, '');
    const baseUrl = rawUrl.endsWith('/v1') ? rawUrl : rawUrl + '/v1';
    return {
      client: null as unknown as Anthropic,
      providerType: 'openai-compatible',
      openaiBaseUrl: baseUrl,
      openaiApiKey: creds.api_key,
    };
  }

  // 检查缓存:cache key 包含 credentials 指纹,credentials 变了换 cache key
  const credsFp = fingerprintCreds(creds);
  const cacheKey = `${connectionId}:${credsFp}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return { client: cached, providerType: conn.provider_type };

  // 清掉同 connectionId 的旧 fingerprint entry — daemon 长跑 + 频繁改凭证
  // 会让 Map 持续增长(每个 SDK 实例 ~1 MB)。新 fingerprint 命中前先剔旧。
  for (const k of clientCache.keys()) {
    if (k.startsWith(`${connectionId}:`) && k !== cacheKey) clientCache.delete(k);
  }

  let client: Anthropic | AnthropicVertex;

  if (conn.provider_type === 'anthropic') {
    // maxRetries: 0 → 关闭 SDK 内置重试,详见上方 getLegacyAnthropicClient 注释
    client = new Anthropic({ apiKey: creds.api_key || undefined, maxRetries: 0 });
  } else if (conn.provider_type === 'vertex') {
    const dataDir = getDataDir();
    // 优先使用按 connectionId 命名的凭证文件，回退到全局
    const credPath = path.join(dataDir, `vertex-credentials-${connectionId}.json`);
    const fallbackPath = path.join(dataDir, 'vertex-credentials.json');
    const actualPath = fs.existsSync(credPath) ? credPath : fallbackPath;

    if (fs.existsSync(actualPath)) {
      const { GoogleAuth } = await import('google-auth-library');
      client = new AnthropicVertex({
        projectId: creds.project_id || undefined,
        region: creds.region || 'us-central1',
        maxRetries: 0,
        googleAuth: new GoogleAuth({
          keyFile: actualPath,
          scopes: 'https://www.googleapis.com/auth/cloud-platform',
        }),
      });
    } else {
      client = new AnthropicVertex({
        projectId: creds.project_id || undefined,
        region: creds.region || 'us-central1',
        maxRetries: 0,
      });
    }
  } else {
    throw new Error(`不支持的 provider 类型: ${conn.provider_type}`);
  }

  clientCache.set(cacheKey, client);
  return { client, providerType: conn.provider_type };
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
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: fetchSignal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new LLMServiceError(`Gemini API error: ${resp.status} ${errText}`, resp.status);
  }

  const data = await resp.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.modelId,
      messages,
      max_tokens: options.maxTokens,
      stream: false,
    }),
    signal: oaFetchSignal,
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
 * 数值给足余量，避免在真实世界的 P99 情况下误杀正常请求：
 * - light: Haiku/Flash 通常 < 15s，给 60s 缓冲网络抖动。
 * - standard: Sonnet + 长输入（如 15k tokens）+ thinking 可到 2 分钟。
 * - heavy: Opus + extended thinking 有时 4-5 分钟才返回。
 *
 * 注意：scheduler 本身没有 tick 级 timeout，只依赖这里作为唯一的
 * "等模型响应" 上限。不要去掉或调低这些值，除非你确定下游 daemon
 * 有其他兜底机制。
 */
const TIMEOUT_MS_BY_TIER: Record<'light' | 'standard' | 'heavy', number> = {
  light: 60_000,
  standard: 180_000,
  heavy: 300_000,
};

/**
 * 判断错误是否可重试。
 *
 * 覆盖的超时/中止形态（容易被漏掉）：
 * - `AbortSignal.timeout(ms)` 触发时抛出的 DOMException：name === 'TimeoutError'，
 *   message 形如 "The operation was aborted due to timeout"。
 * - 我们自己用 AbortController + setTimeout 触发的 abort：name === 'AbortError'。
 * - Anthropic SDK 的 `APIConnectionTimeoutError`（status 为 undefined，
 *   所以上面的 `APIError` 分支不一定能命中），以及其父类 `APIConnectionError`。
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) {
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
function isServiceError(err: unknown): boolean {
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logUsage(modelId: string, operationName: string | undefined, inputTokens: number, outputTokens: number, thinkingTokens: number): void {
  if (!usageDb) return;
  try {
    const cost = estimateCost(modelId, inputTokens, outputTokens, thinkingTokens);
    // created 统一走 JS ISO：下游 initialization.ts 用 `created >= ?` 和 ISO 字符串
    // 比较，若写 datetime('now') 字面量(无 Z、空格分隔)字符串序会错乱。
    usageDb.prepare(
      `INSERT INTO llm_usage_log (model, operation, input_tokens, output_tokens, thinking_tokens, estimated_cost, created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(modelId, operationName ?? null, inputTokens, outputTokens, thinkingTokens, cost, now());
  } catch { /* 用量记录失败不影响主流程 */ }
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
  // 调用前先检查外部 signal——避免在已 abort 状态下还发起一次完整的 LLM 调用
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('LLM call aborted');
  }
  const config = getConfig();
  const tier = options.model ?? 'standard';
  const modelId = tier === 'heavy' ? config.llm.heavy_model
    : tier === 'light' ? config.llm.light_model
    : config.llm.standard_model;

  // 优先使用 connection_id 路径
  const connectionId = tier === 'heavy'
    ? config.llm.heavy_connection
    : tier === 'light'
    ? config.llm.light_connection
    : config.llm.standard_connection;

  // 回退到旧的 provider 路径
  const provider = tier === 'heavy'
    ? (config.llm.heavy_provider ?? config.llm.provider ?? 'anthropic')
    : tier === 'light'
    ? (config.llm.light_provider ?? config.llm.provider ?? 'anthropic')
    : (config.llm.standard_provider ?? config.llm.provider ?? 'anthropic');

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
  if (connectionId) {
    try {
      const connInfo = await getClientByConnection(connectionId);
      resolvedProvider = connInfo.providerType as typeof provider;
      resolvedGeminiApiKey = connInfo.geminiApiKey;
      resolvedOpenaiBaseUrl = connInfo.openaiBaseUrl;
      resolvedOpenaiApiKey = connInfo.openaiApiKey;
      resolvedClient = connInfo.client;
    } catch (err) {
      log.warn(`连接 ${connectionId} 查找失败，回退到 provider=${provider}: ${(err as Error).message}`);
    }
  }

  const timeoutMs = TIMEOUT_MS_BY_TIER[tier];

  let lastError: unknown;
  const callStart = Date.now();
  log.debug(`调用 model=${modelId} provider=${resolvedProvider} connection=${connectionId ?? 'legacy'} op=${options.operationName ?? 'unknown'} tier=${tier} timeoutMs=${timeoutMs} promptLen=${options.prompt.length}`);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // ---- Gemini 路径 ----
      if (resolvedProvider === 'gemini') {
        const geminiOpts: Parameters<typeof callGeminiLLM>[0] = {
          modelId, prompt: options.prompt, system, maxTokens, timeoutMs,
          signal: options.signal,
        };
        if (resolvedGeminiApiKey) {
          geminiOpts.apiKeyOverride = resolvedGeminiApiKey;
        }
        const result = await callGeminiLLM(geminiOpts);
        logUsage(modelId, options.operationName, result.inputTokens, result.outputTokens, 0);
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} 耗时=${Date.now() - callStart}ms`);
        notifyLLMSuccess();
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
          signal: options.signal,
        });
        logUsage(modelId, options.operationName, result.inputTokens, result.outputTokens, result.thinkingTokens);
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} thinking=${result.thinkingTokens} 耗时=${Date.now() - callStart}ms`);
        notifyLLMSuccess();
        return result.text;
      }

      // ---- Claude 路径（Anthropic / Vertex） ----
      const client = resolvedClient ?? await getClaudeClient(resolvedProvider as 'anthropic' | 'vertex');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // 合并内部超时 signal 与外部 abort signal：任一触发都中止请求
      const signalForCall: AbortSignal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;

      try {
        // thinking 配置:adaptive 不传 budget,manual 传 budget,否则关闭
        const thinkingOpt = options.thinking;
        const isAdaptive = thinkingOpt?.mode === 'adaptive';
        const thinkingBudget = thinkingOpt?.budget;
        const useManualThinking = !isAdaptive && thinkingBudget !== undefined && thinkingBudget > 0;
        if (isAdaptive && thinkingBudget !== undefined && thinkingBudget > 0) {
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

        // thinking tokens 包含在 output_tokens 中，无独立计数字段
        logUsage(modelId, options.operationName,
          response.usage.input_tokens, response.usage.output_tokens, 0);

        // cache_creation/read 仅做 debug 观测,不入库(用户日志可见命中情况即可)
        const cacheCreate = (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
        const cacheRead = (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${response.usage.input_tokens}+${response.usage.output_tokens} cache_create=${cacheCreate} cache_read=${cacheRead} 耗时=${Date.now() - callStart}ms`);
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock) {
          log.warn(`LLM 响应不含 text block op=${options.operationName ?? 'unknown'} blocks=${response.content.map(b => b.type).join(',')}`);
        }
        notifyLLMSuccess();
        return textBlock ? textBlock.text : '';
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) break;

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
          // 兜底封顶 180s(标准 tier timeout 量级)。原 60s 上限会让 Anthropic
          // 返回的 120s "retry-after" 被截断到 60s,触发提前重试再次 429。
          // 服务器明确指令 > 我们对超时的保守假设。
          retryMs = Math.min(retryMs, 180_000);
        }
        if (retryMs > 0) waitMs = Math.max(waitMs, retryMs);
      }

      log.warn(`请求失败 (attempt ${attempt + 1}/${MAX_RETRIES}) ${waitMs}ms 后重试: ${(err as Error).message}`);
      await delay(waitMs);
    }
  }

  log.error(`调用失败 (重试用尽) op=${options.operationName ?? 'unknown'}: ${(lastError as Error)?.message}`);
  // 包装为 LLMServiceError，便于 scheduler 区分
  if (isServiceError(lastError)) {
    throw new LLMServiceError((lastError as Error).message, getErrorStatus(lastError));
  }
  throw lastError;
}
