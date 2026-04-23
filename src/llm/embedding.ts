import path from 'node:path';
import fs from 'node:fs';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embedding');

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

async function getVertexToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now + 30_000 < tokenExpiry) return cachedToken;

  const credPath = path.join(getDataDir(), 'vertex-credentials.json');
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw new Error('Failed to get Vertex access token');
  cachedToken = token.token;
  tokenExpiry = now + TOKEN_CACHE_WINDOW_MS;
  return cachedToken;
}

/**
 * Gemini via Vertex AI
 */
async function getGeminiVertexEmbedding(text: string): Promise<Float32Array | null> {
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
      return await callVertexEmbedding(text, cred.project_id, region);
    } catch (err) {
      log.error('读取凭证文件失败:', (err as Error).message);
      return null;
    }
  }
  return callVertexEmbedding(text, projectId, region);
}

async function callVertexEmbedding(text: string, projectId: string, region: string): Promise<Float32Array | null> {
  const token = await getVertexToken();
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
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
async function getGeminiApiKeyEmbedding(text: string): Promise<Float32Array | null> {
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
    signal: AbortSignal.timeout(30_000),
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
async function getOllamaEmbedding(text: string): Promise<Float32Array | null> {
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
      signal: AbortSignal.timeout(30_000),
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
 * 通过配置的 provider 获取文本 embedding
 */
export async function getEmbedding(text: string): Promise<Float32Array | null> {
  const config = getConfig();
  log.debug(`provider=${config.embedding.provider} textLen=${text.length}`);

  if (config.embedding.provider === 'vertex') {
    return getGeminiVertexEmbedding(text);
  }
  if (config.embedding.provider === 'gemini') {
    return getGeminiApiKeyEmbedding(text);
  }
  return getOllamaEmbedding(text);
}

/**
 * 批量获取 embedding
 */
export async function getEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  return Promise.all(texts.map(t => getEmbedding(t)));
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
