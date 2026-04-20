import Anthropic from '@anthropic-ai/sdk';
import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { estimateCost } from './pricing.js';

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

// ---- Client 缓存（按 connection_id） ----

const clientCache = new Map<string, Anthropic | AnthropicVertex>();

// 旧的全局单例（向后兼容无 connection 路径）
let legacyAnthropicClient: Anthropic | null = null;
let legacyVertexClient: AnthropicVertex | null = null;

function getLegacyAnthropicClient(): Anthropic {
  if (legacyAnthropicClient) return legacyAnthropicClient;
  const config = getConfig();
  legacyAnthropicClient = new Anthropic({
    apiKey: config.anthropic.api_key || undefined,
  });
  return legacyAnthropicClient;
}

async function getLegacyVertexClient(): Promise<AnthropicVertex> {
  if (legacyVertexClient) return legacyVertexClient;
  const config = getConfig();
  const credPath = path.join(getDataDir(), 'vertex-credentials.json');
  const hasCredFile = fs.existsSync(credPath);

  if (hasCredFile) {
    const { GoogleAuth } = await import('google-auth-library');
    legacyVertexClient = new AnthropicVertex({
      projectId: config.vertex.project_id || undefined,
      region: config.vertex.region || 'us-central1',
      googleAuth: new GoogleAuth({
        keyFile: credPath,
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
      }),
    });
  } else {
    legacyVertexClient = new AnthropicVertex({
      projectId: config.vertex.project_id || undefined,
      region: config.vertex.region || 'us-central1',
    });
  }
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

  const creds = JSON.parse(conn.credentials);

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

  // 检查缓存
  const cached = clientCache.get(connectionId);
  if (cached) return { client: cached, providerType: conn.provider_type };

  let client: Anthropic | AnthropicVertex;

  if (conn.provider_type === 'anthropic') {
    client = new Anthropic({ apiKey: creds.api_key || undefined });
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
        googleAuth: new GoogleAuth({
          keyFile: actualPath,
          scopes: 'https://www.googleapis.com/auth/cloud-platform',
        }),
      });
    } else {
      client = new AnthropicVertex({
        projectId: creds.project_id || undefined,
        region: creds.region || 'us-central1',
      });
    }
  } else {
    throw new Error(`不支持的 provider 类型: ${conn.provider_type}`);
  }

  clientCache.set(connectionId, client);
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
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const config = getConfig();
  const apiKey = options.apiKeyOverride || config.gemini.api_key;
  if (!apiKey) throw new Error('Gemini API key 未配置');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.modelId}:generateContent?key=${apiKey}`;

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

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
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

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.modelId,
      messages,
      max_tokens: options.maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
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
  const outputTokens = data.usage?.completion_tokens ?? 0;

  // 提取 <think>...</think> 标签中的思考内容（DeepSeek-R1、QwQ 等推理模型的通用约定）
  let text = rawText;
  let thinkingTokens = 0;
  const thinkRegex = /^\s*<think>([\s\S]*?)<\/think>\s*/;
  let thinkMatch: RegExpMatchArray | null;
  while ((thinkMatch = text.match(thinkRegex)) !== null) {
    // 粗略估算：4 字符 ≈ 1 token
    thinkingTokens += Math.ceil(thinkMatch[1].length / 4);
    text = text.slice(thinkMatch[0].length);
  }

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

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof LLMServiceError) {
    return err.statusCode === 429 || (err.statusCode != null && err.statusCode >= 500);
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
  }
  return false;
}

/**
 * 判断错误是否是 LLM 服务级错误(比 isRetryable 范围更广,包含 401/403)。
 *
 * **明确排除 context_length_exceeded / "maximum context length"** — 这是
 * 输入侧的错误(prompt 太长),不是服务不可用。老代码把这种 400 也归为
 * 服务错误 → scheduler 把它当作 LLM 服务失败累计到熔断器,多次触发后
 * 冷静期内所有 LLM 任务跳过。实际 context overflow 是"换个输入就能跑",
 * 不应该打熔断器。
 */
function isServiceError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    // 优先排除 — context overflow / 内容策略违规 / 输入格式错误等非服务错误
    if (/context[_ ]length|maximum context|context window/i.test(msg)) return false;
    if (/content[_ ]policy|safety|harm/i.test(msg)) return false;
    if (/invalid[_ ]request|invalid[_ ]param|bad request/i.test(msg) && !/\b(429|5\d{2})\b/.test(msg)) {
      return false;
    }

    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
    if (msg.includes('API error') || msg.includes('API key')) return true;
    // 显式服务故障 HTTP 状态码
    if (/\b(401|403|429|5\d{2})\b/.test(msg)) return true;
  }
  if (err instanceof Anthropic.APIError) {
    // Anthropic 400 含 context overflow 按状态码判断
    if (err.status === 400) return false;
    return true;
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
    usageDb.prepare(
      `INSERT INTO llm_usage_log (model, operation, input_tokens, output_tokens, thinking_tokens, estimated_cost, created)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(modelId, operationName ?? null, inputTokens, outputTokens, thinkingTokens, cost);
  } catch { /* 用量记录失败不影响主流程 */ }
}

