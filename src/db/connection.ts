import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, getDataDir } from '../config.js';
import { ensureSchema, ensureVectorTable } from './schema.js';
import { setUsageDb } from '../llm/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

let db: Database.Database | null = null;
let vecLoaded = false;
let reembedNeeded = false;
let vecInitPromise: Promise<void> | null = null;

/**
 * 自动备份数据库（迁移前调用）。
 * 保留最近 3 个备份，按时间戳命名。
 */
function backupDbIfNeeded(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;

  const dir = path.dirname(dbPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(dir, `brain.backup-${timestamp}.sqlite`);

  try {
    // 先将 WAL 内容合并到主数据库文件，确保备份包含所有已提交数据
    const tmpDb = new Database(dbPath);
    try {
      tmpDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      tmpDb.close();
    }
    fs.copyFileSync(dbPath, backupPath);
    log.info(`数据库已备份: ${backupPath}`);

    // 清理旧备份，保留最近 3 个
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith('brain.backup-') && f.endsWith('.sqlite'))
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
  } catch (err) {
    log.error(`数据库备份失败: ${(err as Error).message}`);
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(getDataDir(), 'graph', 'brain.sqlite');

  // 迁移前备份：检测是否需要
  if (fs.existsSync(dbPath)) {
    const tmpDb = new Database(dbPath, { readonly: true });
    try {
      const row = tmpDb.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const version = row ? parseInt(row.value, 10) : -1;
      // 版本不存在或低于当前版本 → 备份
      if (version === -1 || version < 1) {
        backupDbIfNeeded(dbPath);
      }
    } catch {
      // metadata 表不存在 → 旧数据库，备份
      backupDbIfNeeded(dbPath);
    } finally {
      tmpDb.close();
    }
  }

  db = new Database(dbPath);
  db.pragma('busy_timeout = 10000');

  ensureSchema(db);
  setUsageDb(db);
  log.info(`数据库已连接: ${dbPath}`);

  return db;
}

/** 异步加载 sqlite-vec 扩展，应在 getDb() 之后调用一次 */
export async function initVec(): Promise<void> {
  if (vecLoaded || !db) return;
  if (vecInitPromise) return vecInitPromise;
  vecInitPromise = doInitVec();
  try {
    await vecInitPromise;
  } finally {
    vecInitPromise = null;
  }
}

async function doInitVec(): Promise<void> {
  try {
    const sqliteVec = await import('sqlite-vec');
    let loadablePath = sqliteVec.getLoadablePath();
    // Electron asar 修复：dlopen 无法读取 asar 内文件，需指向 unpacked 目录
    if (loadablePath.includes('app.asar')) {
      loadablePath = loadablePath.replace('app.asar', 'app.asar.unpacked');
    }
    db!.loadExtension(loadablePath);
    vecLoaded = true;
  } catch (err) {
    log.error(`sqlite-vec 加载失败，向量搜索不可用: ${(err as Error).message}`);
    return;
  }

  const config = getConfig();
  const targetDim = config.embedding.dimensions;
  try {
    const row = db!.prepare("SELECT value FROM metadata WHERE key = 'vector_dimensions'").get() as { value: string } | undefined;
    const currentDim = row ? parseInt(row.value, 10) : 0;

    if (currentDim > 0 && currentDim !== targetDim) {
      log.info(`向量维度变更 ${currentDim} → ${targetDim}，重建向量表`);
      db!.exec('DROP TABLE IF EXISTS nodes_vec');
      reembedNeeded = true;
    }

    ensureVectorTable(db!, targetDim);

    db!.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('vector_dimensions', ?)").run(String(targetDim));

    if (currentDim === 0) {
      const vecCount = db!.prepare('SELECT COUNT(*) as cnt FROM nodes_vec').get() as { cnt: number };
      const nodeCount = db!.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE heat > 0.01').get() as { cnt: number };
      if (vecCount.cnt === 0 && nodeCount.cnt > 0) {
        reembedNeeded = true;
      }
    }
  } catch {
    log.error('向量表创建失败');
    vecLoaded = false;
  }
}

export function isReembedNeeded(): boolean {
  return reembedNeeded;
}

export function clearReembedFlag(): void {
  reembedNeeded = false;
}

export function isVecLoaded(): boolean {
  return vecLoaded;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * 用于测试：使用内存数据库
 */
export function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  ensureSchema(testDb);
  return testDb;
}
