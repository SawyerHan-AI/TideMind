/**
 * stream/writer.ts 单元测试
 *
 * mock fs 和 config，测试输出格式和引用格式。
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

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      accessSync: vi.fn(() => {
        if (!fileExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((_p: string, content: string) => {
        writtenHeader = content;
      }),
      appendFileSync: vi.fn((_p: string, content: string) => {
        appendedContent += content;
      }),
    },
  };
});

import { appendToStream } from '../../src/stream/writer.js';

beforeEach(() => {
  writtenHeader = '';
  appendedContent = '';
  fileExists = false;
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
});
