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
    if (!ignoredMessageParts.some(part => message.includes(part))) {
      throw error;
    }
  }
}

export function execIgnoringDuplicateColumn(db: Database.Database, sql: string): void {
  execIgnoringErrors(db, sql, ['duplicate column']);
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
