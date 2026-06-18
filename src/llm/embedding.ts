import path from 'node:path';
import fs from 'node:fs';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embedding');

/**
 * Embedding 服务异常(B-3, 2026-05-21)。
 *
 * 设计上跟 LLMServiceError 平行:外层熔断器需要区分"embedding API 真的失败"
 * 和"业务侧拿到 null 但是合法的(空文本、零向量等)"。getEmbedding 上层捕到
 * EmbeddingServiceError 时会调 notifyEmbeddingFailure → scheduler 熔断器累积失败,
 * 阈值后 requiresEmbedding 的 task 在熔断器 open 状态下被跳过。
 */
export class EmbeddingServiceError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'EmbeddingServiceError';
  }
}

// ─────────────────────────────────────────────────────────────
// Embedding 健康度信号 hook (B-3, 2026-05-21)
// ─────────────────────────────────────────────────────────────
//
// 跟 LLM 的 LLMSuccessHook / LLMFailureHook 同模式。core embedding 模块不能直接
// import scheduler / db,通过 hook 注入由 daemon.ts 把 db handle 绑进来。
// 测试场景下 hook 未注入 → 行为退化为单纯 log。

type EmbeddingSuccessHook = () => void;
let embeddingSuccessHook: EmbeddingSuccessHook | null = null;
export function setEmbeddingSuccessHook(hook: EmbeddingSuccessHook | null): void {
  embeddingSuccessHook = hook;
}
function notifyEmbeddingSuccess(): void {
  if (!embeddingSuccessHook) return;
  try { embeddingSuccessHook(); } catch (err) {
    log.warn(`embedding success hook threw: ${(err as Error).message}`);
  }
}

type EmbeddingFailureHook = (err: EmbeddingServiceError) => void;
let embeddingFailureHook: EmbeddingFailureHook | null = null;
export function setEmbeddingFailureHook(hook: EmbeddingFailureHook | null): void {
  embeddingFailureHook = hook;
}
function notifyEmbeddingFailure(err: EmbeddingServiceError): void {
  if (!embeddingFailureHook) return;
  try { embeddingFailureHook(err); } catch (hookErr) {
    log.warn(`embedding failure hook threw: ${(hookErr as Error).message}`);
  }
}

let available: boolean | null = null;
let availableCheckTime = 0;
const CHECK_TTL_MS = 60_000;
// 并发探测去重:多个调用者同时命中过期 TTL 时,只发一次真实探测,
// 其余等待同一个 Promise,避免打出 N 次 'test' embedding 请求。
let inflightAvailabilityCheck: Promise<boolean> | null = null;

// Vertex AI token 缓存
//
// 不要用 client.credentials.expiry_date:
//   1. service-account JWT auth 在首次 getAccessToken 之前 credentials 是空的;
//   2. expiry_date 在不同 GoogleAuth credential 子类里单位不一致(有时 ms,有时 s),
//      错信单位会让 token 过期后还被命中 → 401 → null embedding → 搜索静默失效。
// 用一个保守的固定窗口(50 分钟,留出 10 分钟余量给 60 分钟的 Google 默认 token 寿命)
// 远比读 expiry_date 安全。
const TOKEN_CACHE_WINDOW_MS = 50 * 60 * 1000;
let cachedToken: string | null = null;
let tokenExpiry = 0;
// 并发去重(2026-05-09):多个 embedding 任务同时命中过期 TTL 时,如不去重会
// 各自创建 GoogleAuth 实例并打 N 次 metadata server token 请求(QPS 限制 +
// scrypt 派生开销)。与同文件 inflightAvailabilityCheck 模式一致。
let inflightTokenFetch: Promise<string> | null = null;
// 代际计数:clearEmbeddingTokenCache 时 +1。in-flight 的旧凭证 fetch resolve 时
// 若代际已变,不得把旧 token 写回缓存(否则"清缓存"被竞态穿透)。
let tokenGeneration = 0;

/**
 * 清空 Vertex access token 缓存。凭证变更(用户重新上传 vertex JSON / 改 connection)
 * 时必须调用,否则旧 token 最长 50 分钟内继续被命中——LLM 侧同样的问题由
 * fingerprintCreds(文件 mtime 入指纹)解决,embedding 侧靠这里显式清。
 * 由 client.ts 的 clearClientCache 统一触发。
 */
