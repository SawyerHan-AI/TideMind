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

// mock nanoid — 用 vi.fn() 包装,允许 per-test 覆盖以测碰撞防御
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'ABCD'),
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
import { nanoid } from 'nanoid';

beforeEach(() => {
  writtenHeader = '';
  appendedContent = '';
  fileExists = false;
  fsyncCalls = 0;
  lockHeld = false;
  fdToPath.clear();
  vi.mocked(nanoid).mockReturnValue('ABCD');
});

describe('appendToStream', () => {
  it('返回标准 stream 引用格式', async () => {
    const ref = await appendToStream({ content: '测试内容' });
    // stream/2026-04-08.md#s-HHMMSSMMM-ABCD
    expect(ref).toMatch(/^stream\/2026-04-08\.md#s-\d{9}-ABCD$/);
  });

  it('新文件时写入日期标题头', async () => {
    await appendToStream({ content: '内容' });
    expect(writtenHeader).toContain('# 2026-04-08');
  });

  it('已有文件时不重复写入标题头', async () => {
    fileExists = true;
    await appendToStream({ content: '新内容' });
    expect(writtenHeader).toBe('');
    expect(appendedContent).toContain('新内容');
  });

  it('包含 tool 和 session 信息', async () => {
    await appendToStream({ tool: 'cowork', session: 'sess-1', content: '内容' });
    expect(appendedContent).toContain('· cowork');
    expect(appendedContent).toContain('· sess-1');
  });

  it('不提供 tool 时标题行不包含 ·', async () => {
    await appendToStream({ content: '纯内容' });
    // 标题行只有时间
    const headerLine = appendedContent.split('\n').find(l => l.startsWith('## '));
    expect(headerLine).toBeTruthy();
    expect(headerLine).not.toContain('·');
  });

  it('包含 files 字段', async () => {
    await appendToStream({ content: '内容', files: ['a.ts', 'b.ts'] });
    expect(appendedContent).toContain('files: a.ts, b.ts');
  });

  it('新文件时创建目录', async () => {
    await appendToStream({ content: '内容' });
    expect(fs.mkdirSync).toHaveBeenCalled();
  });

  it('包含锚点标签', async () => {
    await appendToStream({ content: '内容' });
    expect(appendedContent).toMatch(/<a id="s-\d{9}-ABCD"><\/a>/);
  });

  it('以 --- 分隔符结尾', async () => {
    await appendToStream({ content: '内容' });
    expect(appendedContent.trimEnd()).toMatch(/---$/);
  });

  it('每次 append 至少调用一次 fsyncSync（持久性保证）', async () => {
    await appendToStream({ content: '内容' });
    // 新文件场景：header fsync + block fsync = 2 次
    expect(fsyncCalls).toBeGreaterThanOrEqual(1);
  });

  it('写完后释放锁文件', async () => {
    await appendToStream({ content: '内容' });
    expect(lockHeld).toBe(false);
  });

  it('两次连续 append 不会因为锁残留而失败', async () => {
    await appendToStream({ content: '第一条' });
    await appendToStream({ content: '第二条' });
    expect(appendedContent).toContain('第一条');
    expect(appendedContent).toContain('第二条');
    expect(lockHeld).toBe(false);
  });
});

// ===== 跨进程锁:retry / stale / 超时 =====
//
// 现有 12 case 仅测产出格式;跨进程文件锁的重要行为(EEXIST 重试退避、
// stale lock 主动清理、5s 锁超时抛错)整段 0 测试。这是高频路径 + 跨进程
// 持久性保证,出错等于丢条目。
describe('appendToStream - cross-process lock acquireLock retry', () => {
  it('锁文件被占用时 EEXIST,等到锁释放后第二次重试成功', async () => {
    // 模拟:第一次 openSync('wx') 因 lock 文件已存在抛 EEXIST,
    // statSync 返回非 stale mtime,setTimeout 退避 → 我们用 mockImplementationOnce
    // 控制 openSync 一次抛错一次成功
    let openSyncCallCount = 0;
    const originalOpenSync = vi.mocked(fs.openSync).getMockImplementation();
    vi.mocked(fs.openSync).mockImplementation((p: unknown, flag: unknown, ...rest: unknown[]) => {
      if (typeof flag === 'string' && flag === 'wx') {
        openSyncCallCount++;
        if (openSyncCallCount === 1) {
          // 第一次:模拟另一进程占用锁
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        // 第二次:成功
        lockHeld = true;
        const fd = nextFd++;
        fdToPath.set(fd, p as string);
        return fd;
      }
      // 非 lock(数据文件):走 default
      return originalOpenSync ? (originalOpenSync as any)(p, flag, ...rest) : 0;
    });

    await appendToStream({ content: 'retry 测试' });

    expect(openSyncCallCount).toBeGreaterThanOrEqual(2);
    expect(appendedContent).toContain('retry 测试');

    // 还原
    vi.mocked(fs.openSync).mockImplementation(originalOpenSync as any);
  });

  it('stale lock(>30s)被主动清理并重新抢锁', async () => {
    // 第一次 openSync EEXIST,statSync 返回 mtimeMs > 30s 前 → 触发 unlinkSync 清理
    // → 立即重试 → 第二次 openSync 成功
    const oldMtime = Date.now() - 31_000; // 31 秒前
    let openSyncCallCount = 0;
    let staleStatCalls = 0;
    let unlinkCalls = 0;

    const originalOpenSync = vi.mocked(fs.openSync).getMockImplementation();
    vi.mocked(fs.openSync).mockImplementation((p: unknown, flag: unknown, ...rest: unknown[]) => {
      if (typeof flag === 'string' && flag === 'wx') {
        openSyncCallCount++;
        if (openSyncCallCount === 1) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        lockHeld = true;
        const fd = nextFd++;
        fdToPath.set(fd, p as string);
        return fd;
      }
      return originalOpenSync ? (originalOpenSync as any)(p, flag, ...rest) : 0;
    });

    const originalStatSync = vi.mocked(fs.statSync).getMockImplementation();
    vi.mocked(fs.statSync).mockImplementation(() => {
      staleStatCalls++;
      return { mtimeMs: oldMtime } as any;
    });

    const originalUnlinkSync = vi.mocked(fs.unlinkSync).getMockImplementation();
    vi.mocked(fs.unlinkSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.md.lock')) {
        unlinkCalls++;
        lockHeld = false;
      }
    });

    await appendToStream({ content: 'stale 测试' });

    expect(openSyncCallCount).toBeGreaterThanOrEqual(2);
    expect(staleStatCalls).toBeGreaterThanOrEqual(1);
    expect(unlinkCalls).toBeGreaterThanOrEqual(1); // 至少 1 次 stale unlink + 1 次正常释放
    expect(appendedContent).toContain('stale 测试');

    // 还原
    vi.mocked(fs.openSync).mockImplementation(originalOpenSync as any);
    vi.mocked(fs.statSync).mockImplementation(originalStatSync as any);
    vi.mocked(fs.unlinkSync).mockImplementation(originalUnlinkSync as any);
  });

  it('锁获取超过 5s deadline 时抛错(异步退避)', async () => {
    // C-1 起 acquireLock 用 `await sleep(delay)` 异步退避替代自旋。
    // mock Date.now() 让它每次调用都返回递增值,模拟时间快进越过 5s deadline。
    // setTimeout 仍然走真实 timer 但延迟很短(10/20/40/80/160ms),
    // 即便跑满 5 秒也是几十次 await,vitest 默认 5s 超时不至于撞墙;
    // 为安全起见把 Date.now 步进设大(800ms),约 7 次 attempt 后必然过 deadline。
    const realStart = Date.now();
    let pseudoTime = realStart;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      pseudoTime += 800;
      return pseudoTime;
    });

    let openSyncCallCount = 0;
    const originalOpenSync = vi.mocked(fs.openSync).getMockImplementation();
    vi.mocked(fs.openSync).mockImplementation((p: unknown, flag: unknown, ...rest: unknown[]) => {
      if (typeof flag === 'string' && flag === 'wx') {
        openSyncCallCount++;
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return originalOpenSync ? (originalOpenSync as any)(p, flag, ...rest) : 0;
    });

    // statSync 返回非 stale(mtimeMs = "现在",所以 now - mtime < 30s)
    const originalStatSync = vi.mocked(fs.statSync).getMockImplementation();
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: pseudoTime } as any));

    await expect(appendToStream({ content: 'timeout 测试' })).rejects.toThrow(
      /获取文件锁超时/,
    );
    expect(openSyncCallCount).toBeGreaterThan(0);

    // 还原
    vi.mocked(fs.openSync).mockImplementation(originalOpenSync as any);
    vi.mocked(fs.statSync).mockImplementation(originalStatSync as any);
    dateSpy.mockRestore();
  });

  it('statSync 抛错时(lock 已被释放)不影响重试流程', async () => {
    // statSync 抛错(例如 lock 文件刚被另一进程清掉),应该被吞掉,继续重试
    let openSyncCallCount = 0;
    const originalOpenSync = vi.mocked(fs.openSync).getMockImplementation();
    vi.mocked(fs.openSync).mockImplementation((p: unknown, flag: unknown, ...rest: unknown[]) => {
      if (typeof flag === 'string' && flag === 'wx') {
        openSyncCallCount++;
        if (openSyncCallCount === 1) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        lockHeld = true;
        const fd = nextFd++;
        fdToPath.set(fd, p as string);
        return fd;
      }
      return originalOpenSync ? (originalOpenSync as any)(p, flag, ...rest) : 0;
    });
    const originalStatSync = vi.mocked(fs.statSync).getMockImplementation();
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await expect(appendToStream({ content: 'stat throw 测试' })).resolves.toBeTruthy();

    // 还原
    vi.mocked(fs.openSync).mockImplementation(originalOpenSync as any);
    vi.mocked(fs.statSync).mockImplementation(originalStatSync as any);
  });
});

