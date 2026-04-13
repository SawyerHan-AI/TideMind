/**
 * Prompt 测试辅助工具
 *
 * 提供 LLM 调用封装、结果评估、报告输出等通用功能。
 */

import { loadConfig, reloadConfig } from '../../src/config.js';
import { callLLM } from '../../src/llm/client.js';
import { setUsageDb } from '../../src/llm/client.js';
import { getDb, initVec } from '../../src/db/connection.js';
import { getPrompt, getLLMOptions, loadStrategies } from '../../src/strategy/loader.js';

// ---- 初始化 ----

let initialized = false;

export async function initTestEnv(): Promise<void> {
  if (initialized) return;
  reloadConfig();
  loadConfig();
  loadStrategies();
  const db = getDb();
  setUsageDb(db);
  await initVec();
  initialized = true;
  console.log('✓ 测试环境初始化完成\n');
}

// ---- 类型 ----

export interface TestCase<TInput, TExpect> {
  name: string;
  input: TInput;
  expected: TExpect;
  /** 脏数据标记 */
  dirty?: boolean;
}

export interface TestResult<TInput, TExpect, TOutput> {
  name: string;
  input: TInput;
  expected: TExpect;
  output: TOutput | null;
  rawResponse: string;
  passed: boolean;
  score: number;
  issues: string[];
  durationMs: number;
}

// ---- LLM 调用封装 ----

export async function callWithStrategy(
  strategyName: string,
  fallbackSystem: string,
  prompt: string,
  opts?: { model?: 'light' | 'standard' | 'heavy'; maxTokens?: number },
): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();
  const text = await callLLM({
    prompt,
    system: getPrompt(strategyName, fallbackSystem),
    ...getLLMOptions(strategyName),
    ...(opts?.model ? { model: opts.model } : {}),
    maxTokens: opts?.maxTokens ?? 2048,
    operationName: `test-${strategyName}`,
  });
  return { text, durationMs: Date.now() - start };
}

// ---- JSON 解析 ----

export function parseJSON<T>(raw: string): T | null {
  let cleaned = raw.trim();
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) cleaned = codeBlock[1].trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err1) {
    // 尝试提取第一个 JSON 对象或数组
    const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (match) {
      try { return JSON.parse(match[1]) as T; } catch { /* */ }
    }
    // 移除 BOM 和不可见字符后再试
    const noBom = cleaned.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    try { return JSON.parse(noBom) as T; } catch { /* */ }
    return null;
  }
}

// ---- 验证工具 ----

const VALID_RELATIONS = new Set([
  'caused_by', 'continues', 'updates', 'supports', 'contradicts',
  'summarizes', 'part_of', 'analogous', 'tagged',
]);

export function isValidRelation(r: string): boolean {
  return VALID_RELATIONS.has(r);
}

export function isInRange(v: number, min: number, max: number): boolean {
  return typeof v === 'number' && v >= min && v <= max;
}

// ---- 报告输出 ----

export function printReport<TInput, TExpect, TOutput>(
  promptName: string,
  results: TestResult<TInput, TExpect, TOutput>[],
): void {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / total;
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / total;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 ${promptName} 测试报告`);
  console.log(`${'='.repeat(60)}`);
  console.log(`通过率: ${passed}/${total} (${Math.round(passed / total * 100)}%)`);
  console.log(`平均分: ${avgScore.toFixed(2)}`);
  console.log(`平均耗时: ${Math.round(avgDuration)}ms`);
  console.log('');

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.name} (${r.score.toFixed(2)}, ${r.durationMs}ms)`);
    if (r.issues.length > 0) {
      for (const issue of r.issues) {
        console.log(`   ⚠ ${issue}`);
      }
    }
  }

  // 汇总问题
  const allIssues = results.flatMap(r => r.issues);
  if (allIssues.length > 0) {
    console.log(`\n问题汇总 (${allIssues.length} 个):`);
    const freq = new Map<string, number>();
    for (const issue of allIssues) {
      freq.set(issue, (freq.get(issue) ?? 0) + 1);
    }
    for (const [issue, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x ${issue}`);
    }
  }

  console.log('');
}
