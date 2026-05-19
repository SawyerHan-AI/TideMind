/**
 * llm/pricing.ts 单元测试
 *
 * 纯函数：模型定价匹配 + 费用计算。
 */
import { describe, it, expect, vi } from 'vitest';

// mock logger 避免副作用
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { estimateCost } from '../../src/llm/pricing.js';

describe('estimateCost', () => {
  // ===== 基础定价匹配 =====

  it('Claude Opus 4.7 定价正确', () => {
    // input=5$/M, output=25$/M, thinking=25$/M（与 4.6 同价）
    const cost = estimateCost('claude-opus-4-7', 1_000_000, 1_000_000, 0);
    expect(cost).toBeCloseTo(30.0); // 5 + 25
  });

  it('Claude Opus 4.7 不被 Opus 4.6 抢先匹配', () => {
    // 验证 PRICING_TABLE 顺序：4-7 在 4-6 之前
    const cost = estimateCost('claude-opus-4-7-20260301', 1_000_000, 0, 1_000_000);
    expect(cost).toBeCloseTo(30.0); // input 5 + thinking 25
  });

  it('Claude Opus 4.6 定价正确', () => {
    // input=5$/M, output=25$/M, thinking=25$/M
    const cost = estimateCost('claude-opus-4-6', 1_000_000, 1_000_000, 0);
    expect(cost).toBeCloseTo(30.0); // 5 + 25
  });

  it('Claude Sonnet 4.6 定价正确', () => {
    // input=3$/M, output=15$/M
    const cost = estimateCost('claude-sonnet-4-6', 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(3.0);
  });

  it('Claude Haiku 4.5 定价正确', () => {
    // input=1$/M, output=5$/M
    const cost = estimateCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000, 0);
    expect(cost).toBeCloseTo(6.0);
  });

  it('Gemini 2.5 Flash 定价正确', () => {
    // input=0.30$/M, output=2.50$/M, thinking=3.50$/M
    const cost = estimateCost('gemini-2.5-flash-001', 1_000_000, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.3);
  });

  it('Gemini 2.5 Pro 定价正确', () => {
    // input=1.25$/M, output=10.0$/M
    const cost = estimateCost('gemini-2.5-pro-latest', 2_000_000, 500_000, 0);
    expect(cost).toBeCloseTo(7.5); // 2*1.25 + 0.5*10
  });

  // ===== 版本后缀匹配 =====

  it('支持带版本后缀的模型名', () => {
    const cost = estimateCost('claude-sonnet-4-6@20250514', 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(3.0);
  });

  it('大写模型名也能匹配（toLowerCase）', () => {
    const cost = estimateCost('Claude-Opus-4-6', 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(5.0);
  });

  // ===== thinking token =====

  it('thinking token 单独计费', () => {
    // opus 4.6: thinking = 25$/M
    const cost = estimateCost('claude-opus-4-6', 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(25.0);
  });

  it('三种 token 一起计费', () => {
    // sonnet 4.6: input=3, output=15, thinking=15
    const cost = estimateCost('claude-sonnet-4-6', 100_000, 50_000, 200_000);
    // 0.1*3 + 0.05*15 + 0.2*15 = 0.3 + 0.75 + 3.0 = 4.05
    expect(cost).toBeCloseTo(4.05);
  });

  // ===== 优先级：具体 pattern 先匹配 =====

  it('gemini-2.5-flash-lite 不被 gemini-2.5-flash 抢先匹配', () => {
    // flash-lite: input=0.10, output=0.40
    // flash: input=0.30, output=2.50
    const liteCost = estimateCost('gemini-2.5-flash-lite', 1_000_000, 1_000_000, 0);
    expect(liteCost).toBeCloseTo(0.5); // 0.10 + 0.40
  });

  // ===== 防御性处理 =====

  it('未知模型走 FALLBACK_PRICING(Sonnet 价档)而非返 0', () => {
    // 2026-05-19 修复:未知模型静默 0 让计费遗漏。改为按 Sonnet 价(3/15/15) fallback。
    // 1000 input + 1000 output = (1000*3 + 1000*15) / 1M = 0.018
    expect(estimateCost('unknown-model', 1000, 1000, 0)).toBeCloseTo(0.018, 5);
  });

  it('NaN token 返回 0', () => {
    expect(estimateCost('claude-opus-4-6', NaN, 100, 0)).toBe(0);
  });

  it('Infinity token 返回 0', () => {
    expect(estimateCost('claude-opus-4-6', Infinity, 0, 0)).toBe(0);
  });

  it('负数 token 被 clamp 到 0', () => {
    const cost = estimateCost('claude-opus-4-6', -100, 1_000_000, 0);
    // input 被 clamp 为 0，只算 output
    expect(cost).toBeCloseTo(25.0);
  });

  it('零 token 返回 0', () => {
    expect(estimateCost('claude-opus-4-6', 0, 0, 0)).toBe(0);
  });

  // ===== Gemini 旧版 =====

  it('Gemini 1.5 Pro', () => {
    const cost = estimateCost('gemini-1.5-pro', 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(1.25);
  });

  it('Gemini 2.0 Flash', () => {
    const cost = estimateCost('gemini-2.0-flash', 1_000_000, 1_000_000, 0);
    expect(cost).toBeCloseTo(0.5); // 0.10 + 0.40
  });
});
