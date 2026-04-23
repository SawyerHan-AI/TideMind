/**
 * 模型定价表 — 用于预估 LLM 调用费用。
 * 单位: $/1M tokens。价格按模型名模糊匹配。
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('pricing');

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
 * 根据模型名和 token 数计算预估费用（美元）。
 * 模型名支持带版本后缀，如 `claude-sonnet-4-6@20250514`。
 * 未匹配到的模型返回 0。
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens: number,
): number {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(thinkingTokens)) {
    return 0;
  }
  if (inputTokens < 0) inputTokens = 0;
  if (outputTokens < 0) outputTokens = 0;
  if (thinkingTokens < 0) thinkingTokens = 0;

  const id = modelId.toLowerCase()
  const pricing = PRICING_TABLE.find(p => id.includes(p.pattern))
  if (!pricing) {
    // error 级别而非 warn:返 0 会导致计费遗漏(Pro+ 托管 LLM 场景下
    // 直接让我们没收到钱)。上线新模型时必须把 pattern 加到 PRICING_TABLE,
    // 否则整个月的该模型调用都是 0 成本。
    log.error(`[pricing] Unknown model ID: ${modelId} — returning 0 cost, billing may be inaccurate. Add pattern to PRICING_TABLE.`);
    return 0;
  }

  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      thinkingTokens * pricing.thinking) /
    1_000_000
  )
}
