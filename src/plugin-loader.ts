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
        // 模块不存在 → 开源版，静默跳过
      } else {
        log.error(`Pro 模块加载出错: ${mod.name}`, err);
      }
    }
  }

  if (loaded > 0) {
    log.info(`共加载 ${loaded} 个 Pro 模块`);
  }
}
