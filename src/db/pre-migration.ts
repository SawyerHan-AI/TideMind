import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from './schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db-migration');

/**
 * 自动备份数据库（迁移前调用）——正式回滚点（设计 §8：一致性 DB + 路由配置）。
 *
 * 用 SQLite 的 `VACUUM INTO` 在一个读事务内生成一致快照（包含 WAL 中已提交的数据），
 * 不再“checkpoint 后复制主文件”：后者在 checkpoint 与复制之间若有其他连接写入，会得到
 * 不一致的副本。同一时间戳另存 `config.toml`（模型路由等），回滚时两者配套恢复。
 * 保留最近 3 组。外部 Agent 宿主文件不随备份覆盖，恢复时按 ownership/CAS 另行处理。
 */
export function backupDbIfNeeded(dbPath: string, routeConfigPath?: string, connection?: Database.Database): void {
  if (!fs.existsSync(dbPath)) return;

  const dir = path.dirname(dbPath);
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const backupPath = path.join(dir, `brain.backup-${timestamp}.sqlite`);
  const configBackup = path.join(dir, `config.backup-${timestamp}.toml`);

  try {
    const configPath = routeConfigPath ?? path.join(path.dirname(dir), 'config.toml');
    const beforeConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    const snapshotDb = connection ?? new Database(dbPath, { readonly: true });
    try {
      if (!connection) snapshotDb.pragma('busy_timeout = 10000');
      snapshotDb.prepare('VACUUM INTO ?').run(backupPath);
    } finally {
      if (!connection) snapshotDb.close();
    }
    fs.chmodSync(backupPath, 0o600);
    log.info(`数据库已备份: ${backupPath}`);

    const afterConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
    if (beforeConfig === null ? afterConfig !== null : afterConfig === null || !beforeConfig.equals(afterConfig)) {
      throw new Error('模型路由配置在数据库备份期间发生变化');
    }
    if (beforeConfig !== null) {
      fs.copyFileSync(configPath, configBackup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(configBackup, 0o600);
      if (!fs.readFileSync(configBackup).equals(beforeConfig)) throw new Error('模型路由配置在复制期间发生变化');
    }

    // 清理旧备份，保留最近 3 组
    for (const [prefix, suffix] of [['brain.backup-', '.sqlite'], ['config.backup-', '.toml']] as const) {
      const backups = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .reverse();
      for (const old of backups.slice(3)) {
        try {
          fs.unlinkSync(path.join(dir, old));
          log.info(`已清理旧备份: ${old}`);
        } catch (unlinkErr) {
          log.warn(`清理旧备份失败 ${old}: ${(unlinkErr as Error).message}`);
        }
      }
    }
  } catch (err) {
    // Do not leave an incomplete pair that a later retention pass could mistake
    // for a usable rollback point. Names belong exclusively to this attempt.
    for (const incomplete of [backupPath, configBackup]) {
      try { fs.rmSync(incomplete, { force: true }); } catch { /* retain the original error */ }
    }
    log.error(`数据库备份失败: ${(err as Error).message}`);
    throw new Error('迁移前备份失败，数据库未升级。请检查磁盘空间及目录权限后重试。', { cause: err });
  }
}


/** Return the on-disk schema without running any repair or creating tables. */
function readVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : -1;
  } catch (error) {
    if (error instanceof Error && /no such table: metadata/.test(error.message)) return -1;
    throw error;
  }
}

/**
 * Shared daemon/Electron preflight. SQLite itself owns the exclusion boundary,
 * including older clients that do not know any new process/lockfile protocol.
 * Switching WAL to DELETE rejects existing WAL users, including idle readers.
 * EXCLUSIVE locking mode retains the acquired file lock after COMMIT, allowing
 * VACUUM INTO and legacy v6 foreign_keys changes outside a transaction without
 * admitting other database users between backup and schema migration.
 */
export function migrateExistingDatabaseIfNeeded(dbPath: string, routeConfigPath?: string): void {
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath);
  let restoreMode: string | null = null;
  let completed = false;
  let failure: unknown;
  const restoreJournal = (): void => {
    if (db.inTransaction) db.exec('ROLLBACK');
    if (restoreMode !== null) {
      const targetMode = completed ? 'wal' : restoreMode;
      if (db.pragma(`journal_mode = ${targetMode}`, { simple: true }) !== targetMode) {
        throw new Error('无法恢复数据库 journal 模式，请保留备份并重试');
      }
    }
  };
  try {
    const version = readVersion(db);
    if (Number.isFinite(version) && version >= CURRENT_SCHEMA_VERSION) return;
    db.pragma('busy_timeout = 1000');
    const originalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    if (!['delete', 'truncate', 'persist', 'memory', 'wal', 'off'].includes(originalMode)) {
      throw new Error('无法识别数据库 journal 模式，升级已暂停');
    }
    try {
      if (db.pragma('locking_mode = EXCLUSIVE', { simple: true }) !== 'exclusive') {
        throw new Error('无法启用数据库排他锁，升级已暂停');
      }
      // DELETE transition requires all existing WAL users to release the DB.
      if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('无法取得数据库排他访问，升级已暂停');
      }
      restoreMode = originalMode;
      db.exec('BEGIN EXCLUSIVE; COMMIT');
    } catch (error) {
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) {
        throw new Error('数据库仍被其他连接使用，升级已暂停。请退出相关 Tide Mind、MCP/Hook 进程后重试。', { cause: error });
      }
      throw error;
    }
    // A competing upgrade may have completed before our exclusive acquisition.
    const lockedVersion = readVersion(db);
    if (!Number.isFinite(lockedVersion) || lockedVersion < CURRENT_SCHEMA_VERSION) {
      // The same connection must create the snapshot: another connection would
      // correctly be blocked by the retained exclusive lock.
      backupDbIfNeeded(dbPath, routeConfigPath, db);
      ensureSchema(db);
    }
    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      restoreJournal();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], '数据库升级失败，且 journal 模式恢复失败') : error;
    } finally {
      db.close();
    }
  }
  if (failure) throw failure;
}
