/**
 * Pro 模块动态加载器
 *
 * 尝试加载 pro/ 目录下的闭源商业模块。
 * 模块不存在时静默跳过——这就是开源版的正常运行路径。
 */

import type Database from 'better-sqlite3';
import { createLogger } from './utils/logger.js';

const log = createLogger('plugin');

export interface PluginContext {
  db: Database.Database;
}

interface ProModule {
  register(ctx: PluginContext): void | Promise<void>;
}

const PRO_MODULES = [
  { name: 'cloud-sync', path: '../pro/cloud-sync/index.js' },
  { name: 'account', path: '../pro/account/index.js' },
  { name: 'billing', path: '../pro/billing/index.js' },
];

export async function loadProModules(ctx: PluginContext): Promise<void> {
  let loaded = 0;

  for (const mod of PRO_MODULES) {
    try {
      const m = (await import(mod.path)) as ProModule;
      await m.register(ctx);
      loaded++;
      log.info(`Pro 模块已加载: ${mod.name}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        // 关键: MODULE_NOT_FOUND 有两种来源,必须区分:
        //   (a) mod.path 本身不存在 → 开源版,静默跳过
        //   (b) Pro 模块存在,但它 import 的某个依赖解析失败 → 真 bug,必须抛
        // 之前一刀切吞掉会让开发者在 Pro 仓库里重构 import 时看不到失败。
        // 判断方式:看错误 message / url 是否指向 mod.path 本身。
        const msg = String((err as Error).message ?? '');
        const url = String((err as { url?: string }).url ?? '');
        const modPathBare = mod.path.replace(/^\.\//, '');
        const isSelfMissing =
          msg.includes(mod.path) || msg.includes(modPathBare) ||
          url.includes(mod.path) || url.includes(modPathBare);
        if (isSelfMissing) {
          log.debug(`Pro 模块未安装,跳过: ${mod.name}`);
        } else {
          // 传递性依赖缺失 — 真 bug,不能吞
          log.error(`Pro 模块 ${mod.name} 加载失败:其依赖解析失败(不是模块本身缺失)`, err);
          throw err;
        }
      } else {
        log.error(`Pro 模块加载出错: ${mod.name}`, err);
      }
    }
  }

  if (loaded > 0) {
    log.info(`共加载 ${loaded} 个 Pro 模块`);
  }
}
