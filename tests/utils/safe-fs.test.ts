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
  safeReadVaultTextFileSync,
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

describe('vault-bound descriptor reads', () => {
  function fixture() {
    const root = path.join(tmpDir, 'vault');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'notes/a.md'), 'inside');
    fs.writeFileSync(path.join(outside, 'a.md'), 'outside secret');
    return { root, outside, file: path.join(root, 'notes/a.md') };
  }
  it('allows normal files and macOS ancestor aliases, rejects root/file symlinks', () => {
    const { root, outside, file } = fixture();
    expect(safeReadVaultTextFileSync(file, root)).toEqual({ ok: true, content: 'inside' });
    fs.symlinkSync(root, path.join(tmpDir, 'vault-link'));
    expect(safeReadVaultTextFileSync(path.join(tmpDir, 'vault-link/notes/a.md'), path.join(tmpDir, 'vault-link')).ok).toBe(false);
    fs.symlinkSync(outside, path.join(root, 'linked'));
    expect(safeReadVaultTextFileSync(path.join(root, 'linked/a.md'), root).ok).toBe(false);
    fs.symlinkSync(path.join(outside, 'a.md'), path.join(root, 'file-link.md'));
    expect(safeReadVaultTextFileSync(path.join(root, 'file-link.md'), root).ok).toBe(false);
    if (process.platform === 'darwin') {
      const aliasRoot = root.replace(/^\/private\/var\//, '/var/');
      expect(safeReadVaultTextFileSync(path.join(aliasRoot, 'notes/a.md'), aliasRoot)).toEqual({ ok: true, content: 'inside' });
    }
  });
  for (const swapped of ['leaf', 'directory', 'root'] as const) {
    it(`rejects a real ${swapped} replacement between validation and open`, () => {
      const { root, outside, file } = fixture();
      const originalOpen = fs.openSync;
      const read = vi.spyOn(fs, 'readFileSync');
      const open = vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: number, mode?: number) => {
        open.mockRestore();
        const victim = swapped === 'leaf' ? file : swapped === 'directory' ? path.join(root, 'notes') : root;
        if (swapped === 'root') {
          fs.mkdirSync(path.join(outside, 'notes'));
          fs.writeFileSync(path.join(outside, 'notes/a.md'), 'outside secret');
        }
        const replacement = swapped === 'leaf' ? path.join(outside, 'a.md') : outside;
        fs.renameSync(victim, `${victim}-saved`);
        fs.symlinkSync(replacement, victim);
        return originalOpen(target, flags, mode);
      }) as typeof fs.openSync);
      expect(safeReadVaultTextFileSync(file, root).ok).toBe(false);
      expect(read).not.toHaveBeenCalled();
    });
  }
  it('pins the validated descriptor if the path changes immediately before read', () => {
    const { root, outside, file } = fixture();
    const originalRead = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options: unknown) => {
      read.mockRestore();
      expect(typeof target).toBe('number');
      fs.renameSync(path.join(root, 'notes'), path.join(root, 'old-notes'));
      fs.symlinkSync(outside, path.join(root, 'notes'));
      return originalRead(target, options as never);
    }) as typeof fs.readFileSync);
    expect(safeReadVaultTextFileSync(file, root)).toEqual({ ok: true, content: 'inside' });
  });
  it('checks the opened inode for dataless state before reading', () => {
    const { root, file } = fixture();
    const original = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = original(fd);
      Object.defineProperty(stat, 'blocks', { value: 0 });
      return stat;
    }) as typeof fs.fstatSync);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(safeReadVaultTextFileSync(file, root)).toEqual({ ok: false, reason: 'dataless' });
    expect(read).not.toHaveBeenCalled();
  });
});