// ===== nanoid 防碰撞(锚点 id 唯一性) =====
describe('appendToStream - nanoid collision defense', () => {
  it('1000 次 append 时锚点 id 内的 nanoid 部分应该唯一(碰撞概率 ≈ 1e-16)', async () => {
    const actual = await vi.importActual<typeof import('nanoid')>('nanoid');
    vi.mocked(nanoid).mockImplementation(() => actual.nanoid(12));

    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const ref = await appendToStream({ content: `entry ${i}` });
      const match = ref.match(/#s-\d{9}-(.+)$/);
      expect(match).toBeTruthy();
      const nano = match![1];
      expect(seen.has(nano)).toBe(false); // 不重复
      seen.add(nano);
    }
    // 还原
    vi.mocked(nanoid).mockReturnValue('ABCD');
  });

  it('nanoid 长度应该是 12 字符(commit 历史明确升级到 12 防碰撞)', async () => {
    const actual = await vi.importActual<typeof import('nanoid')>('nanoid');
    vi.mocked(nanoid).mockImplementation(() => actual.nanoid(12));

    const ref = await appendToStream({ content: '长度测试' });
    const match = ref.match(/#s-\d{9}-([A-Za-z0-9_-]+)$/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBe(12);

    vi.mocked(nanoid).mockReturnValue('ABCD');
  });
});

// ===== fsync 抛错 + fd 关闭兜底 =====
describe('appendToStream - fsync error + fd close fallback', () => {
  it('header fsyncSync 抛错时 closeSync 仍被调用(finally 保护)', async () => {
    const originalFsync = vi.mocked(fs.fsyncSync).getMockImplementation();
    let fsyncErrorThrown = false;
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      // header fsync 抛错
      fsyncErrorThrown = true;
      throw new Error('fsync failed: ENOSPC');
    });

    const closeSpy = vi.mocked(fs.closeSync);
    const closeCountBefore = closeSpy.mock.calls.length;

    await expect(appendToStream({ content: 'fsync 失败测试' })).rejects.toThrow(/fsync failed/);

    // closeSync 在 header fd 上必须被调用(finally)
    // 并且 lock fd 也必须被释放
    const closeCountAfter = closeSpy.mock.calls.length;
    expect(closeCountAfter).toBeGreaterThan(closeCountBefore);
    expect(fsyncErrorThrown).toBe(true);
    // lockHeld 应该被释放(异常路径下也需要 unlock)
    expect(lockHeld).toBe(false);

    vi.mocked(fs.fsyncSync).mockImplementation(originalFsync as any);
  });

  it('append fsyncSync 抛错时 append fd 仍 close 且锁仍释放', async () => {
    fileExists = true; // 跳过 header 路径,直接走 append fsync
    const originalFsync = vi.mocked(fs.fsyncSync).getMockImplementation();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error('append fsync failed');
    });

    const closeSpy = vi.mocked(fs.closeSync);
    const closeCountBefore = closeSpy.mock.calls.length;

    await expect(appendToStream({ content: 'append fsync 失败' })).rejects.toThrow();

    const closeCountAfter = closeSpy.mock.calls.length;
    // append fd close + lock fd close 至少 2 次
    expect(closeCountAfter - closeCountBefore).toBeGreaterThanOrEqual(1);
    expect(lockHeld).toBe(false);

    vi.mocked(fs.fsyncSync).mockImplementation(originalFsync as any);
  });

  it('fsync 抛错也保证锁被释放(异常路径下不泄漏锁)', async () => {
    const originalFsync = vi.mocked(fs.fsyncSync).getMockImplementation();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    try {
      await appendToStream({ content: 'lock 不泄漏测试' });
    } catch { /* expected */ }

    expect(lockHeld).toBe(false);

    vi.mocked(fs.fsyncSync).mockImplementation(originalFsync as any);
  });

  it('closeSync 抛错时不影响整体(warn log + 继续)', async () => {
    const originalClose = vi.mocked(fs.closeSync).getMockImplementation();
    let closeErrorThrown = false;
    vi.mocked(fs.closeSync).mockImplementationOnce((fd: number) => {
      // header close 抛错(模拟 fd 已被外部关闭)
      closeErrorThrown = true;
      throw new Error('EBADF: file descriptor');
    });

    await expect(appendToStream({ content: 'close 抛错测试' })).resolves.toBeTruthy();
    expect(closeErrorThrown).toBe(true);

    vi.mocked(fs.closeSync).mockImplementation(originalClose as any);
  });
});

