/**
 * safe-fs 单元测试
 *
 * 核心验证：
 *   - iCloud stub 文件（`.xxx.icloud`）识别
 *   - dataless 文件（size>0, blocks=0）识别并跳过，不会触发 readFileSync
 *   - 正常文件 / 空文件 / 缺失文件的各分支
 *   - walkFilesFiltered 的扩展名过滤、目录排除、dataless 回调
 *
 * dataless 文件没法在真实 fs 上造出来（需要 iCloud 环境），所以用 vi.mock 替换 fs.statSync
 * 模拟 blocks=0 的场景。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isICloudStubName,
  isDataless,
  safeStatSync,
  safeReadTextFileSync,
  walkFilesFiltered,
  DatalessSkipCounter,
} from '../../src/utils/safe-fs.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fs-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isICloudStubName', () => {
  it('识别 .foo.md.icloud 这种 stub', () => {
    expect(isICloudStubName('.foo.md.icloud')).toBe(true);
    expect(isICloudStubName('.a.icloud')).toBe(true); // 最短 stub
  });

  it('普通文件名返回 false', () => {
    expect(isICloudStubName('foo.md')).toBe(false);
    expect(isICloudStubName('foo.icloud')).toBe(false); // 没以 . 开头
    expect(isICloudStubName('.hidden')).toBe(false); // 没以 .icloud 结尾
    expect(isICloudStubName('.icloud')).toBe(false); // 没 stub 原名
  });
});

describe('isDataless', () => {
  it('size>0 且 blocks=0 是 dataless', () => {
    const fakeStat = { size: 1024, blocks: 0 } as fs.Stats;
    expect(isDataless(fakeStat)).toBe(true);
  });

  it('正常文件（blocks>=1）不是 dataless', () => {
    const fakeStat = { size: 1024, blocks: 8 } as fs.Stats;
    expect(isDataless(fakeStat)).toBe(false);
  });

  it('空文件（size=0, blocks=0）不是 dataless', () => {
    const fakeStat = { size: 0, blocks: 0 } as fs.Stats;
    expect(isDataless(fakeStat)).toBe(false);
  });
});

describe('safeStatSync', () => {
  it('存在的文件返回 Stats', () => {
    const fp = path.join(tmpDir, 'a.md');
    fs.writeFileSync(fp, 'hello');
    const st = safeStatSync(fp);
    expect(st).not.toBeNull();
    expect(st!.size).toBe(5);
  });

  it('缺失文件返回 null', () => {
    expect(safeStatSync(path.join(tmpDir, 'nope.md'))).toBeNull();
  });
});

describe('safeReadTextFileSync', () => {
  it('正常文件读成功', () => {
    const fp = path.join(tmpDir, 'a.md');
    fs.writeFileSync(fp, 'hello world');
    const res = safeReadTextFileSync(fp);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe('hello world');
  });

  it('iCloud stub 文件名直接返回 stub，不读', () => {
    const fp = path.join(tmpDir, '.foo.md.icloud');
    fs.writeFileSync(fp, 'stub metadata');
    const res = safeReadTextFileSync(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('stub');
  });

  it('缺失文件返回 missing', () => {
    const res = safeReadTextFileSync(path.join(tmpDir, 'nope.md'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing');
  });

  it('dataless 文件返回 dataless，且不调 readFileSync（防阻塞）', () => {
    const fp = path.join(tmpDir, 'evicted.md');
    fs.writeFileSync(fp, 'content'); // 真实写点内容

    // 用 spy 替换 statSync 返回 dataless 特征；同时监控 readFileSync 不应被调用
    const origStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === fp) {
        return { size: 100, blocks: 0 } as fs.Stats;
      }
      return origStatSync(p as any, ...(rest as []));
    }) as typeof fs.statSync);
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const res = safeReadTextFileSync(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('dataless');
    expect(readSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('walkFilesFiltered', () => {
  it('按扩展名过滤', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'c.canvas'), 'c');

    const results = walkFilesFiltered(tmpDir, {
      extensions: ['.md', '.canvas'],
      excludeDir: () => false,
    });
    const names = results.map(r => path.basename(r)).sort();
    expect(names).toEqual(['a.md', 'c.canvas']);
  });

  it('排除指定子目录', () => {
    fs.mkdirSync(path.join(tmpDir, 'pages'));
    fs.mkdirSync(path.join(tmpDir, 'bak'));
    fs.writeFileSync(path.join(tmpDir, 'pages', 'a.md'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'bak', 'b.md'), 'b');

    const results = walkFilesFiltered(tmpDir, {
      extensions: ['.md'],
      excludeDir: (rel) => rel === 'bak',
    });
    expect(results.map(r => path.basename(r))).toEqual(['a.md']);
  });

  it('隐藏目录（以 . 开头）自动跳过', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(tmpDir, '.git', 'config.md'), 'c');
    fs.writeFileSync(path.join(tmpDir, 'ok.md'), 'o');

    const results = walkFilesFiltered(tmpDir, {
      extensions: ['.md'],
      excludeDir: () => false,
    });
    expect(results.map(r => path.basename(r))).toEqual(['ok.md']);
  });

  it('跳过 iCloud stub 文件', () => {
    fs.writeFileSync(path.join(tmpDir, 'real.md'), 'r');
    fs.writeFileSync(path.join(tmpDir, '.real.md.icloud'), 'stub');

    const results = walkFilesFiltered(tmpDir, {
      extensions: ['.md'],
      excludeDir: () => false,
    });
    expect(results.map(r => path.basename(r))).toEqual(['real.md']);
  });

  it('dataless 文件被跳过并触发回调', () => {
    const okPath = path.join(tmpDir, 'ok.md');
    const datalessPath = path.join(tmpDir, 'evicted.md');
    fs.writeFileSync(okPath, 'ok');
    fs.writeFileSync(datalessPath, 'evicted');

    const origStatSync = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === datalessPath) return { size: 100, blocks: 0 } as fs.Stats;
      return origStatSync(p as any, ...(rest as []));
    }) as typeof fs.statSync);

    const skipped: string[] = [];
    const results = walkFilesFiltered(tmpDir, {
      extensions: ['.md'],
      excludeDir: () => false,
      onDatalessSkip: (p) => skipped.push(p),
    });

    expect(results.map(r => path.basename(r))).toEqual(['ok.md']);
    expect(skipped).toEqual([datalessPath]);
  });
});

describe('DatalessSkipCounter', () => {
  it('累计计数并记住首次命中路径', () => {
    const c = new DatalessSkipCounter();
    expect(c.total).toBe(0);
    expect(c.sample).toBeNull();

    c.record('/a/first.md');
    c.record('/a/second.md');
    c.record('/a/third.md');

    expect(c.total).toBe(3);
    expect(c.sample).toBe('/a/first.md');
  });

  it('reset 清零', () => {
    const c = new DatalessSkipCounter();
    c.record('/a.md');
    c.reset();
    expect(c.total).toBe(0);
    expect(c.sample).toBeNull();
  });
});
