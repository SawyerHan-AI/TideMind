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
import Database from 'better-sqlite3';

const OLD_DIR_NAME = '.external-brain';
const NEW_DIR_NAME = '.tidemind';

/** SQLite 数据库文件的扩展名 — checkpoint 过滤用。 */
const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

/**
 * 递归收集 oldDir 下所有疑似 SQLite 数据库的主文件(不含 -wal / -shm)。
 * 拿到绝对路径,方便后续直接 open。
 */
function collectSqliteFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 权限问题或中途被删:跳过该子树,继续其他目录
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SQLITE_EXTENSIONS.has(ext)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

/**
 * 对每个 SQLite 主文件执行 `PRAGMA wal_checkpoint(TRUNCATE)`,把残留的
 * WAL 合并回主库。这样后续 cpSync 拿到的备份是自洽快照。
 *
 * 如果上一次 Electron/daemon 崩溃留下 `*.sqlite-wal`/`*.sqlite-shm`,
 * 直接 cpSync 得到的副本可能不一致(主库少了 WAL 里的最新事务,恢复
 * 时 SQLite 会尝试重放,但 -shm 是共享内存快照,跨机器/跨时间不可信)。
 *
 * 这是 best-effort:
 *   - 文件不存在 → 跳过
 *   - 0 字节文件 → 跳过(不是有效 DB)
 *   - 打开/checkpoint 失败(被其他进程锁住,或不是 SQLite) → 跳过
 *     退化为原来的朴素 cpSync,备份至少在文件系统层是原子的。
 */
function checkpointSqliteFiles(
  files: string[],
  logger?: MigrationLogger,
): void {
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) continue;
    } catch {
      continue;
    }
    let db: Database.Database | null = null;
    try {
      // readonly:fileMustExist: false 会在不存在时创建;我们已 stat 过,
      // 这里用 readonly 避免意外写。但 wal_checkpoint 需要写权限 —
      // 因此用读写打开,但仅发 checkpoint pragma。
      db = new Database(file, { fileMustExist: true });
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger?.warn(
        `[migrate] checkpoint 跳过 ${file}: ${(err as Error).message}`,
      );
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
}

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

  // Step 0: 预 checkpoint — 把所有 SQLite DB 的 WAL 合并回主库,让后续 cpSync
  // 拿到自洽快照。best-effort:被占用的库跳过,不阻塞迁移。
  try {
    const sqliteFiles = collectSqliteFiles(oldDir);
    if (sqliteFiles.length > 0) {
      logger?.info(
        `[migrate] 预 checkpoint ${sqliteFiles.length} 个 SQLite 文件`,
      );
      checkpointSqliteFiles(sqliteFiles, logger);
    }
  } catch (err) {
    // checkpoint 是纯优化,失败不能让迁移停下
    logger?.warn(
      `[migrate] 预 checkpoint 阶段异常(忽略,继续备份): ${(err as Error).message}`,
    );
  }

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
