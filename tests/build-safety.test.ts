/**
 * 构建产物的健康检查。
 *
 * 关键守护：确保 dist/ 里没有裸 `require(...)` 调用。
 *
 * 背景：package.json 有 "type": "module"，dist/ 被 tsc 编译成 ESM，
 * 而 Node.js ESM 下 `require` 不是 global。一旦源码里有 `const x = require(...)`
 * 字面量，TS 会原样保留到 dist/。运行时会 `ReferenceError: require is not defined`，
 * 被 try/catch 吞掉后静默降级，bug 很难被察觉（vitest 用自己的 loader，在测试里
 * require 其实可用，所以单元测试永远抓不到）。
 *
 * 这个测试直接扫描 dist/ 源码做兜底。需要先 `npm run build`。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

function walkJsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile() && (p.endsWith('.js') || p.endsWith('.mjs'))) {
        out.push(p);
      }
    }
  }
  return out;
}

describe('dist/ 构建产物守护', () => {
  it('dist/ 目录应存在（未 build 时本 suite 会 skip）', () => {
    // 如果 dist 不存在，跳过整个 suite（本地首次运行可能还没 build）
    if (!fs.existsSync(distDir)) {
      console.warn('[build-safety] dist/ 不存在，跳过扫描。请先 `npm run build`');
    }
    expect(true).toBe(true);
  });

  // 只在 dist 存在时才真正运行扫描
  const shouldRun = fs.existsSync(distDir);
  it.skipIf(!shouldRun)('dist/**/*.js 里不应出现裸的 require(...) 调用', () => {
    const files = walkJsFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    // 正则说明：
    //   \brequire\s*\(    匹配 "require(" 或 "require  ("
    //   后面跟着引号开头的模块名，排除注释里的提及
    // 我们也排除 createRequire 产物里的合法 require 变量（如果以后有的话）
    const bareRequireRe = /\brequire\s*\(\s*['"]/g;

    const offenders: Array<{ file: string; line: number; snippet: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 跳过注释行
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        // 跳过明确由 createRequire 创建的 require 变量（如果我们后续引入）
        if (/const\s+require\s*=\s*createRequire/.test(line)) continue;
        if (bareRequireRe.test(line)) {
          offenders.push({
            file: path.relative(distDir, file),
            line: i + 1,
            snippet: line.trim().slice(0, 120),
          });
        }
        bareRequireRe.lastIndex = 0; // reset
      }
    }

    if (offenders.length > 0) {
      console.error('dist/ 里发现裸 require 调用:');
      for (const o of offenders) {
        console.error(`  ${o.file}:${o.line}  ${o.snippet}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
