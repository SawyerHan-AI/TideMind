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

const PENDING_DIGESTS_V33_TABLE_SQL = `
CREATE TABLE pending_digests (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','processing','failed','ambiguous')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created TEXT NOT NULL,
    next_retry_at TEXT NOT NULL,
    completed_at TEXT,
    processing_started_at TEXT,
    ambiguous_invocation_id TEXT
);
`;

const PENDING_DIGESTS_V33_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_pending_digests_status
  ON pending_digests(status, next_retry_at);
`;

/**
 * v33 将 pending_digests 增加 ambiguous 终态。SQLite 无法 ALTER CHECK，
 * 因此 fresh schema、core migration 和 Electron repair 都复用这段幂等重建逻辑。
 */
export function ensurePendingDigestsV33(db: Database.Database): void {
  db.transaction(() => {
    const tableSql = (name: string): string | null => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) as { sql: string | null } | undefined;
      return row?.sql ?? null;
    };
    const isV33 = (name: string): boolean =>
      tableSql(name)?.includes("'ambiguous'") === true &&
      tableHasColumn(db, name, 'ambiguous_invocation_id');
    const copyFrom = (source: string, orIgnore = false): void => {
      const hasProcessingStartedAt = tableHasColumn(db, source, 'processing_started_at');
      const hasInvocationColumn = tableHasColumn(db, source, 'ambiguous_invocation_id');
      db.exec(`
        INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO pending_digests (
          id, trace_id, input_json, status, error_message, retry_count, created,
          next_retry_at, completed_at, processing_started_at, ambiguous_invocation_id
        )
        SELECT
          id, trace_id, input_json, status, error_message, retry_count, created,
          next_retry_at, completed_at,
          ${hasProcessingStartedAt ? 'processing_started_at' : 'NULL'},
          ${hasInvocationColumn ? 'ambiguous_invocation_id' : 'NULL'}
        FROM ${quoteIdentifier(source)}
      `);
    };

    const hasCurrent = tableSql('pending_digests') !== null;
    const hasBackup = tableSql('pending_digests_v32_backup') !== null;
    if (hasBackup) {
      if (!hasCurrent) {
        db.exec('ALTER TABLE pending_digests_v32_backup RENAME TO pending_digests');
      } else if (isV33('pending_digests')) {
        copyFrom('pending_digests_v32_backup', true);
        db.exec('DROP TABLE pending_digests_v32_backup');
      } else {
        // A backup from an interrupted legacy implementation is authoritative:
        // discard the partially-created replacement and retry below.
        db.exec(`
          DROP TABLE pending_digests;
          ALTER TABLE pending_digests_v32_backup RENAME TO pending_digests;
        `);
      }
    }

    if (tableSql('pending_digests') === null) {
      db.exec(PENDING_DIGESTS_V33_TABLE_SQL + PENDING_DIGESTS_V33_INDEX_SQL);
      return;
    }
    if (isV33('pending_digests')) {
      db.exec(PENDING_DIGESTS_V33_INDEX_SQL);
      return;
    }

    db.exec(`
      DROP INDEX IF EXISTS idx_pending_digests_status;
      ALTER TABLE pending_digests RENAME TO pending_digests_v32_backup;
      ${PENDING_DIGESTS_V33_TABLE_SQL}
    `);
    copyFrom('pending_digests_v32_backup');
    db.exec(`
      DROP TABLE pending_digests_v32_backup;
      ${PENDING_DIGESTS_V33_INDEX_SQL}
    `);
  }).immediate();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
