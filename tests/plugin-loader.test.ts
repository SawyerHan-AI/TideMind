/**
 * Pro 模块动态加载器(src/plugin-loader.ts)测试
 *
 * 关键关注点:
 *   1. 全开源场景:三个 pro/* 模块都缺失 → 静默跳过,不抛错
 *   2. 全付费场景:三个模块都存在 → loaded=3,register 都调用了
 *   3. **回归保护(2026-05-09 修复)**:Pro 模块自身的传递性依赖
 *      解析失败(MODULE_NOT_FOUND 但路径不含 pro/<name>/index.js)
 *      必须抛错 —— 历史一刀切 `includes('pro/...')` 会把这种真 bug 也吞掉
 *   4. register 抛非 MODULE_NOT_FOUND 错误 → log.error 不抛
 *   5. 异步 register 的 await 行为
 *
 * 测试策略:用 vi.doMock + vi.resetModules 让每个用例独立配置 mock,
 * 避免 hoisted vi.mock 跨用例污染。pro/* 目录在 worktree 中本就是空 .gitkeep,
 * 真实 ERR_MODULE_NOT_FOUND 是开箱即测的副作用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// 占位 db,plugin-loader 只把 ctx 透传给 register,不访问 db 字段
const fakeDb = {} as Database.Database;

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../pro/cloud-sync/index.js');
  vi.doUnmock('../pro/account/index.js');
  vi.doUnmock('../pro/billing/index.js');
  vi.restoreAllMocks();
});

async function loadLoader() {
  const mod = await import('../src/plugin-loader.js');
  return mod.loadProModules;
}

describe('plugin-loader: loadProModules', () => {
  describe('全模块加载成功', () => {
    it('三个 pro 模块都 import 成功 → 都调用 register,resolved', async () => {
      const cloudSyncReg = vi.fn();
      const accountReg = vi.fn();
      const billingReg = vi.fn();
      vi.doMock('../pro/cloud-sync/index.js', () => ({ register: cloudSyncReg }));
      vi.doMock('../pro/account/index.js', () => ({ register: accountReg }));
      vi.doMock('../pro/billing/index.js', () => ({ register: billingReg }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();

      expect(cloudSyncReg).toHaveBeenCalledTimes(1);
      expect(accountReg).toHaveBeenCalledTimes(1);
      expect(billingReg).toHaveBeenCalledTimes(1);

      // ctx 透传完整(含 db 引用)
      expect(cloudSyncReg.mock.calls[0][0]).toEqual({ db: fakeDb });
      expect(accountReg.mock.calls[0][0]).toEqual({ db: fakeDb });
      expect(billingReg.mock.calls[0][0]).toEqual({ db: fakeDb });
    });

    it('register 返回 Promise 时也 await(异步 register)', async () => {
      let observed = '';
      const cloudSyncReg = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 1));
        observed += 'a';
      });
      const accountReg = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 1));
        observed += 'b';
      });
      const billingReg = vi.fn(async () => {
        observed += 'c';
      });
      vi.doMock('../pro/cloud-sync/index.js', () => ({ register: cloudSyncReg }));
      vi.doMock('../pro/account/index.js', () => ({ register: accountReg }));
      vi.doMock('../pro/billing/index.js', () => ({ register: billingReg }));

      const loadProModules = await loadLoader();
      await loadProModules({ db: fakeDb });

      // 串行 await:abc 顺序与 PRO_MODULES 数组定义一致
      expect(observed).toBe('abc');
    });
  });

  describe('全部 self-missing(开源版正常路径)', () => {
    it('真实 ERR_MODULE_NOT_FOUND(无 mock,pro/ 下确实没有 index.ts)→ resolves 不抛', async () => {
      // 三个目录都是空 .gitkeep —— 这就是开源 release 的状态
      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });

    it('伪造 self-missing(register 抛 ERR_MODULE_NOT_FOUND 且 message 含 pro/<name>/index.js)→ silent skip', async () => {
      // 模拟 Node 真实 ESM 错误形态(loader 看 message+url 两路兜底)
      const makeSelfMissing = (modName: string) => () => {
        const err = new Error(
          `Cannot find module '/abs/pro/${modName}/index.js' imported from /abs/src/plugin-loader.js`,
        ) as NodeJS.ErrnoException & { url?: string };
        err.code = 'ERR_MODULE_NOT_FOUND';
        err.url = `file:///abs/pro/${modName}/index.js`;
        throw err;
      };

      vi.doMock('../pro/cloud-sync/index.js', () => ({ register: makeSelfMissing('cloud-sync') }));
      vi.doMock('../pro/account/index.js', () => ({ register: makeSelfMissing('account') }));
      vi.doMock('../pro/billing/index.js', () => ({ register: makeSelfMissing('billing') }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });

    it('CommonJS 风格 code === MODULE_NOT_FOUND(老 require 错误)也走 silent skip', async () => {
      // require 的错误 code 是 'MODULE_NOT_FOUND'(无 ERR_ 前缀),loader 双码兜底
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: () => {
          const err = new Error(
            `Cannot find module '/abs/pro/cloud-sync/index.js'`,
          ) as NodeJS.ErrnoException;
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });
  });

  describe('回归保护:传递性依赖缺失必须抛错(2026-05-09 修复)', () => {
    it('register 抛 ERR_MODULE_NOT_FOUND 但 message 不含 pro/<name>/index.js → 必须抛(不能吞)', async () => {
      // 模拟"Pro 模块本身加载成功,但它 import 的依赖解析失败"
      // 历史 bug:旧代码用 `mod.path`('../pro/cloud-sync/index.js')子串匹配,
      // 但 ESM 错误的 message/url 是绝对路径,`../` 前缀不会出现 →
      // includes 永远 false → 开源版启动直接抛错。
      // 修复后改用 'pro/<name>/index.js' 段匹配。
      // 本测试反向:依赖路径里 *不* 含该段,必须冒泡。
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: () => {
          const err = new Error(
            `Cannot find module '/abs/node_modules/missing-transitive-dep/dist/index.js' imported from /abs/pro/cloud-sync/lib/internal.js`,
          ) as NodeJS.ErrnoException;
          err.code = 'ERR_MODULE_NOT_FOUND';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).rejects.toThrow(/missing-transitive-dep/);
    });

    it('传递性缺失时 err.url 也不含 pro/<name>/index.js → 仍抛', async () => {
      // 验证 url 路径的判断也准确(loader 同时检查 message 和 url)
      vi.doMock('../pro/billing/index.js', () => ({
        register: () => {
          const err = new Error(
            `Cannot find module 'lemon-squeezy-sdk'`,
          ) as NodeJS.ErrnoException & { url?: string };
          err.code = 'ERR_MODULE_NOT_FOUND';
          err.url = 'file:///abs/pro/billing/node_modules/something.js';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).rejects.toThrow(/lemon-squeezy-sdk/);
    });

    it('短路验证:即便错误 message 巧合含子串 pro/account/index.js → silent skip', async () => {
      // 当 message 或 url 含 pro/<name>/index.js 时 → 当作 self-missing 处理
      // 这是 loader 设计上的边界条件,保留行为契约
      vi.doMock('../pro/account/index.js', () => ({
        register: () => {
          const err = new Error(
            `Cannot find module '/some/weird/path/pro/account/index.js'`,
          ) as NodeJS.ErrnoException;
          err.code = 'ERR_MODULE_NOT_FOUND';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });
  });

  describe('其它错误', () => {
    it('register 抛 generic Error(非 MODULE_NOT_FOUND)→ log.error 不抛', async () => {
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: () => {
          throw new Error('database lock contention');
        },
      }));

      const loadProModules = await loadLoader();
      // 不抛,继续加载剩余模块
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });

    it('register 抛带 code 但 code 不是 MODULE_NOT_FOUND 系列 → log.error 不抛', async () => {
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: () => {
          const err = new Error('Permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });

    it('async register reject 普通错误 → log.error 不抛', async () => {
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: async () => {
          throw new Error('network refused');
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).resolves.toBeUndefined();
    });
  });

  describe('混合场景', () => {
    it('一个成功,两个 self-missing → 不抛,成功的 register 被调用', async () => {
      const reg = vi.fn();
      vi.doMock('../pro/cloud-sync/index.js', () => ({ register: reg }));
      // account / billing 不 mock → 真实文件缺失
      const loadProModules = await loadLoader();
      await loadProModules({ db: fakeDb });

      expect(reg).toHaveBeenCalledTimes(1);
    });

    it('cloud-sync 成功,account 传递性失败 → 即便 cloud-sync 已注册,仍抛', async () => {
      const cloudReg = vi.fn();
      vi.doMock('../pro/cloud-sync/index.js', () => ({ register: cloudReg }));
      vi.doMock('../pro/account/index.js', () => ({
        register: () => {
          const err = new Error(
            `Cannot find module 'some-internal-helper'`,
          ) as NodeJS.ErrnoException;
          err.code = 'ERR_MODULE_NOT_FOUND';
          throw err;
        },
      }));

      const loadProModules = await loadLoader();
      await expect(loadProModules({ db: fakeDb })).rejects.toThrow(/some-internal-helper/);
      // cloud-sync 在 account 失败之前已注册过
      expect(cloudReg).toHaveBeenCalledTimes(1);
    });

    it('cloud-sync generic 错误不抛,account 仍尝试加载', async () => {
      vi.doMock('../pro/cloud-sync/index.js', () => ({
        register: () => { throw new Error('cloud sync init failed'); },
      }));
      const accountReg = vi.fn();
      vi.doMock('../pro/account/index.js', () => ({ register: accountReg }));

      const loadProModules = await loadLoader();
      await loadProModules({ db: fakeDb });

      expect(accountReg).toHaveBeenCalledTimes(1);
    });
  });
});
