// ============================================================
// 路径工具
// ============================================================

import os from 'node:os';
import path from 'node:path';

/**
 * 展开路径开头的 `~` 为用户主目录。
 *
 * 只在路径恰为 `~` 或以 `~/`（`~\` on Windows）开头时替换，其余原样返回。
 *
 * 必须锚定开头：朴素的 `sourcePath.replace('~', os.homedir())` 会替换路径中
 * 任意位置的第一个 `~`，把形如 `/Users/x/notes~archive` 的合法 vault 路径破坏成
 * `/Users/x/notes<home>archive` → existsSync 失败 → 整个笔记源静默不启动。
 * 同时不展开 `~user` 形式（无法可靠解析他人 home，保持原样交由 existsSync 报错）。
 */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
