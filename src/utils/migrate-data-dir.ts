/**
 * 数据目录一次性迁移：~/.external-brain/ → ~/.tidemind/
 *
 * 为品牌改名提供向后兼容的迁移路径。
 *
 * 策略：
 *   1. 如果 ~/.tidemind/ 已存在 → 说明已迁移或为全新安装，直接返回
 *   2. 如果 ~/.external-brain/ 不存在 → 全新安装，无需迁移
 *   3. 否则：
 *      a) 先将 ~/.external-brain/ 完整复制到 ~/.external-brain.backup-{timestamp}/
 *         （用户的安全网，手动回滚或数据救援用）
 *      b) 再将 ~/.external-brain/ 原地重命名为 ~/.tidemind/（同盘秒级操作）
 *
 * 【调用时机要求】必须在以下所有操作之前调用：
 *   - 任何打开 SQLite DB 的逻辑
 *   - 任何创建/写入 ~/.tidemind/ 下子目录的逻辑（例如 shim-writer 写入
 *     ~/.tidemind/bin/tm-node —— 它会提前创建目录，导致迁移 fail-fast 跳过）
 *   - 任何读取 ~/.tidemind/config.toml 的逻辑
 *
 * 所有进程入口点（MCP server、daemon、hook-session-start、Electron main）
 * 都必须在自己的初始化路径的第一步调用此函数。
 *
 * 幂等：多次调用只有第一次会做事。后续调用看到 ~/.tidemind/ 已存在，直接返回
 * migrated=false。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OLD_DIR_NAME = '.external-brain';
const NEW_DIR_NAME = '.tidemind';

export interface MigrationResult {
  migrated: boolean;
  oldDir: string;
  newDir: string;
  backupDir?: string;
  reason?: string;
}

export interface MigrationLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface MigrationOptions {
  /** 覆盖 home 目录（默认用 os.homedir()）。主要给单元测试用。 */
  homeDir?: string;
  /** 覆盖备份目录时间戳（默认用当前 ISO 时间）。主要给单元测试用，保证命名可预测。 */
  timestamp?: string;
}

export function migrateDataDirIfNeeded(
  logger?: MigrationLogger,
  options: MigrationOptions = {},
): MigrationResult {
  const home = options.homeDir ?? os.homedir();
  const oldDir = path.join(home, OLD_DIR_NAME);
  const newDir = path.join(home, NEW_DIR_NAME);

  // 情况 1：新目录已存在 → 已迁移或全新安装
  if (fs.existsSync(newDir)) {
    return { migrated: false, oldDir, newDir, reason: 'new-dir-exists' };
  }

  // 情况 2：旧目录不存在 → 全新安装
  if (!fs.existsSync(oldDir)) {
    return { migrated: false, oldDir, newDir, reason: 'no-old-dir' };
  }

  // 情况 3：需要迁移
  const ts =
    options.timestamp ??
    new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '');
  const backupDir = path.join(home, `${OLD_DIR_NAME}.backup-${ts}`);

  logger?.info(`[migrate] 检测到旧数据目录，开始迁移 ${oldDir} → ${newDir}`);
  logger?.info(`[migrate] 创建备份 → ${backupDir}`);

  // Step 1: 复制为备份（可能较慢，但一次性）
  try {
    fs.cpSync(oldDir, backupDir, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    logger?.warn(
      `[migrate] 备份失败: ${(err as Error).message}。为避免数据丢失，放弃迁移，继续使用旧目录。`,
    );
    // 备份失败可能留下部分文件，尽力清理，避免占空间
    try {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    } catch { /* 清理失败不影响主流程 */ }
    return {
      migrated: false,
      oldDir,
      newDir,
      reason: `backup-failed: ${(err as Error).message}`,
    };
  }

  // Step 2: 原地重命名（同一文件系统下为原子操作）
  try {
    fs.renameSync(oldDir, newDir);
  } catch (err) {
    logger?.warn(
      `[migrate] 重命名失败: ${(err as Error).message}。备份已创建在 ${backupDir}，请手动处理。`,
    );
    return {
      migrated: false,
      oldDir,
      newDir,
      backupDir,
      reason: `rename-failed: ${(err as Error).message}`,
    };
  }

  logger?.info(`[migrate] 迁移完成。新目录：${newDir}；备份：${backupDir}`);
  return { migrated: true, oldDir, newDir, backupDir };
}
