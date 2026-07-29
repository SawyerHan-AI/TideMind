/**
 * 模型定价表 — 用于预估 LLM 调用费用。
 * 单位: $/1M tokens。价格按模型名模糊匹配。
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('pricing');

/** 写入 usage ledger，确保历史预估可以按当时价表解释。 */
export const PRICING_TABLE_VERSION = '2026-07-29';

interface ModelPricing {
  /** 模型名关键词（用 includes 匹配） */
  pattern: string
  input: number   // $/1M input tokens
  output: number  // $/1M output tokens
  thinking: number // $/1M thinking tokens
}

/**
 * 按优先级排列：更具体的 pattern 放前面，避免被通用 pattern 抢先匹配。
 */
const PRICING_TABLE: ModelPricing[] = [
  // ── Claude 4.x ──
  { pattern: 'claude-opus-4-7',     input: 5.00,  output: 25.00, thinking: 25.00 },
  { pattern: 'claude-opus-4-6',     input: 5.00,  output: 25.00, thinking: 25.00 },
  { pattern: 'claude-opus-4-5',     input: 5.00,  output: 25.00, thinking: 25.00 },
  { pattern: 'claude-opus-4-1',     input: 15.00, output: 75.00, thinking: 75.00 },
  { pattern: 'claude-sonnet-4-6',   input: 3.00,  output: 15.00, thinking: 15.00 },
  { pattern: 'claude-sonnet-4-5',   input: 3.00,  output: 15.00, thinking: 15.00 },
  { pattern: 'claude-haiku-4-5',    input: 1.00,  output: 5.00,  thinking: 5.00 },
  // ── Claude 3.x ──
  { pattern: 'claude-3-5-sonnet',   input: 3.00,  output: 15.00, thinking: 15.00 },
  { pattern: 'claude-3-5-haiku',    input: 0.80,  output: 4.00,  thinking: 4.00 },
  { pattern: 'claude-3-opus',       input: 15.00, output: 75.00, thinking: 75.00 },
  { pattern: 'claude-3-haiku',      input: 0.25,  output: 1.25,  thinking: 1.25 },
  // ── Gemini 3.x ──
  // 2026 初 Google 对 3.x 系列混用两种 ID 写法:主版本号用 dash
  // (`gemini-3-pro`, `gemini-3-flash`),小版本号用 dot(`gemini-3.1-pro`)。
  // 同时列出两种常见形式以防模糊匹配漏掉(`includes` 需要完整子串)。
  // 价格来自 Google AI Studio pricing page(2026-Q1 公开定价;若后续调整,
  // 以官方为准),均为 $/1M tokens。
  { pattern: 'gemini-3.1-pro',      input: 2.00,  output: 12.00, thinking: 12.00 },
  { pattern: 'gemini-3-pro',        input: 2.00,  output: 12.00, thinking: 12.00 },
  { pattern: 'gemini-3-flash',      input: 0.50,  output: 3.00,  thinking: 3.00 },
  // ── Gemini 2.5 ──
  { pattern: 'gemini-2.5-pro',      input: 1.25,  output: 10.00, thinking: 10.00 },
  { pattern: 'gemini-2.5-flash-lite', input: 0.10, output: 0.40,  thinking: 0.40 },
  { pattern: 'gemini-2.5-flash',    input: 0.30,  output: 2.50,  thinking: 3.50 },
  // ── Gemini 2.0 ──
  { pattern: 'gemini-2.0-flash',    input: 0.10,  output: 0.40,  thinking: 0.40 },
  // ── Gemini 1.5 ──
  { pattern: 'gemini-1.5-pro',      input: 1.25,  output: 5.00,  thinking: 5.00 },
  { pattern: 'gemini-1.5-flash',    input: 0.075, output: 0.30,  thinking: 0.30 },
]

/**
 * Prompt cache 价档系数(Anthropic 公开定价):
 * cache write 按 input 价的 1.25x 计费,cache read 按 0.1x。
 * usage.input_tokens 只是未缓存余量,完整 prompt = input + cache_creation + cache_read,
 * 不计 cache 两项会系统性低估成本。
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * 根据模型名和 token 数计算预估费用（美元）。
 * 模型名支持带版本后缀，如 `claude-sonnet-4-6@20250514`。
 * 未匹配到的模型返回 NULL，禁止拿任意 fallback 伪装成可审计的 API 价格。
 */
function calculateEstimatedCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens: number,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
): number | null {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(thinkingTokens)
    || !Number.isFinite(cacheCreateTokens) || !Number.isFinite(cacheReadTokens)) {
    return null;
  }
  if (inputTokens < 0) inputTokens = 0;
  if (outputTokens < 0) outputTokens = 0;
  if (thinkingTokens < 0) thinkingTokens = 0;
  if (cacheCreateTokens < 0) cacheCreateTokens = 0;
  if (cacheReadTokens < 0) cacheReadTokens = 0;

  const id = modelId.toLowerCase()
  const pricing = PRICING_TABLE.find(p => id.includes(p.pattern))
  if (!pricing) {
    log.error(`[pricing] Unknown model ID: ${modelId} — estimated cost is unavailable. Add the actual model ID to PRICING_TABLE.`);
    return null;
  }

  return (
    (inputTokens * pricing.input +
      cacheCreateTokens * pricing.input * CACHE_WRITE_MULTIPLIER +
      cacheReadTokens * pricing.input * CACHE_READ_MULTIPLIER +
      outputTokens * pricing.output +
      thinkingTokens * pricing.thinking) /
    1_000_000
  )
}

/**
 * 兼容旧调用点的数值接口。新 usage ledger 必须使用 estimateVersionedCost，
 * 才能把未知模型保存为 NULL + unavailable，而不是把 0 当成真实价格。
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens: number,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
): number {
  return calculateEstimatedCost(
    modelId,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheCreateTokens,
    cacheReadTokens,
  ) ?? 0;
}

export interface VersionedCostEstimate {
  estimatedCost: number | null;
  kind: 'api_estimate' | 'unavailable';
  pricingTableVersion: string | null;
}

export function estimateVersionedCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens: number,
  cacheCreateTokens = 0,
  cacheReadTokens = 0,
): VersionedCostEstimate {
  const estimatedCost = calculateEstimatedCost(
    modelId,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheCreateTokens,
    cacheReadTokens,
  );
  return estimatedCost === null
    ? {
      estimatedCost: null,
      kind: 'unavailable',
      // 即使未命中也记录“哪一版价表判定为未知”，后续才能审计或回填。
      pricingTableVersion: PRICING_TABLE_VERSION,
    }
    : {
      estimatedCost,
      kind: 'api_estimate',
      pricingTableVersion: PRICING_TABLE_VERSION,
    };
}
