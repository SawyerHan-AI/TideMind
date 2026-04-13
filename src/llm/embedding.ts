import path from 'node:path';
import fs from 'node:fs';
import { getConfig, getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embedding');

let available: boolean | null = null;
let availableCheckTime = 0;
const CHECK_TTL_MS = 60_000;

// Vertex AI token 缓存
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
  cachedToken = token.token!;
  const credentials = (client as any).credentials;
  tokenExpiry = credentials?.expiry_date ?? (now + 3500_000);
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  try {
    const result = await getEmbedding('test');
    available = result !== null;
  } catch {
    available = false;
  }
  availableCheckTime = Date.now(); // Set after async operation completes
  return available;
}