export function clearEmbeddingTokenCache(): void {
  cachedToken = null;
  tokenExpiry = 0;
  tokenGeneration++;
  inflightTokenFetch = null;
}

async function getVertexToken(timeoutMs?: number): Promise<string> {
  const now = Date.now();
  if (cachedToken && now + 30_000 < tokenExpiry) return cachedToken;

  if (!inflightTokenFetch) {
    const gen = tokenGeneration;
    inflightTokenFetch = (async () => {
      const credPath = path.join(getDataDir(), 'vertex-credentials.json');
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        keyFile: credPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      if (!token?.token) throw new Error('Failed to get Vertex access token');
      if (gen === tokenGeneration) {
        cachedToken = token.token;
        tokenExpiry = Date.now() + TOKEN_CACHE_WINDOW_MS;
      }
      return token.token;
    })().finally(() => {
      if (gen === tokenGeneration) inflightTokenFetch = null;
    });
  }

  // google-auth-library 的 token 请求走 gaxios 且默认无超时,不受调用方
  // AbortSignal.timeout 约束——OAuth 端点 hang(VPN/防火墙/DNS)会把 brain_recall
  // 的 3s 硬上限无限拖住。用 Promise.race 兜一层调用方预算;超时按服务失败抛出,
  // 上层 getEmbedding 捕获后降级为 null(纯 BM25 兜底)。in-flight fetch 不取消,
  // 后续调用仍可复用其结果。
  const fetchPromise = inflightTokenFetch;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EmbeddingServiceError(`Vertex token fetch timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return fetchPromise;
}

/**
 * Gemini via Vertex AI
 */
async function getGeminiVertexEmbedding(text: string, timeoutMs: number = 30_000): Promise<Float32Array | null> {
  const config = getConfig();
  const region = config.vertex.region === 'global' ? 'us-central1' : config.vertex.region;
  const projectId = config.vertex.project_id;

  if (!projectId) {
    // 尝试从凭证文件读取
    const credPath = path.join(getDataDir(), 'vertex-credentials.json');
    if (!fs.existsSync(credPath)) {
      log.error('Vertex AI 凭证未配置');
      return null;
    }
    try {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (!cred.project_id) {
        log.error('凭证文件中无 project_id');
        return null;
      }
      // 使用凭证文件中的 project_id
      return await callVertexEmbedding(text, cred.project_id, region, timeoutMs);
    } catch (err) {
      log.error('读取凭证文件失败:', (err as Error).message);
      return null;
    }
  }
  return callVertexEmbedding(text, projectId, region, timeoutMs);
}

async function callVertexEmbedding(text: string, projectId: string, region: string, timeoutMs: number = 30_000): Promise<Float32Array | null> {
  // token 获取在 AbortSignal.timeout 的 fetch 之前,必须单独受调用方预算约束,
  // 否则 recall 路径承诺的 3s 上限会被 OAuth hang 穿透
  const token = await getVertexToken(timeoutMs);
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/gemini-embedding-001:predict`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ content: text }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    // 401 说明缓存的 token 已失效(被撤销 / SA key 轮换 / project 变更),
    // 不清缓存会让同一个坏 token 被重复使用最长 50 分钟,期间向量搜索静默失效
    if (resp.status === 401) clearEmbeddingTokenCache();
    log.error(`Vertex embedding 失败: ${resp.status} ${await resp.text()}`);
    return null;
  }

  const data = await resp.json() as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };
  const values = data.predictions?.[0]?.embeddings?.values;
  if (!values) return null;
  return new Float32Array(values);
}

/**
 * Gemini via API Key
 */
async function getGeminiApiKeyEmbedding(text: string, timeoutMs: number = 30_000): Promise<Float32Array | null> {
  const config = getConfig();
  const apiKey = config.gemini.api_key;
  if (!apiKey) {
    log.error('Gemini API key 未配置');
    return null;
  }

  // 用 x-goog-api-key header 而非 ?key= query string,避免 API key 出现在
  // 错误日志/堆栈里(高危泄漏面)。
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    log.error(`Gemini embedding 失败: ${resp.status}`);
    return null;
  }

  const data = await resp.json() as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;
  if (!values) return null;
  return new Float32Array(values);
}

