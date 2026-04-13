/**
 * integrations/logseq/classifier.ts 单元测试
 *
 * 分类逻辑 + 入度统计（mock 文件系统）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

// mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// mock fs：用 Map 模拟文件内容
const fileStore = new Map<string, { content: string; size: number }>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn((p: string) => {
        const entry = fileStore.get(p);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { size: entry.size };
      }),
      readFileSync: vi.fn((p: string) => {
        const entry = fileStore.get(p);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return entry.content;
      }),
    },
  };
});

import { classifyFiles, buildInDegreeMap, type ClassifiedFile } from '../../../src/integrations/logseq/classifier.js';

const ROOT = '/mock/logseq';

function setFile(relPath: string, content: string) {
  const fullPath = `${ROOT}/${relPath}`;
  fileStore.set(fullPath, { content, size: Buffer.byteLength(content, 'utf-8') });
  return fullPath;
}

beforeEach(() => {
  fileStore.clear();
});

// ===== classifyFiles =====

describe('classifyFiles', () => {
  it('日记分类：journals/ 目录', () => {
    const p = setFile('journals/2026_04_08.md', '- 今天做了很多事情');
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('journal');
    expect(result.files[0].journalDate).toBe('2026-04-08');
  });

  it('日记分类：文件名日期格式', () => {
    const p = setFile('journals/2026-03-15.md', '- 笔记');
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('journal');
  });

  it('PDF 注释分类：hls__ 前缀', () => {
    const p = setFile('pages/hls__SomeBook.md', '一些 PDF 标注内容，这是一个比较长的内容用来让文件大小超过阈值。' + 'x'.repeat(200));
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('pdf_annotation');
  });

  it('空白页分类：字节数 <= 2', () => {
    const p = setFile('pages/EmptyTag.md', '');
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('empty_tag');
  });

  it('极短定义页：< 200 字节 + <= 2 行', () => {
    const p = setFile('pages/ShortDef.md', '一个简短的定义');
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('short_definition');
  });

  it('极短但多行 → normal', () => {
    const content = '行1\n行2\n行3';
    const p = setFile('pages/ShortMultiLine.md', content);
    const result = classifyFiles([p], ROOT);
    // < 200 字节但 > 2 行 → normal
    expect(result.files[0].category).toBe('normal');
  });

  it('索引页：引用数 >= 30', () => {
    const refs = Array.from({ length: 35 }, (_, i) => `[[Page${i}]]`).join('\n');
    const p = setFile('pages/IndexPage.md', refs);
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('index_page');
    expect(result.files[0].refCount).toBe(35);
  });

  it('普通页面', () => {
    const content = '这是一个内容较长的普通页面。\n包含一些 [[引用]] 但不多。\n' + 'x'.repeat(300);
    const p = setFile('pages/Normal.md', content);
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].category).toBe('normal');
  });

  it('文件读取失败跳过', () => {
    const result = classifyFiles(['/mock/logseq/pages/Nonexistent.md'], ROOT);
    expect(result.files).toHaveLength(0);
  });

  it('summary 统计正确', () => {
    setFile('journals/2026_01_01.md', '日记内容');
    setFile('pages/Empty.md', '');
    setFile('pages/Normal.md', '正常页面内容。\n' + 'x'.repeat(300));
    const paths = [
      `${ROOT}/journals/2026_01_01.md`,
      `${ROOT}/pages/Empty.md`,
      `${ROOT}/pages/Normal.md`,
    ];
    const result = classifyFiles(paths, ROOT);
    expect(result.summary.total).toBe(3);
    expect(result.summary.byCategory.journal).toBe(1);
    expect(result.summary.byCategory.empty_tag).toBe(1);
    expect(result.summary.byCategory.normal).toBe(1);
  });

  it('标题从文件名解码', () => {
    const p = setFile('pages/My%2FPage.md', '内容\n' + 'x'.repeat(300));
    const result = classifyFiles([p], ROOT);
    expect(result.files[0].title).toBe('My/Page');
  });
});

// ===== buildInDegreeMap =====

describe('buildInDegreeMap', () => {
  it('计算被引用次数', () => {
    const files: ClassifiedFile[] = [
      { filePath: 'a', relPath: 'a', category: 'normal', title: 'PageA', fileSize: 100, refCount: 0 },
      { filePath: 'b', relPath: 'b', category: 'normal', title: 'PageB', fileSize: 100, refCount: 0 },
      { filePath: 'c', relPath: 'c', category: 'normal', title: 'PageC', fileSize: 100, refCount: 0 },
    ];

    const readContent = (p: string) => {
      if (p === 'a') return '引用 [[PageB]] 和 [[PageC]]';
      if (p === 'b') return '引用 [[PageC]]';
      return '无引用';
    };

    const map = buildInDegreeMap(files, readContent);
    expect(map.get('PageB')).toBe(1); // 被 A 引用
    expect(map.get('PageC')).toBe(2); // 被 A 和 B 引用
    expect(map.has('PageA')).toBe(false); // 无人引用
  });

  it('自引用不计入', () => {
    const files: ClassifiedFile[] = [
      { filePath: 'a', relPath: 'a', category: 'normal', title: 'Self', fileSize: 100, refCount: 0 },
    ];
    const readContent = () => '引用 [[Self]] 自己';
    const map = buildInDegreeMap(files, readContent);
    expect(map.has('Self')).toBe(false);
  });

  it('同文件内多次引用同一页只计 1 次', () => {
    const files: ClassifiedFile[] = [
      { filePath: 'a', relPath: 'a', category: 'normal', title: 'A', fileSize: 100, refCount: 0 },
      { filePath: 'b', relPath: 'b', category: 'normal', title: 'B', fileSize: 100, refCount: 0 },
    ];
    const readContent = (p: string) => {
      if (p === 'a') return '[[B]] again [[B]] and [[B]]';
      return '';
    };
    const map = buildInDegreeMap(files, readContent);
    expect(map.get('B')).toBe(1); // 只计 1 次
  });

  it('引用不存在的页面不计入', () => {
    const files: ClassifiedFile[] = [
      { filePath: 'a', relPath: 'a', category: 'normal', title: 'A', fileSize: 100, refCount: 0 },
    ];
    const readContent = () => '引用 [[Nonexistent]]';
    const map = buildInDegreeMap(files, readContent);
    expect(map.size).toBe(0);
  });

  it('readContent 返回 null 的文件跳过', () => {
    const files: ClassifiedFile[] = [
      { filePath: 'a', relPath: 'a', category: 'normal', title: 'A', fileSize: 100, refCount: 0 },
    ];
    const readContent = () => null;
    const map = buildInDegreeMap(files, readContent);
    expect(map.size).toBe(0);
  });
});
