/**
 * 时间推断六层策略链单元测试
 */
import { describe, it, expect } from 'vitest';
import { inferPageDates, sortByTime, getEffectiveDate } from '../../../src/integrations/logseq/time-inference.js';
import type { ClassifiedFile } from '../../../src/integrations/logseq/classifier.js';

function makeFile(overrides: Partial<ClassifiedFile> & { title: string }): ClassifiedFile {
  return {
    filePath: `/mock/pages/${overrides.title}.md`,
    relPath: `pages/${overrides.title}.md`,
    category: 'normal',
    fileSize: 100,
    refCount: 0,
    ...overrides,
  };
}

function makeJournal(date: string, content: string): ClassifiedFile & { _content: string } {
  return {
    filePath: `/mock/journals/${date.replace(/-/g, '_')}.md`,
    relPath: `journals/${date.replace(/-/g, '_')}.md`,
    category: 'journal',
    title: date,
    fileSize: content.length,
    journalDate: date,
    refCount: 0,
    _content: content,
  } as ClassifiedFile & { _content: string };
}

describe('inferPageDates - 六层策略', () => {
  // 构建测试数据集
  const journals = [
    makeJournal('2022-06-01', '今天开始学 [[AI]] 和 [[机器学习]]'),
    makeJournal('2023-01-15', '回顾 [[AI]] 进展，开始看 [[深度学习]]'),
    makeJournal('2024-03-10', '继续研究 [[AI]]'),
  ];

  const pages = [
    makeFile({ title: 'AI' }),                                     // 层 2: 被日记引用
    makeFile({ title: '机器学习' }),                                // 层 2: 被日记引用
    makeFile({ title: '深度学习' }),                                // 层 2: 被日记引用
    makeFile({ title: '神经网络', filePath: '/mock/pages/神经网络.md' }),  // 层 3: 被页面引用
    makeFile({ title: '卷积' }),                                    // 层 4: 关键词搜索
    makeFile({ title: '变分推断' }),                                // 层 5: 出度推断
    makeFile({ title: 'AI 2' }),                                   // 层 5.5: 重复页继承
    makeFile({ title: '量子计算' }),                                // 层 6: 兜底
    makeFile({                                                     // 层 1.5: PDF 时间戳
      title: 'hls__some_paper_1667967586558_0',
      category: 'pdf_annotation',
      filePath: '/mock/pages/hls__some_paper_1667967586558_0.md',
    }),
  ];

  // 页面内容 mock
  const contentMap: Record<string, string> = {
    '/mock/pages/AI.md': '人工智能是计算机科学的分支',
    '/mock/pages/机器学习.md': '机器学习是 [[AI]] 的子领域，包括 [[神经网络]]',
    '/mock/pages/深度学习.md': '深度学习基于 [[神经网络]]',
    '/mock/pages/神经网络.md': '神经网络有多种架构，包括卷积网络',
    '/mock/pages/卷积.md': '卷积是一种数学运算',
    '/mock/pages/变分推断.md': '变分推断引用了 [[深度学习]] 和 [[AI]]',
    '/mock/pages/AI 2.md': '这是 AI 的重复页',
    '/mock/pages/量子计算.md': '量子计算是新兴领域',
    '/mock/pages/hls__some_paper_1667967586558_0.md': '一些 PDF 标注内容',
  };

  // 日记内容已经通过 _content 属性存储
  for (const j of journals) {
    contentMap[j.filePath] = (j as unknown as { _content: string })._content;
  }

  const readContent = (fp: string) => contentMap[fp] ?? null;
  const allFiles = [...journals, ...pages] as ClassifiedFile[];

  const result = inferPageDates(allFiles, readContent);

  it('层 1: 日记文件名 → journal_name', () => {
    const info = result.get('2022-06-01');
    expect(info).toBeDefined();
    expect(info!.source).toBe('journal_name');
    expect(info!.date).toBe('2022-06-01');
  });

  it('层 2: 日记引用 → journal_ref，含 firstRef/lastRef', () => {
    const aiInfo = result.get('AI');
    expect(aiInfo).toBeDefined();
    expect(aiInfo!.source).toBe('journal_ref');
    expect(aiInfo!.date).toBe('2022-06-01');       // 首次引用
    expect(aiInfo!.firstRef).toBe('2022-06-01');
    expect(aiInfo!.lastRef).toBe('2024-03-10');    // 末次引用
  });

  it('层 1.5: PDF 注释时间戳 → hls_timestamp', () => {
    const info = result.get('hls__some_paper_1667967586558_0');
    expect(info).toBeDefined();
    expect(info!.source).toBe('hls_timestamp');
    // 1667967586558 ms = 2022-11-09
    expect(info!.date).toBe('2022-11-09');
  });

  it('层 3: 页面引用链 → page_ref_chain', () => {
    const info = result.get('神经网络');
    expect(info).toBeDefined();
    expect(info!.source).toBe('page_ref_chain');
    // 被 机器学习 和 深度学习 引用，它们有日期
  });

  it('层 4: 关键词搜索 → keyword_search', () => {
    // "卷积" 这个词出现在神经网络页面的正文中
    const info = result.get('卷积');
    expect(info).toBeDefined();
    expect(info!.source).toBe('keyword_search');
  });

  it('层 5: 出度推断 → outdegree', () => {
    const info = result.get('变分推断');
    expect(info).toBeDefined();
    expect(info!.source).toBe('outdegree');
    // 变分推断引用了 深度学习 和 AI，取它们中最早的日期
  });

  it('层 5.5: 重复页继承 → duplicate_inherit', () => {
    const info = result.get('AI 2');
    expect(info).toBeDefined();
    expect(info!.source).toBe('duplicate_inherit');
    expect(info!.date).toBe(result.get('AI')!.date);
  });

  it('层 6: 兜底 → fallback', () => {
    const info = result.get('量子计算');
    expect(info).toBeDefined();
    expect(info!.source).toBe('fallback');
    // 中位数日期
  });

  it('所有页面都有推断结果', () => {
    for (const p of pages) {
      expect(result.has(p.title)).toBe(true);
    }
  });
});

describe('sortByTime', () => {
  it('有日期的排在无日期前面', () => {
    const files = [
      makeFile({ title: 'B' }),
      makeFile({ title: 'A' }),
    ];
    const dates = inferPageDates([], () => null);
    dates.set('A', { date: '2023-01-01', source: 'journal_ref' });

    const sorted = sortByTime(files, dates);
    expect(sorted[0].title).toBe('A');
  });
});

describe('getEffectiveDate', () => {
  it('日记直接返回 journalDate', () => {
    const file = makeFile({ title: '2024-01-01', journalDate: '2024-01-01', category: 'journal' });
    const dates = new Map();
    expect(getEffectiveDate(file, dates)).toBe('2024-01-01');
  });

  it('有 lastRef 且比 date 晚时返回 lastRef', () => {
    const file = makeFile({ title: 'Test' });
    const dates = new Map();
    dates.set('Test', { date: '2022-01-01', source: 'journal_ref' as const, lastRef: '2024-06-01' });
    expect(getEffectiveDate(file, dates)).toBe('2024-06-01');
  });

  it('无推断日期返回 null', () => {
    const file = makeFile({ title: 'Unknown' });
    const dates = new Map();
    expect(getEffectiveDate(file, dates)).toBeNull();
  });
});