export async function callLLM(options: {
  prompt: string;
  system?: string;
  model?: 'light' | 'standard' | 'heavy';
  maxTokens?: number;
  thinking?: { budget: number };
  operationName?: string;
}): Promise<string> {
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

  // 全局注入时间上下文 — 所有 LLM 调用都获得时间感知能力
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = new Date().toLocaleString('zh-CN', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const timeContext = `\n\n[系统时间: ${timeStr}, 时区: ${tz}]`;
  const system = options.system ? options.system + timeContext : timeContext.trim();

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
        };
        if (resolvedGeminiApiKey) {
          geminiOpts.apiKeyOverride = resolvedGeminiApiKey;
        }
        const result = await callGeminiLLM(geminiOpts);
        logUsage(modelId, options.operationName, result.inputTokens, result.outputTokens, 0);
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} 耗时=${Date.now() - callStart}ms`);
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
        });
        logUsage(modelId, options.operationName, result.inputTokens, result.outputTokens, result.thinkingTokens);
        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${result.inputTokens}+${result.outputTokens} thinking=${result.thinkingTokens} 耗时=${Date.now() - callStart}ms`);
        return result.text;
      }

      // ---- Claude 路径（Anthropic / Vertex） ----
      const client = resolvedClient ?? await getClaudeClient(resolvedProvider as 'anthropic' | 'vertex');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const thinkingBudget = options.thinking?.budget;
        const useThinking = thinkingBudget && thinkingBudget > 0;

        const createParams: Anthropic.MessageCreateParamsNonStreaming = {
          model: modelId,
          max_tokens: useThinking ? maxTokens + (thinkingBudget ?? 0) : maxTokens,
          system,
          messages: [{ role: 'user', content: options.prompt }],
          ...(useThinking ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget! } } : {}),
        };

        const response = await client.messages.create(
          createParams,
          { signal: controller.signal },
        );

        // thinking tokens 包含在 output_tokens 中，无独立计数字段
        logUsage(modelId, options.operationName,
          response.usage.input_tokens, response.usage.output_tokens, 0);

        log.debug(`完成 op=${options.operationName ?? 'unknown'} tokens=${response.usage.input_tokens}+${response.usage.output_tokens} 耗时=${Date.now() - callStart}ms`);
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock) {
          log.warn(`LLM 响应不含 text block op=${options.operationName ?? 'unknown'} blocks=${response.content.map(b => b.type).join(',')}`);
        }
        return textBlock ? textBlock.text : '';
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) break;

      let waitMs = BASE_DELAY_MS * Math.pow(2, attempt);
      if (err instanceof Anthropic.APIError && err.status === 429) {
        const retryAfter = (err.headers as Record<string, string> | undefined)?.['retry-after'];
        const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 0;
        const retryMs = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.min(retrySeconds * 1000, 60_000)
          : 0;
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
