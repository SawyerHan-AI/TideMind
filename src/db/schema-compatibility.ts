import Database from 'better-sqlite3';
import fs from 'node:fs';
import { assertRecoverableSchema41, RECOVERY_LINEAGE } from './schema41-recovery.js';

export const CURRENT_SCHEMA_VERSION = 47;

/** Read only: run before setup PRAGMAs, schema repair or migration. */
export function readPersistedSchemaVersion(db: Database.Database): number {
  const metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
  if (!metadata) return -1;
  const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: unknown } | undefined;
  if (!row) return -1;
  const raw = String(row.value);
  const version = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(version)) {
    throw Object.assign(new Error('数据库 schema 版本无效，已停止初始化；请保留数据库并检查兼容性。'), { code: 'DATABASE_SCHEMA_INVALID' });
  }
  return version;
}

export function assertSupportedDatabaseSchema(db: Database.Database, supportedVersion: number, allowRecovery = false): number {
  const actualVersion = readPersistedSchemaVersion(db);
  if (actualVersion > supportedVersion) {
    throw Object.assign(new Error(`数据库 schema v${actualVersion} 高于当前程序支持的 v${supportedVersion}，已停止初始化。请使用兼容版本。`), {
      code: 'DATABASE_SCHEMA_TOO_NEW', actualVersion, supportedVersion,
    });
  }
  if (actualVersion > 35 && actualVersion < 45) {
    if (actualVersion !== 41 || !allowRecovery) {
      throw Object.assign(new Error('数据库来自独立开发迁移线，需要显式兼容恢复；已停止初始化。'), { code: 'DATABASE_RECOVERY_REQUIRED' });
    }
    assertRecoverableSchema41(db);
  }
  if (actualVersion >= 45) {
    const lineage = db.prepare("SELECT value FROM metadata WHERE key = 'schema_lineage'").get() as { value: string } | undefined;
    if (lineage?.value !== RECOVERY_LINEAGE) throw Object.assign(new Error('数据库迁移来源标记不匹配，已停止初始化。'), { code: 'DATABASE_LINEAGE_MISMATCH' });
  }
  return actualVersion;
}

/** Check an existing file before filesystem repair or opening a writer. */
export function assertSupportedDatabaseFile(filename: string): void {
  if (!fs.existsSync(filename)) return;
  const probe = new Database(filename, { readonly: true, fileMustExist: true });
  try { assertSupportedDatabaseSchema(probe, CURRENT_SCHEMA_VERSION); }
  finally { probe.close(); }
}

/** For small sync helpers that bypass the shared application connection. */
export function openCompatibleDatabase(filename: string): Database.Database {
  assertSupportedDatabaseFile(filename);
  const opened = new Database(filename);
  try { assertSupportedDatabaseSchema(opened, CURRENT_SCHEMA_VERSION); }
  catch (error) { opened.close(); throw error; }
  return opened;
}
