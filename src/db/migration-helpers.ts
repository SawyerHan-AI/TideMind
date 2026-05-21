import type Database from 'better-sqlite3';

export function sqliteErrorMessage(error: unknown): string {
  return (error as Error | undefined)?.message ?? '';
}

export function execIgnoringErrors(
  db: Database.Database,
  sql: string,
  ignoredMessageParts: string[],
): void {
  try {
    db.exec(sql);
  } catch (error) {
    const message = sqliteErrorMessage(error);
    // MEDIUM 6 (audit-10, 2026-05-21):大小写无关匹配。
    // better-sqlite3 在不同版本 / 不同 SQLite 编译选项下 message 大小写不一致
    // (e.g. "Duplicate column name" vs "duplicate column name"),严格 includes
    // 会让升级时一个 corner case 直接抛出导致启动失败。统一 toLowerCase 后匹配。
    const lowered = message.toLowerCase();
    if (!ignoredMessageParts.some(part => lowered.includes(part.toLowerCase()))) {
      throw error;
    }
  }
}

/**
 * 幂等 ALTER TABLE ADD COLUMN 通用 helper。
 *
 * MEDIUM 6 (audit-10, 2026-05-21):
 *   原本 client/electron/db.ts 有一份 safeAlterAddColumn,逻辑与本函数重复;
 *   src/integrations/{logseq,obsidian,apple-notes}/sync-state.ts 和
 *   client/electron/cloud/outbox.ts 仍有 5 处 `try { ALTER } catch {}` 反模式
 *   (吞所有错,包括 SQLITE_FULL / SQLITE_BUSY → 磁盘满/损坏被静默)。
 *   统一改用本 helper:只放过"列已存在"和"already exists"两类,其余抛出。
 *
 * 容忍两种 SQLite 报错文案:
 *   - `duplicate column name: X` (主流 better-sqlite3)
 *   - `column X already exists` (历史 / 部分编译选项)
 */
export function execIgnoringDuplicateColumn(db: Database.Database, sql: string): void {
  execIgnoringErrors(db, sql, ['duplicate column', 'already exists']);
}

export function tableHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return columns.some(column => column.name === columnName);
}

export function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  alterSql: string,
): void {
  if (!tableHasColumn(db, tableName, columnName)) {
    db.exec(alterSql);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
