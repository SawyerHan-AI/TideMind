/**
 * Logseq version-files 扫描与去重测试
 *
 * 测试 scanVersionFiles 的目录扫描/解析能力，
 * 以及 deduplicateVersions 的按天去重和 hash 去重逻辑。
 * 使用真实临时文件系统。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanVersionFiles, deduplicateVersions } from '../../../src/integrations/logseq/version-files.js';

let tmpDir: string;

/** 在 tmpDir 下创建文件，自动创建中间目录 */
function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-version-files-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// scanVersionFiles
// ============================================================

describe('scanVersionFiles', () => {
  it('version-files 目录不存在时返回空 Map', () => {
    const result = scanVersionFiles(tmpDir);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('目录存在但为空时返回空 Map', () => {
    fs.mkdirSync(path.join(tmpDir, 'logseq', 'version-files', 'local', 'pages'), {
      recursive: true,
    });
    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it('解析 pages 目录下的版本文件', () => {
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.md',
      'version content',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('pages/MyPage')).toBe(true);

    const versions = result.get('pages/MyPage')!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      originalName: 'MyPage',
      timestamp: '2022-10-26T06:05:24.726Z',
      date: '2022-10-26',
      source: 'pages',
    });
    expect(versions[0].absPath).toContain('MyPage');
  });

  it('解析 journals 目录下的版本文件', () => {
    writeFile(
      'logseq/version-files/local/journals/2023-01-15/2023-01-15T12_30_00.000Z.Laptop.md',
      'journal version',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('journals/2023-01-15')).toBe(true);

    const versions = result.get('journals/2023-01-15')!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      originalName: '2023-01-15',
      timestamp: '2023-01-15T12:30:00.000Z',
      date: '2023-01-15',
      source: 'journals',
    });
  });

  it('正确还原时间戳中的下划线为冒号', () => {
    writeFile(
      'logseq/version-files/local/pages/Test/2024-03-01T23_59_59.999Z.Phone.md',
      'content',
    );

    const result = scanVersionFiles(tmpDir);
    const v = result.get('pages/Test')![0];
    expect(v.timestamp).toBe('2024-03-01T23:59:59.999Z');
    expect(v.date).toBe('2024-03-01');
  });

  it('同一原始文件的多个版本按 key 分组', () => {
    writeFile(
      'logseq/version-files/local/pages/Notes/2022-01-01T10_00_00.000Z.Desktop.md',
      'v1',
    );
    writeFile(
      'logseq/version-files/local/pages/Notes/2022-01-02T10_00_00.000Z.Desktop.md',
      'v2',
    );
    writeFile(
      'logseq/version-files/local/pages/Notes/2022-01-03T10_00_00.000Z.Desktop.md',
      'v3',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get('pages/Notes')).toHaveLength(3);
  });

  it('不同原始文件分到不同分组', () => {
    writeFile(
      'logseq/version-files/local/pages/PageA/2022-01-01T10_00_00.000Z.Desktop.md',
      'a',
    );
    writeFile(
      'logseq/version-files/local/pages/PageB/2022-01-01T10_00_00.000Z.Desktop.md',
      'b',
    );
    writeFile(
      'logseq/version-files/local/journals/2022-01-01/2022-01-01T10_00_00.000Z.Desktop.md',
      'j',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(3);
    expect(result.has('pages/PageA')).toBe(true);
    expect(result.has('pages/PageB')).toBe(true);
    expect(result.has('journals/2022-01-01')).toBe(true);
  });

  it('跳过非 .md 文件', () => {
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.md',
      'good',
    );
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.txt',
      'ignored',
    );
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.org',
      'ignored',
    );
    writeFile(
      'logseq/version-files/local/pages/MyPage/notes.json',
      '{}',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.get('pages/MyPage')).toHaveLength(1);
  });

  it('跳过文件名不符合时间戳格式的 .md 文件', () => {
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.md',
      'valid',
    );
    // 缺少毫秒
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24Z.Desktop.md',
      'invalid - no ms',
    );
    // 随意命名
    writeFile(
      'logseq/version-files/local/pages/MyPage/backup.md',
      'invalid - random name',
    );
    // 日期格式错误
    writeFile(
      'logseq/version-files/local/pages/MyPage/22-10-26T06_05_24.726Z.Desktop.md',
      'invalid - short year',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.get('pages/MyPage')).toHaveLength(1);
  });

  it('忽略 local 子目录中的非目录项', () => {
    writeFile(
      'logseq/version-files/local/pages/MyPage/2022-10-26T06_05_24.726Z.Desktop.md',
      'content',
    );
    // 在 pages 目录下放一个文件（不是子目录）
    writeFile(
      'logseq/version-files/local/pages/stray-file.md',
      'should be ignored',
    );

    const result = scanVersionFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('pages/MyPage')).toBe(true);
  });
});

// ============================================================
// deduplicateVersions
// ============================================================