/**
 * Ollama embedding（保持原有逻辑）
 */
async function getOllamaEmbedding(text: string, timeoutMs: number = 30_000): Promise<Float32Array | null> {
  const config = getConfig();
  try {
    const response = await fetch(`${config.ollama.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.embedding.model,
        input: text,
      }),
      // 与 Gemini / Vertex 路径对齐 —— hung 的 Ollama 实例(例如模型还在加载
      // 或显存耗尽)会让 fetch 无限等待,整个 embedding 批量任务被卡死。
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      log.error(`Ollama embedding 失败: ${response.status}`);
      return null;
    }

    const data = await response.json() as { embeddings: number[][] };
    if (!data.embeddings?.[0]) return null;
    return new Float32Array(data.embeddings[0]);
  } catch (err) {
    log.error('Ollama 连接失败:', (err as Error).message);
    return null;
  }
}

/**
 * L2 归一化:把向量缩放到单位球面上(欧几里得范数 = 1)。
 *
 * 为何统一在 getEmbedding 出口归一化(2026-05-09):
 * `src/utils/similarity.ts::l2DistanceToSimilarity` 用 `1 - d²/2` 把 L2 距离
 * 映射到 [0,1] 的相似度,**这条公式只对单位向量成立**。Gemini/Vertex 的
 * gemini-embedding-001 返回的是未归一化向量(L2 范数可能 > 1),L2 距离能
 * 超过 √2 → 公式得出负数被 `Math.max(0, ...)` clamp 到 0 → 所有结果排序坍塌。
 *
 * 让所有 provider 在写入和查询时都过同一道归一化,既修复 Gemini/Vertex
 * 排序问题,也保证将来切换 provider 时索引可比。Ollama nomic-embed-text
 * 已经默认归一化,再过一遍是 no-op(范数已 = 1)。
 *
 * 注意:已写入 sqlite-vec 的旧向量是各自原始空间的混合,改归一化后旧向量
 * 与新查询的 cosine 不再可比 — 配合 S7 的 dim mismatch 提示,客户端在
 * provider 切换 / 升级到本版本后会被引导重建索引(reembedAllNodes)。
 */
function normalizeL2(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm < 1e-8) return vec; // 零向量(理论上不应出现)保持原样,避免除 0
  // 已经接近单位向量(Ollama 等)就直接返回,避免不必要的拷贝
  if (Math.abs(norm - 1) < 1e-4) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * 通过配置的 provider 获取文本 embedding
 *
 * 维度校验(2026-05-09):provider 返回的向量维度必须等于 config.embedding.dimensions
 * (sqlite-vec 表的 schema 定义)。历史所有 provider 都直接 `new Float32Array(values)`
 * 无校验,模型版本变化 / 配置漂移会让响应维度静默与库表不匹配:写入端会在
 * sqlite-vec INSERT 时抛 dim mismatch 错误并被 catch 吞成 null;查询端 cosine
 * 公式失去意义。这里在出口主动比对,不一致 → log.error + 返回 null,让上游决定。
 *
 * config.embedding.dimensions 与库表 dim 的一致性由 db/connection.ts::initVec
 * 在启动时维护(切换 dim 会 DROP nodes_vec 并设 reembedNeeded=true)。这里只做
 * "本次响应是否符合配置"的二次确认。
 */
/**
 * brain_recall 路径用的 timeout（3 秒硬上限）。
 * indexing 路径继续用 30s 默认。
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §6.1
 */
export const EMBEDDING_RECALL_TIMEOUT_MS = 3000;
export const EMBEDDING_DEFAULT_TIMEOUT_MS = 30_000;

export interface GetEmbeddingOptions {
  /**
   * 网络超时（毫秒）。
   * - brain_recall 调用方应传 EMBEDDING_RECALL_TIMEOUT_MS（3s）以保证主链路响应时间
   * - indexing / digest 类后台任务保持默认 30s
   * 超时即视为失败、不重试、返回 null。底层用 AbortSignal.timeout 真正 abort
   * fetch 避免 socket 泄漏。
   */
  timeoutMs?: number;
}

export async function getEmbedding(text: string, opts: GetEmbeddingOptions = {}): Promise<Float32Array | null> {
  const config = getConfig();
  const timeoutMs = opts.timeoutMs ?? EMBEDDING_DEFAULT_TIMEOUT_MS;
  log.debug(`provider=${config.embedding.provider} textLen=${text.length} timeoutMs=${timeoutMs}`);

  // B-3: 用 try/catch 兜住 provider 函数:provider 内部以"返回 null"表达失败,
  // 但部分异常(token 获取失败、AbortSignal.timeout、网络 throw)仍然冒泡。
  // 任何异常都视为 embedding 服务不可用,触发熔断器累积失败。
  let vec: Float32Array | null;
  try {
    if (config.embedding.provider === 'vertex') {
      vec = await getGeminiVertexEmbedding(text, timeoutMs);
    } else if (config.embedding.provider === 'gemini') {
      vec = await getGeminiApiKeyEmbedding(text, timeoutMs);
    } else {
      vec = await getOllamaEmbedding(text, timeoutMs);
    }
  } catch (err) {
    // B-3: 异常路径 — 直接通知失败 hook 并 return null,保持 getEmbedding 的
    // "失败 = null"契约(调用者已习惯 null check)。
    const msg = (err as Error).message ?? String(err);
    log.error(`embedding 异常(provider=${config.embedding.provider}): ${msg}`);
    notifyEmbeddingFailure(new EmbeddingServiceError(msg));
    return null;
  }

  if (vec === null) {
    // B-3: provider 返回 null 同样视为失败(provider 内部已 log.error 具体原因),
    // 熔断器需要累积才能正确判定服务不可用。
    notifyEmbeddingFailure(new EmbeddingServiceError(`embedding provider returned null (provider=${config.embedding.provider})`));
    return null;
  }

  // dim mismatch 防御:不一致直接回 null,避免污染 sqlite-vec 表
  const expectedDim = config.embedding.dimensions;
  if (typeof expectedDim === 'number' && expectedDim > 0 && vec.length !== expectedDim) {
    log.error(
      `embedding dim mismatch: provider=${config.embedding.provider} ` +
      `model=${config.embedding.model ?? '?'} got=${vec.length} expected=${expectedDim}. ` +
      '请检查 config.embedding.dimensions 与 provider 模型是否对齐。',
    );
    // dim mismatch 是配置错误而非服务失效,不该把熔断器吹起来 — 否则配置错误的
    // 用户永远等不到熔断器恢复。这里只 log 不计入熔断器失败。
    return null;
  }

  // B-3: 真实成功 → 通知 hook 重置熔断器健康度。
  notifyEmbeddingSuccess();
  return normalizeL2(vec);
}

/**
 * 批量获取 embedding
 *
 * 用 Promise.allSettled 而非 Promise.all：单条文本失败（API 限流、超时、单条
 * 内容触发 provider 拒绝）不应让整批 reject。失败的条目位置写 null,调用方
 * 自行决定是否补偿（跳过 / 重试 / 降级 keyword search）。
 */
export async function getEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  const results = await Promise.allSettled(texts.map(t => getEmbedding(t)));
  return results.map(r => (r.status === 'fulfilled' ? r.value : null));
}

/**
 * 检查 embedding 服务是否可用
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  const now = Date.now();
  const ttl = available === false ? 10_000 : CHECK_TTL_MS; // Shorter TTL when service is down
  if (available !== null && now - availableCheckTime < ttl) {
    return available;
  }

  // 已有正在进行的探测 → 复用同一个 Promise,避免竞态下重复打 'test' 请求
  if (inflightAvailabilityCheck) return inflightAvailabilityCheck;

  inflightAvailabilityCheck = (async () => {
    try {
      const result = await getEmbedding('test');
      available = result !== null;
    } catch {
      available = false;
    }
    availableCheckTime = Date.now(); // Set after async operation completes
    return available!;
  })().finally(() => {
    inflightAvailabilityCheck = null;
  });

  return inflightAvailabilityCheck;
}
