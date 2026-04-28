/**
 * stream/writer.ts 并发写入测试（Bug #13）
 *
 * 用真实 fs（指向临时目录）验证：
 * 1. 多次连续 append 不会因为锁残留而失败
 * 2. 文件结构没有字节级交错（每个 anchor 后必须紧跟对应 header）
 * 3. fsync 路径走通——文件落盘后能被立刻读到完整内容
 * 4. 写完后 .lock 文件不残留
 *
 * 注：单进程内 appendToStream 是同步的，事件循环里 Promise.all 不会真正并行；
 * 真正的跨进程并发由 fs.openSync(path, 'wx') 的 EEXIST 语义保证，已在
 * writer.ts 注释里说明。这里覆盖"高频反复调用 + 真实 fs"路径足够回归。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-stream-concur-'));
let currentDataDir = '';

vi.mock('../../src/config.js', () => ({
  getDataDir: () => currentDataDir,
}));

beforeEach(() => {
  currentDataDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
});

afterEach(() => {
  // 不递归清理（避免 macOS Spotlight 占用），只清理本测试创建的 stream 子树
  try {
    const streamDir = path.join(currentDataDir, 'stream');
    if (fs.existsSync(streamDir)) {
      for (const f of fs.readdirSync(streamDir)) {
        try { fs.unlinkSync(path.join(streamDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
});

describe('appendToStream concurrent safety (Bug #13)', () => {
  it('连续 100 次 append 都成功且 anchor ID 唯一', async () => {
    const { appendToStream } = await import('../../src/stream/writer.js');
    const refs: string[] = [];
    for (let i = 0; i < 100; i++) {
      refs.push(appendToStream({ content: `entry-${i}`, tool: 'test' }));
    }
    expect(new Set(refs).size).toBe(100);
  });

  it('写完后 .lock 文件不残留', async () => {
    const { appendToStream } = await import('../../src/stream/writer.js');
    const ref = appendToStream({ content: '内容' });
    const fname = ref.split('#')[0]; // stream/YYYY-MM-DD.md
    const filePath = path.join(currentDataDir, fname);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  it('文件结构未被交错（每个 anchor 后紧跟对应 header）', async () => {
    const { appendToStream } = await import('../../src/stream/writer.js');
    const N = 50;
    const refs: string[] = [];
    for (let i = 0; i < N; i++) {
      refs.push(appendToStream({ content: `entry-${i}`, tool: 'test' }));
    }
    const fname = refs[0].split('#')[0];
    const filePath = path.join(currentDataDir, fname);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 每条目格式: <a id="s-..."></a>\n\n## HH:MM:SS · test\n\nentry-i\n\n---\n
    const anchorRegex = /<a id="s-[^"]+"><\/a>\n\n## \d{2}:\d{2}:\d{2} · test/g;
    const matches = content.match(anchorRegex) || [];
    expect(matches.length).toBe(N);

    // 所有 entry 内容都在
    for (let i = 0; i < N; i++) {
      expect(content).toContain(`entry-${i}`);
    }
  });

  it('fsync 路径生效——写后立刻 read 能拿到完整内容', async () => {
    const { appendToStream } = await import('../../src/stream/writer.js');
    const ref = appendToStream({ content: 'persistent payload xyz', tool: 't' });
    const fname = ref.split('#')[0];
    const filePath = path.join(currentDataDir, fname);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('persistent payload xyz');
    expect(content.endsWith('---\n')).toBe(true);
  });

  it('当 .lock 已存在且 stale (>30s) 时能强行抢占', async () => {
    const { appendToStream } = await import('../../src/stream/writer.js');
    const { today } = await import('../../src/utils/time.js');
    const dataDir = currentDataDir;
    const streamDir = path.join(dataDir, 'stream');
    fs.mkdirSync(streamDir, { recursive: true });
    // 找出今天的 lock path
    const filePath = path.join(streamDir, `${today()}.md`);
    const lockPath = `${filePath}.lock`;
    // 创建 stale lock：mtime 设为 1 分钟前
    fs.writeFileSync(lockPath, '');
    const past = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, past, past);

    const ref = appendToStream({ content: 'after-stale-lock' });
    expect(ref).toMatch(/^stream\//);
    expect(fs.existsSync(lockPath)).toBe(false);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('after-stale-lock');
  });
});
