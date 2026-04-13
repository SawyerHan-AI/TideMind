/**
 * stream/reader.ts 单元测试
 *
 * parseStreamRef 是纯函数，readStreamEntry 需要 mock fs。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

// mock config
vi.mock('../../src/config.js', () => ({
  getDataDir: () => '/mock/data',
}));

// mock logger
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// mock fs
const mockFiles = new Map<string, string>();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => mockFiles.has(p)),
      readFileSync: vi.fn((p: string) => {
        const content = mockFiles.get(p);
        if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      }),
    },
  };
});

import { parseStreamRef, readStreamEntry } from '../../src/stream/reader.js';

beforeEach(() => {
  mockFiles.clear();
});

// ===== parseStreamRef =====

describe('parseStreamRef', () => {
  it('解析标准 stream 引用', () => {
    const result = parseStreamRef('stream/2026-04-08.md#s-143025123-abcd');
    expect(result).toEqual({
      filePath: '/mock/data/stream/2026-04-08.md',
      anchorId: 's-143025123-abcd',
    });
  });

  it('无效格式返回 null', () => {
    expect(parseStreamRef('invalid')).toBeNull();
    expect(parseStreamRef('stream/file.txt#anchor')).toBeNull(); // 非 .md
    expect(parseStreamRef('other/2026-04-08.md#anchor')).toBeNull(); // 非 stream/ 前缀
  });

  it('缺少锚点返回 null', () => {
    expect(parseStreamRef('stream/2026-04-08.md')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseStreamRef('')).toBeNull();
  });
});

// ===== readStreamEntry =====

describe('readStreamEntry', () => {
  it('读取完整的 stream 条目', () => {
    const content = [
      '# 2026-04-08',
      '',
      '<a id="s-120000000-xxxx"></a>',
      '',
      '## 12:00:00 · cowork · session-1',
      '',
      '这是测试内容',
      '',
      '---',
      '',
    ].join('\n');

    mockFiles.set('/mock/data/stream/2026-04-08.md', content);

    const entry = readStreamEntry('stream/2026-04-08.md#s-120000000-xxxx');
    expect(entry).not.toBeNull();
    expect(entry!.anchorId).toBe('s-120000000-xxxx');
    expect(entry!.time).toBe('12:00:00');
    expect(entry!.tool).toBe('cowork');
    expect(entry!.session).toBe('session-1');
    expect(entry!.content).toBe('这是测试内容');
  });

  it('带 files 字段', () => {
    const content = [
      '<a id="s-130000000-yyyy"></a>',
      '',
      '## 13:00:00 · tool1',
      '',
      '内容',
      'files: a.ts, b.ts',
      '',
      '---',
      '',
    ].join('\n');

    mockFiles.set('/mock/data/stream/2026-04-08.md', content);

    const entry = readStreamEntry('stream/2026-04-08.md#s-130000000-yyyy');
    expect(entry!.files).toEqual(['a.ts', 'b.ts']);
  });

  it('文件不存在返回 null', () => {
    expect(readStreamEntry('stream/2099-01-01.md#anchor')).toBeNull();
  });

  it('锚点不存在返回 null', () => {
    mockFiles.set('/mock/data/stream/2026-04-08.md', '# 空文件');
    expect(readStreamEntry('stream/2026-04-08.md#nonexistent')).toBeNull();
  });

  it('无效引用格式返回 null', () => {
    expect(readStreamEntry('garbage')).toBeNull();
  });

  it('多条目中提取正确的条目', () => {
    const content = [
      '<a id="s-100000000-aaaa"></a>',
      '',
      '## 10:00:00 · tool-a',
      '',
      '第一条',
      '',
      '---',
      '',
      '<a id="s-110000000-bbbb"></a>',
      '',
      '## 11:00:00 · tool-b',
      '',
      '第二条',
      '',
      '---',
      '',
    ].join('\n');

    mockFiles.set('/mock/data/stream/2026-04-08.md', content);

    const entry = readStreamEntry('stream/2026-04-08.md#s-110000000-bbbb');
    expect(entry!.time).toBe('11:00:00');
    expect(entry!.tool).toBe('tool-b');
    expect(entry!.content).toBe('第二条');
  });
});
