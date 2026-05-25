#!/usr/bin/env node
/**
 * recall-metrics.ts — brain_recall 遥测 dashboard SQL 聚合脚本
 *
 * 设计 doc: docs/design/brain-recall-redesign-2026-05.md §10.6
 *
 * 数据来源：~/.tidemind/graph/brain.sqlite 的 operation_log 表
 *           v28 migration 加的 4 个 diagnostics 字段:
 *           - exact_count
 *           - related_count
 *           - fallback_chain
 *           - vector_unavailable
 *
 * 用途：
 *   - 判断 fallback chain 触发频率 / step 分布（调 fallback 顺序）
 *   - 监控 vector_unavailable_rate（embedding API 健康度）
 *   - 判断 Phase 2 触发（deprecated_field_received 比例）
 *   - 跟踪 recall pipeline 退化（exact_zero_rate 周比）
 *
 * 使用：
 *   npm run recall-metrics                    # 默认查最近 7 天
 *   npm run recall-metrics -- --days 30       # 自定义天数
 *   npm run recall-metrics -- --db /path/to/brain.sqlite
 *
 * 输出：stdout 表格 + JSON。可重定向 / pipe 到外部监控。
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface OperationLogRow {
  id: number;
  operation: string;
  exact_count: number | null;
  related_count: number | null;
  fallback_chain: string | null;
  vector_unavailable: number | null;
  created: string;
}

function parseArgs(argv: string[]): { days: number; dbPath: string } {
  let days = 7;
  let dbPath = join(homedir(), '.tidemind', 'graph', 'brain.sqlite');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = parseInt(argv[++i], 10);
    else if (argv[i] === '--db') dbPath = argv[++i];
  }
  return { days, dbPath };
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function bucketExactCount(count: number | null): string {
  if (count === null) return 'null (legacy)';
  if (count === 0) return '0';
  if (count <= 2) return '1-2';
  if (count <= 4) return '3-4';
  if (count <= 9) return '5-9';
  return '10+';
}

function parseFirstFallbackStep(chain: string | null): string | null {
  if (!chain) return null;
  // chain 格式: "exact=N → step1=M → step2=K ..."
  const parts = chain.split(' → ');
  if (parts.length < 2) return null;
  const stepWithCount = parts[1];
  const stepCode = stepWithCount.split('=')[0];
  return stepCode;
}

function main() {
  const { days, dbPath } = parseArgs(process.argv.slice(2));

  if (!existsSync(dbPath)) {
    console.error(`❌ DB 文件不存在: ${dbPath}`);
    console.error('   先确保 TideMind 已经运行过一次。');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  // 看看 v28 migration 跑过没
  const cols = db.prepare("PRAGMA table_info(operation_log)").all() as Array<{ name: string }>;
  const hasNewFields = cols.some(c => c.name === 'exact_count');
  if (!hasNewFields) {
    console.error('⚠️  operation_log 表缺 v28 migration 加的字段 (exact_count 等)。');
    console.error('    重启 TideMind app 触发 migration，再跑这个脚本。');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT id, operation, exact_count, related_count, fallback_chain, vector_unavailable, created
    FROM operation_log
    WHERE operation = 'recall' AND created >= ?
    ORDER BY created DESC
  `).all(cutoff) as OperationLogRow[];

  if (rows.length === 0) {
    console.log(`📭 最近 ${days} 天没有 recall operation。`);
    process.exit(0);
  }

  // === Exact count 分布 ===
  const exactBuckets = new Map<string, number>();
  for (const r of rows) {
    const b = bucketExactCount(r.exact_count);
    exactBuckets.set(b, (exactBuckets.get(b) ?? 0) + 1);
  }

  // === Fallback step 命中分布 ===
  const stepDist = new Map<string, number>();
  let fallbackTriggered = 0;
  for (const r of rows) {
    if (r.fallback_chain) {
      fallbackTriggered++;
      const step = parseFirstFallbackStep(r.fallback_chain);
      if (step) {
        stepDist.set(step, (stepDist.get(step) ?? 0) + 1);
      }
    }
  }

  // === Vector unavailable rate ===
  const vectorUnavailable = rows.filter(r => r.vector_unavailable === 1).length;

  // === Exact zero rate ===
  const exactZero = rows.filter(r => r.exact_count === 0).length;

  // === 输出 ===
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 brain_recall metrics — 最近 ${days} 天 (${rows.length} 次 recall)`);
  console.log(`   DB: ${dbPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('\n📈 Exact count 分布:');
  const orderedBuckets = ['0', '1-2', '3-4', '5-9', '10+', 'null (legacy)'];
  for (const b of orderedBuckets) {
    const n = exactBuckets.get(b) ?? 0;
    if (n > 0) console.log(`   ${b.padEnd(15)} ${n.toString().padStart(5)} (${pct(n, rows.length)})`);
  }

  console.log('\n🔄 Fallback chain 触发:');
  console.log(`   触发率: ${fallbackTriggered}/${rows.length} (${pct(fallbackTriggered, rows.length)})`);
  if (stepDist.size > 0) {
    console.log('   第一步退化分布:');
    for (const [step, n] of [...stepDist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${step.padEnd(20)} ${n.toString().padStart(5)} (${pct(n, fallbackTriggered)})`);
    }
  }

  console.log('\n⚠️  健康度指标 (告警阈值见设计 doc §10.6):');
  const vectorRate = pct(vectorUnavailable, rows.length);
  const zeroRate = pct(exactZero, rows.length);
  console.log(`   vector_unavailable_rate: ${vectorRate} (告警 > 10%)`);
  console.log(`   exact_zero_rate:         ${zeroRate} (告警 周比突增 2×)`);

  // JSON 输出（pipe 到外部监控时用）
  if (process.env.OUTPUT_JSON === '1') {
    const json = {
      window_days: days,
      total: rows.length,
      exact_distribution: Object.fromEntries(exactBuckets),
      fallback: {
        triggered: fallbackTriggered,
        triggered_rate: fallbackTriggered / rows.length,
        step_dist: Object.fromEntries(stepDist),
      },
      vector_unavailable_count: vectorUnavailable,
      vector_unavailable_rate: vectorUnavailable / rows.length,
      exact_zero_count: exactZero,
      exact_zero_rate: exactZero / rows.length,
    };
    console.log('\n📦 JSON:');
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('\n💡 用 OUTPUT_JSON=1 跑这个脚本可拿到 JSON，方便外部监控接入。');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  db.close();
}

main();
