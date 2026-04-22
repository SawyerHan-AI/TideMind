/**
 * 面向用户笔记文件的安全 fs 封装
 *
 * 解决的问题：
 *   macOS iCloud "优化存储" 会把本地文件驱逐到云端，`st_size` 仍然报告真实大小，
 *   但 `st_blocks === 0`（没有物理块）。Node 的 `fs.readFileSync` 命中这种
 *   dataless 文件时，内核会**同步阻塞**触发 iCloud 下载——网慢或离线时永不返回，
 *   直接锁死 Electron 主进程 event loop，界面全冻（v0.2.41 以前真实卡死过）。
 *
 *   旧版 iCloud 行为是把文件替换成 `.<原名>.icloud` stub 小文件，扫描时也需跳过。
 *
 * 设计：
 *   - `safeStatSync` 和 `safeReadTextFileSync` 是用户笔记源（Logseq / Obsidian）
 *     读取笔记文件时的**统一入口**，任何读用户 vault 的地方都应走这两个函数。
 *   - stat 系统调用本身**不会**触发 iCloud 下载，只读 inode 元数据，所以可以
 *     放心提前判断 dataless。
 *   - 检测到 dataless / stub 文件直接跳过，不主动触发下载；下载策略交给用户在
 *     Finder 里显式决定。
 *   - 读应用自身配置文件（如 `logseq/config.edn`、`vault-config`）不走这里，
 *     它们属于"必须读成功"的路径，出错应抛错，不应静默跳过。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 判断文件是否为旧版 iCloud stub：`.<原名>.icloud`。
 * 注意：basename 以 `.` 开头且以 `.icloud` 结尾。
 */
export function isICloudStubName(basename: string): boolean {
  return basename.startsWith('.') && basename.endsWith('.icloud') && basename.length > '.'.length + '.icloud'.length;
}

/**
 * 判断 stat 结果是否为 iCloud 驱逐的 dataless 文件：
 * size > 0（逻辑上不是空文件）但 blocks === 0（没有物理块）。
 *
 * 正常空文件 size=0, blocks=0，不会被误判。
 * 正常非空文件 blocks ≥ 1。
 */
export function isDataless(stat: fs.Stats): boolean {
  return stat.size > 0 && stat.blocks === 0;
}

/**
 * 不抛错的 stat。路径不存在或权限问题返回 null。
 */
export function safeStatSync(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

export type SafeReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'missing' | 'dataless' | 'stub' | 'error'; err?: Error };

/**
 * 安全读取用户笔记文本文件。
 *
 * 返回值区分跳过原因，调用方可据此决定是否上报、计数或静默处理。
 * dataless / stub 文件**不**触发下载，直接跳过——这是防卡死的关键。
 */
export function safeReadTextFileSync(filePath: string): SafeReadResult {
  const basename = path.basename(filePath);
  if (isICloudStubName(basename)) {
    return { ok: false, reason: 'stub' };
  }

  const stat = safeStatSync(filePath);
  if (!stat) {
    return { ok: false, reason: 'missing' };
  }
  if (isDataless(stat)) {
    return { ok: false, reason: 'dataless' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: 'error', err: err as Error };
  }
}

/**
 * 统一的笔记目录递归扫描：过滤 iCloud stub、可选过滤 dataless、排除指定子目录。
 *
 * 与旧 `walkMdFiles` 相比：
 *   - 扩展名允许多种（`.md`、`.canvas` 等）
 *   - 在 walk 阶段就剔除 stub 文件和 dataless 文件（不等到 read 阶段再 stat）
 *   - dataless 命中会调 onDatalessSkip 回调让调用方计数/汇总 log
 *
 * excludeFilter 接收"相对 rootDir 的 POSIX 路径"（已用 `/` 规范化），返回 true 表示跳过整个子目录。
 */
export interface WalkOptions {
  /** 允许的扩展名（含点，如 '.md'），匹配小写 */
  extensions: string[];
  /** 子目录排除判断；参数是相对 rootDir 的 POSIX 路径 */
  excludeDir: (relPath: string) => boolean;
  /** 命中 dataless 文件的回调（用于 per-source 汇总日志） */
  onDatalessSkip?: (filePath: string) => void;
}

export function walkFilesFiltered(rootDir: string, opts: WalkOptions): string[] {
  const results: string[] = [];
  const exts = opts.extensions.map(e => e.toLowerCase());

  function walk(dir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // 隐藏目录（以 `.` 开头）一律跳过，避免误扫 .git / .obsidian 等
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (opts.excludeDir(relPath)) continue;
        walk(path.join(dir, entry.name), relPath);
        continue;
      }

      // 跳过旧式 iCloud stub
      if (isICloudStubName(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!exts.includes(ext)) continue;

      const full = path.join(dir, entry.name);

      // 跳过新式 dataless 文件（size>0, blocks=0），否则 readFileSync 会阻塞
      const st = safeStatSync(full);
      if (st && isDataless(st)) {
        opts.onDatalessSkip?.(full);
        continue;
      }

      results.push(full);
    }
  }

  walk(rootDir, '');
  return results;
}

/**
 * 简单的 per-source 一次性计数器：
 *   - 首次命中调 onFirst（用于输出一条 warn 摘要）
 *   - 后续命中只累加计数
 *
 * 用法：每个 sourceId 一个 counter 实例，sync 完成后读 count 决定是否输出总结。
 */
export class DatalessSkipCounter {
  private count = 0;
  private firstPath: string | null = null;

  record(filePath: string): void {
    if (this.count === 0) this.firstPath = filePath;
    this.count++;
  }

  get total(): number { return this.count; }
  get sample(): string | null { return this.firstPath; }
  reset(): void { this.count = 0; this.firstPath = null; }
}