describe('deduplicateVersions', () => {
  /** 创建 VersionFile 对象的辅助函数，自动写入临时文件 */
  function makeVersion(
    name: string,
    timestamp: string,
    content: string,
    source: 'pages' | 'journals' = 'pages',
  ) {
    const date = timestamp.slice(0, 10);
    const safeName = `${name}-${timestamp.replace(/[:.]/g, '_')}.md`;
    const absPath = writeFile(`versions/${safeName}`, content);
    return { absPath, originalName: name, timestamp, date, source };
  }

  it('空数组返回空数组', () => {
    expect(deduplicateVersions([])).toEqual([]);
  });

  it('单个版本直接通过', () => {
    const v = makeVersion('Page', '2022-01-01T10:00:00.000Z', 'content');
    const result = deduplicateVersions([v]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(v);
  });

  it('同一天的多个版本只保留最后一个', () => {
    const v1 = makeVersion('Page', '2022-01-01T08:00:00.000Z', 'morning');
    const v2 = makeVersion('Page', '2022-01-01T12:00:00.000Z', 'noon');
    const v3 = makeVersion('Page', '2022-01-01T18:00:00.000Z', 'evening');

    const result = deduplicateVersions([v1, v2, v3]);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe('2022-01-01T18:00:00.000Z');
  });

  it('不同天的版本全部保留', () => {
    const v1 = makeVersion('Page', '2022-01-01T10:00:00.000Z', 'day1 content');
    const v2 = makeVersion('Page', '2022-01-02T10:00:00.000Z', 'day2 content');
    const v3 = makeVersion('Page', '2022-01-03T10:00:00.000Z', 'day3 content');

    const result = deduplicateVersions([v1, v2, v3]);
    expect(result).toHaveLength(3);
  });

  it('输入乱序时仍按时间排序输出', () => {
    const v1 = makeVersion('Page', '2022-01-03T10:00:00.000Z', 'c');
    const v2 = makeVersion('Page', '2022-01-01T10:00:00.000Z', 'a');
    const v3 = makeVersion('Page', '2022-01-02T10:00:00.000Z', 'b');

    const result = deduplicateVersions([v1, v2, v3]);
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2022-01-01');
    expect(result[1].date).toBe('2022-01-02');
    expect(result[2].date).toBe('2022-01-03');
  });

  it('hash 去重：相邻版本内容相同时跳过后者', () => {
    const sameContent = 'identical content for dedup test';
    const v1 = makeVersion('Page', '2022-01-01T10:00:00.000Z', sameContent);
    const v2 = makeVersion('Page', '2022-01-02T10:00:00.000Z', sameContent);

    const result = deduplicateVersions([v1, v2]);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2022-01-01');
  });

  it('hash 去重：非相邻的相同内容不去重', () => {
    // A - B - A 模式：第三个 A 和第一个 A 内容相同，但不相邻，不去重
    const v1 = makeVersion('Page', '2022-01-01T10:00:00.000Z', 'content A');
    const v2 = makeVersion('Page', '2022-01-02T10:00:00.000Z', 'content B');
    const v3 = makeVersion('Page', '2022-01-03T10:00:00.000Z', 'content A');

    const result = deduplicateVersions([v1, v2, v3]);
    expect(result).toHaveLength(3);
  });

  it('hash 去重：连续多个相同内容只保留第一个', () => {
    const same = 'no change';
    const v1 = makeVersion('Page', '2022-01-01T10:00:00.000Z', same);
    const v2 = makeVersion('Page', '2022-01-02T10:00:00.000Z', same);
    const v3 = makeVersion('Page', '2022-01-03T10:00:00.000Z', same);
    const v4 = makeVersion('Page', '2022-01-04T10:00:00.000Z', 'changed');

    const result = deduplicateVersions([v1, v2, v3, v4]);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2022-01-01');
    expect(result[1].date).toBe('2022-01-04');
  });

  it('按天去重与 hash 去重组合：先按天筛选，再 hash 去重', () => {
    // 第 1 天有两个版本（保留晚的），第 2 天内容和第 1 天相同（hash 去重掉）
    const v1a = makeVersion('Page', '2022-01-01T08:00:00.000Z', 'early');
    const v1b = makeVersion('Page', '2022-01-01T20:00:00.000Z', 'final');
    const v2 = makeVersion('Page', '2022-01-02T10:00:00.000Z', 'final'); // 和 v1b 内容相同

    const result = deduplicateVersions([v1a, v1b, v2]);
    // 按天去重：day1 保留 v1b("final")，day2 保留 v2("final")
    // hash 去重：v2 和 v1b 内容相同 → 跳过 v2
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe('2022-01-01T20:00:00.000Z');
  });

  it('文件不存在时 hash 返回空字符串，prevHash 初始也为空，全部被跳过', () => {
    const v1 = {
      absPath: '/nonexistent/path/v1.md',
      originalName: 'Page',
      timestamp: '2022-01-01T10:00:00.000Z',
      date: '2022-01-01',
      source: 'pages' as const,
    };
    const v2 = {
      absPath: '/nonexistent/path/v2.md',
      originalName: 'Page',
      timestamp: '2022-01-02T10:00:00.000Z',
      date: '2022-01-02',
      source: 'pages' as const,
    };

    // fileHash 对不存在的文件返回 ''，prevHash 初始值也是 ''
    // 因此 v1 的 hash('') === prevHash('') → 跳过
    // v2 的 hash('') === prevHash('') → 跳过
    // 结果为空数组
    const result = deduplicateVersions([v1, v2]);
    expect(result).toHaveLength(0);
  });
});
