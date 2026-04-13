/**
 * 运行所有 prompt 测试
 *
 * 用法: npx tsx tests/prompts/run-all.ts
 * 单个: npx tsx tests/prompts/test-link-evaluate.ts
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

const TESTS = [
  'test-link-evaluate.ts',
  'test-annotate.ts',
  'test-link-discover.ts',
  'test-link-revalidate.ts',
  'test-crystal.ts',
  'test-reconsolidate.ts',
  'test-keystone.ts',
  'test-temporal.ts',
  'test-prepare.ts',
];

const dir = path.dirname(new URL(import.meta.url).pathname);

for (const test of TESTS) {
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# ${test}`);
  console.log(`${'#'.repeat(60)}\n`);

  try {
    execSync(`npx tsx ${path.join(dir, test)}`, {
      stdio: 'inherit',
      timeout: 600_000, // 10 分钟超时
    });
  } catch {
    console.error(`\n⚠ ${test} 执行失败\n`);
  }
}
