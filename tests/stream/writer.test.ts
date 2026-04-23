/**
 * stream/writer.ts 单元测试
 *
 * mock fs 和 config，测试输出格式和引用格式。
 *
 * Bug #13 修复后写入路径是 openSync('a') + writeSync + fsyncSync + closeSync，
 * 并配套 <path>.lock 排他文件锁；mock 也跟着改。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

// mock config
vi.mock('../../src/config.js', () => ({
  getDataDir: () => '/mock/data',
}));

// mock time
vi.mock('../../src/utils/time.js', () => ({
  today: () => '2026-04-08',
}));

// mock nanoid
vi.mock('nanoid', () => ({
  nanoid: () => 'ABCD',
}));

// mock fs
let writtenHeader = '';
let appendedContent = '';
let fileExists = false;
let nextFd = 100;
const fdToPath = new Map<number, string>();
let fsyncCalls = 0;
let lockHeld = false;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      accessSync: vi.fn((p: string) => {
        // 只对目标 .md 文件生效；锁文件应总能走 EEXIST 分支
        if (p.endsWith('.md') && !fileExists) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
      }),
      mkdirSync: vi.fn(),
      openSync: vi.fn((p: string, flag: string) => {
        if (typeof flag === 'string' && flag === 'wx') {
          // lock 文件：模拟跨进程互斥
          if (lockHeld) {
            throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          }
          lockHeld = true;
        }
        const fd = nextFd++;
        fdToPath.set(fd, p);
        return fd;
      }),
      writeSync: vi.fn((fd: number, content: string) => {
        const p = fdToPath.get(fd) ?? '';
        if (p.endsWith('.md.lock')) return content.length; // lock 内容忽略
        if (p.endsWith('.md')) {
          // 第一次写入：判断是 header 还是 block
          if (content.startsWith('# ') && !writtenHeader) {
            writtenHeader = content;
          } else {
            appendedContent += content;
          }
        }
        return content.length;
      }),
      fsyncSync: vi.fn(() => { fsyncCalls++; }),
      closeSync: vi.fn((fd: number) => {
        fdToPath.delete(fd);
      }),
      unlinkSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.endsWith('.md.lock')) {
          lockHeld = false;
        }
      }),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

import { appendToStream } from '../../src/stream/writer.js';

beforeEach(() => {
  writtenHeader = '';
  appendedContent = '';
  fileExists = false;
  fsyncCalls = 0;
  lockHeld = false;
  fdToPath.clear();
});

describe('appendToStream', () => {
  it('返回标准 stream 引用格式', () => {
    const ref = appendToStream({ content: '测试内容' });
    // stream/2026-04-08.md#s-HHMMSSMMM-ABCD
    expect(ref).toMatch(/^stream\/2026-04-08\.md#s-\d{9}-ABCD$/);
  });

  it('新文件时写入日期标题头', () => {
    appendToStream({ content: '内容' });
    expect(writtenHeader).toContain('# 2026-04-08');
  });

  it('已有文件时不重复写入标题头', () => {
    fileExists = true;
    appendToStream({ content: '新内容' });
    expect(writtenHeader).toBe('');
    expect(appendedContent).toContain('新内容');
  });

  it('包含 tool 和 session 信息', () => {
    appendToStream({ tool: 'cowork', session: 'sess-1', content: '内容' });
    expect(appendedContent).toContain('· cowork');
    expect(appendedContent).toContain('· sess-1');
  });

  it('不提供 tool 时标题行不包含 ·', () => {
    appendToStream({ content: '纯内容' });
    // 标题行只有时间
    const headerLine = appendedContent.split('\n').find(l => l.startsWith('## '));
    expect(headerLine).toBeTruthy();
    expect(headerLine).not.toContain('·');
  });

  it('包含 files 字段', () => {
    appendToStream({ content: '内容', files: ['a.ts', 'b.ts'] });
    expect(appendedContent).toContain('files: a.ts, b.ts');
  });

  it('新文件时创建目录', () => {
    appendToStream({ content: '内容' });
    expect(fs.mkdirSync).toHaveBeenCalled();
  });

  it('包含锚点标签', () => {
    appendToStream({ content: '内容' });
    expect(appendedContent).toMatch(/<a id="s-\d{9}-ABCD"><\/a>/);
  });

  it('以 --- 分隔符结尾', () => {
    appendToStream({ content: '内容' });
    expect(appendedContent.trimEnd()).toMatch(/---$/);
  });

  it('每次 append 至少调用一次 fsyncSync（持久性保证）', () => {
    appendToStream({ content: '内容' });
    // 新文件场景：header fsync + block fsync = 2 次
    expect(fsyncCalls).toBeGreaterThanOrEqual(1);
  });

  it('写完后释放锁文件', () => {
    appendToStream({ content: '内容' });
    expect(lockHeld).toBe(false);
  });

  it('两次连续 append 不会因为锁残留而失败', () => {
    appendToStream({ content: '第一条' });
    appendToStream({ content: '第二条' });
    expect(appendedContent).toContain('第一条');
    expect(appendedContent).toContain('第二条');
    expect(lockHeld).toBe(false);
  });
});
