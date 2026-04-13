/**
 * time-inference.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs 以控制 statSync 返回值
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn(),
    },
  };
});

import fs from 'node:fs';
import type { ClassifiedFile, ObsidianVaultConfig } from '../../../src/integrations/obsidian/types.js';
import { inferPageDates } from '../../../src/integrations/obsidian/time-inference.js';

const mockStatSync = vi.mocked(fs.statSync);

/** 构造 ClassifiedFile 的便捷方法 */
function makeFile(
  relPath: string,
  absPath: string,
  category: ClassifiedFile['category'] = 'regular',
): ClassifiedFile {
  return { relPath, absPath, category, inDegree: 0 };
}

/** 默认 vault 配置 */
const defaultConfig: ObsidianVaultConfig = {
  dailyNotes: { folder: 'daily', format: 'YYYY-MM-DD', template: '' },
  attachmentFolder: '',
  templateFolder: '',
  useMarkdownLinks: false,
};

/** 构造带 frontmatter 的内容 */
function withFrontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\nBody content`;
}

beforeEach(() => {
  mockStatSync.mockReset();
});

// ===== Frontmatter 日期字段 =====

describe('frontmatter date extraction', () => {
  it('ISO 格式 date 字段', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({ date: '2024-06-15' });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')).toEqual({
      date: '2024-06-15',
      source: 'frontmatter',
      confidence: 0.95,
    });
  });

  it('created 字段', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({ created: '2023-01-20' });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')!.date).toBe('2023-01-20');
    expect(result.get('note.md')!.source).toBe('frontmatter');
  });

  it('creation_date 字段', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({ creation_date: '2022-12-01' });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')!.date).toBe('2022-12-01');
  });

  it('自然语言日期 "Friday, December 9th 2022, 1:37:28 am"', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({
      date: 'Friday, December 9th 2022, 1:37:28 am',
    });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')!.date).toBe('2022-12-09');
  });

  it('"September 7th 2021" 格式', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({ date: 'September 7th 2021' });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')!.date).toBe('2021-09-07');
  });

  it('DATE_FIELD_PRIORITY 顺序：date 优先于 modified', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({
      modified: '2024-12-01',
      date: '2024-01-15',
    });

    const result = inferPageDates(files, readContent, defaultConfig);
    // date 在优先级列表中排在 modified 前面
    expect(result.get('note.md')!.date).toBe('2024-01-15');
  });

  it('Templater 占位符 → 跳过', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({
      date: '<% tp.file.creation_date("YYYY-MM-DD") %>',
    });

    // statSync 也不返回有效值 → 走中位数兜底
    mockStatSync.mockImplementation(() => { throw new Error('no stat'); });

    const result = inferPageDates(files, readContent, defaultConfig);
    // 不应从 frontmatter 获取日期
    expect(result.get('note.md')!.source).not.toBe('frontmatter');
  });

  it('无效日期值 → 跳过，不崩溃', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => withFrontmatter({ date: 'not-a-date' });

    mockStatSync.mockImplementation(() => { throw new Error('no stat'); });

    const result = inferPageDates(files, readContent, defaultConfig);
    // 无法从 frontmatter 解析，走兜底
    expect(result.get('note.md')!.source).not.toBe('frontmatter');
  });
});

// ===== Daily Note 文件名 =====

describe('daily note filename', () => {
  it('YYYY-MM-DD.md 格式', () => {
    const files = [makeFile('daily/2024-03-15.md', '/vault/daily/2024-03-15.md', 'daily_note')];
    const readContent = () => 'no frontmatter here';

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('daily/2024-03-15.md')).toEqual({
      date: '2024-03-15',
      source: 'daily_note_filename',
      confidence: 0.95,
    });
  });
});

// ===== 文件系统兜底 =====

describe('filesystem fallback', () => {
  it('birthtime 兜底', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => 'no frontmatter';

    mockStatSync.mockReturnValue({
      birthtime: new Date('2024-05-01T12:00:00Z'),
      mtime: new Date('2024-06-01T12:00:00Z'),
    } as unknown as fs.Stats);

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('note.md')!.date).toBe('2024-05-01');
    expect(result.get('note.md')!.source).toBe('fs_birthtime');
    expect(result.get('note.md')!.confidence).toBe(0.7);
  });

  it('mtime 兜底（birthtime 为 epoch 0）', () => {
    const files = [makeFile('note.md', '/vault/note.md')];
    const readContent = () => 'no frontmatter';

    mockStatSync.mockReturnValue({
      birthtime: new Date(0),
      mtime: new Date('2024-07-20T12:00:00Z'),
    } as unknown as fs.Stats);

    const result = inferPageDates(files, readContent, defaultConfig);
    // birthtime.getTime() === 0 → 不满足 > 0 条件 → 走 mtime
    expect(result.get('note.md')!.date).toBe('2024-07-20');
    expect(result.get('note.md')!.source).toBe('fs_mtime');
    expect(result.get('note.md')!.confidence).toBe(0.5);
  });
});

// ===== 中位数兜底 =====

describe('median fallback', () => {
  it('无任何时间信息 → 使用其他文件的中位数', () => {
    const files = [
      makeFile('a.md', '/vault/a.md'),
      makeFile('orphan.md', '/vault/orphan.md'),
    ];

    const readContent = (p: string) => {
      if (p === '/vault/a.md') return withFrontmatter({ date: '2024-06-15' });
      return 'no info';
    };

    mockStatSync.mockImplementation(() => { throw new Error('no stat'); });

    const result = inferPageDates(files, readContent, defaultConfig);
    expect(result.get('orphan.md')!.source).toBe('median_fallback');
    expect(result.get('orphan.md')!.confidence).toBe(0.3);
    // 只有一个已知日期，中位数就是它
    expect(result.get('orphan.md')!.date).toBe('2024-06-15');
  });
});

// ===== 多文件混合 =====

describe('mixed sources', () => {
  it('多文件使用不同时间来源', () => {
    const files = [
      makeFile('fm.md', '/vault/fm.md'),
      makeFile('daily/2024-01-01.md', '/vault/daily/2024-01-01.md', 'daily_note'),
      makeFile('fs-file.md', '/vault/fs-file.md'),
    ];

    const readContent = (p: string) => {
      if (p === '/vault/fm.md') return withFrontmatter({ date: '2024-03-01' });
      return 'no frontmatter';
    };

    mockStatSync.mockReturnValue({
      birthtime: new Date('2024-08-01T00:00:00Z'),
      mtime: new Date('2024-09-01T00:00:00Z'),
    } as unknown as fs.Stats);

    const result = inferPageDates(files, readContent, defaultConfig);

    expect(result.get('fm.md')!.source).toBe('frontmatter');
    expect(result.get('daily/2024-01-01.md')!.source).toBe('daily_note_filename');
    expect(result.get('fs-file.md')!.source).toBe('fs_birthtime');
  });
});