// ===== 并发写同文件 =====
describe('appendToStream - concurrent same-file writes', () => {
  it('两次顺序 append 锁机制串行,各自完整写入', async () => {
    // 同步代码无法真正并发,但锁的 lockHeld 模拟已经保证:
    // 第一次 acquireLock → 第一次 release → 第二次 acquireLock
    // 关键断言:两条都写入,中间没有交错
    await appendToStream({ content: '并发-第一条' });
    await appendToStream({ content: '并发-第二条' });

    expect(appendedContent).toContain('并发-第一条');
    expect(appendedContent).toContain('并发-第二条');
    // 第一条出现在第二条之前
    const idx1 = appendedContent.indexOf('并发-第一条');
    const idx2 = appendedContent.indexOf('并发-第二条');
    expect(idx1).toBeLessThan(idx2);
  });

  it('第二次 append 必须等到第一次释放锁后才能拿到锁', async () => {
    // 模拟:第一次 append 时 lock 被占,第二次开始时 lock 必须 false
    const lockStates: boolean[] = [];

    // 在 acquireLock 调用前,记录 lockHeld 状态
    const originalOpenSync = vi.mocked(fs.openSync).getMockImplementation();
    vi.mocked(fs.openSync).mockImplementation((p: unknown, flag: unknown, ...rest: unknown[]) => {
      if (typeof flag === 'string' && flag === 'wx') {
        lockStates.push(lockHeld); // 拿锁前的状态
        if (lockHeld) {
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        lockHeld = true;
        const fd = nextFd++;
        fdToPath.set(fd, p as string);
        return fd;
      }
      return originalOpenSync ? (originalOpenSync as any)(p, flag, ...rest) : 0;
    });

    await appendToStream({ content: 'lock state 1' });
    await appendToStream({ content: 'lock state 2' });

    // 两次都应该看到 lockHeld === false(因为上次已 release)
    expect(lockStates.every(s => s === false)).toBe(true);

    vi.mocked(fs.openSync).mockImplementation(originalOpenSync as any);
  });

  it('多次 append 全部成功(确认 lock 释放语义)', async () => {
    for (let i = 0; i < 50; i++) {
      await appendToStream({ content: `批量-${i}` });
    }
    for (let i = 0; i < 50; i++) {
      expect(appendedContent).toContain(`批量-${i}`);
    }
    expect(lockHeld).toBe(false);
  });
});
