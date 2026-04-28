// ============================================================
// Apple Notes SQLite 数据库读取层
//
// 只读打开 NoteStore.sqlite，提供版本检测、账户/文件夹/笔记查询
// ============================================================

import Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';
import {
  CORE_DATA_EPOCH_OFFSET,
  DEFAULT_DB_PATH,
  ATTACHMENT_UTIS,
  type AppleAccount,
  type AppleFolder,
  type AppleNote,
  type AppleTag,
  type AttachmentText,
  type SchemaVersion,
} from './types.js';

const log = createLogger('apple-notes-db');

// ======== 数据库连接 ========

/**
 * 只读打开 NoteStore.sqlite。
 * 抛出 SQLITE_CANTOPEN 表示缺少 Full Disk Access 权限。
 */
export function openNoteStoreDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * 检测 Full Disk Access 权限。
 * @returns accessible=true 表示可读取，false 表示需要授权。
 */
export function checkPermission(dbPath: string = DEFAULT_DB_PATH): { accessible: boolean; path: string } {
  let db: Database.Database | null = null;
  try {
    db = openNoteStoreDb(dbPath);
    // 简单查询验证实际可读
    db.prepare('SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT').get();
    return { accessible: true, path: dbPath };
  } catch {
    return { accessible: false, path: dbPath };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// ======== 版本检测 ========

/**
 * 通过特征列存在性检测 NoteStore.sqlite 的 schema 版本。
 * 支持 macOS 13 (Ventura) 及以上。
 */
export function detectSchemaVersion(db: Database.Database): SchemaVersion {
  const columns = new Set<string>();
  const rows = db.pragma('table_info(ZICCLOUDSYNCINGOBJECT)') as Array<{ name: string }>;
  for (const row of rows) {
    columns.add(row.name);
  }

  // 从高版本向低版本检测
  if (columns.has('ZNEEDSTOFETCHUSERSPECIFICRECORDASSETS')) {
    // macOS 26 (Tahoe)
    return {
      version: '26',
      accountFK: 'ZACCOUNT7',
      creationDateCol: 'ZCREATIONDATE3',
      modificationDateCol: 'ZMODIFICATIONDATE1',
      hasHashtags: true,
      hasSmartFolders: true,
    };
  }
  if (columns.has('ZUNAPPLIEDENCRYPTEDRECORDDATA')) {
    // macOS 15 (Sequoia)
    return {
      version: '15',
      accountFK: 'ZACCOUNT7',
      creationDateCol: 'ZCREATIONDATE3',
      modificationDateCol: 'ZMODIFICATIONDATE1',
      hasHashtags: true,
      hasSmartFolders: true,
    };
  }
  if (columns.has('ZGENERATION')) {
    // macOS 14 (Sonoma)
    return {
      version: '14',
      accountFK: 'ZACCOUNT7',
      creationDateCol: 'ZCREATIONDATE3',
      modificationDateCol: 'ZMODIFICATIONDATE1',
      hasHashtags: true,
      hasSmartFolders: true,
    };
  }
  if (columns.has('ZACCOUNT6')) {
    // macOS 13 (Ventura)
    return {
      version: '13',
      accountFK: 'ZACCOUNT7',
      creationDateCol: 'ZCREATIONDATE3',
      modificationDateCol: 'ZMODIFICATIONDATE1',
      hasHashtags: true,
      hasSmartFolders: true,
    };
  }

  // 不支持的版本：明确报错而非盲目猜测列名
  // （支持范围：macOS 13 Ventura 及以上）
  const presentAccounts = ['ZACCOUNT', 'ZACCOUNT2', 'ZACCOUNT3', 'ZACCOUNT4', 'ZACCOUNT5', 'ZACCOUNT6', 'ZACCOUNT7', 'ZACCOUNT8']
    .filter(c => columns.has(c))
    .join(', ');
  throw new Error(
    `不支持的 Apple Notes 数据库版本。仅支持 macOS 13 (Ventura) 及以上。` +
    `检测到的账户列: [${presentAccounts}]`,
  );
}

// ======== 时间转换 ========

/** Core Data epoch (秒，距 2001-01-01) → ISO 8601 字符串 */
export function coreDataToISO(coreDataTs: number): string {
  return new Date((coreDataTs + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

/** Core Data epoch → Unix 毫秒时间戳 */
export function coreDataToUnixMs(coreDataTs: number): number {
  return (coreDataTs + CORE_DATA_EPOCH_OFFSET) * 1000;
}

// ======== 查询函数 ========

/**
 * 获取所有账户(ICAccount 实体)。
 *
 * ZICCLOUDSYNCINGOBJECT 是单表多实体(账户/文件夹/笔记/附件),老版本用
 * `WHERE ZNAME IS NOT NULL` 筛账户会把任何有 ZNAME 的行当账户(文件夹、
 * 共享 smart folder 等),后续 listNotes(accountZpks=[folderZpk]) 用错误 FK
 * 查不到任何笔记。
 *
 * 正确做法:Join Z_PRIMARYKEY 按 Z_NAME = 'ICAccount' 过滤 Z_ENT。
 */
export function listAccounts(db: Database.Database): AppleAccount[] {
  const rows = db.prepare(`
    SELECT c.Z_PK, c.ZNAME, c.ZIDENTIFIER, c.ZUSERRECORDNAME
    FROM ZICCLOUDSYNCINGOBJECT c
    JOIN Z_PRIMARYKEY zp ON c.Z_ENT = zp.Z_ENT
    WHERE zp.Z_NAME = 'ICAccount'
      AND c.ZNAME IS NOT NULL
    ORDER BY c.ZNAME
  `).all() as Array<{ Z_PK: number; ZNAME: string; ZIDENTIFIER: string; ZUSERRECORDNAME: string | null }>;

  return rows.map(r => ({
    zpk: r.Z_PK,
    name: r.ZNAME,
    uuid: r.ZIDENTIFIER,
    userRecordName: r.ZUSERRECORDNAME,
  }));
}

/** 获取所有非删除文件夹 */
export function listFolders(db: Database.Database, schema: SchemaVersion): AppleFolder[] {
  const smartFolderCheck = schema.hasSmartFolders ? ', ZSMARTFOLDERQUERYJSON' : '';
  const rows = db.prepare(`
    SELECT Z_PK, ZTITLE2, ZIDENTIFIER, ZPARENT, ZOWNER ${smartFolderCheck}
    FROM ZICCLOUDSYNCINGOBJECT
    WHERE ZTITLE2 IS NOT NULL
      AND ZMARKEDFORDELETION IS NOT 1
    ORDER BY ZTITLE2
  `).all() as Array<{
    Z_PK: number;
    ZTITLE2: string;
    ZIDENTIFIER: string;
    ZPARENT: number | null;
    ZOWNER: number;
    ZSMARTFOLDERQUERYJSON?: string | null;
  }>;

  return rows.map(r => ({
    zpk: r.Z_PK,
    title: r.ZTITLE2,
    uuid: r.ZIDENTIFIER,
    parentZpk: r.ZPARENT,
    ownerZpk: r.ZOWNER,
    isSmart: schema.hasSmartFolders ? r.ZSMARTFOLDERQUERYJSON != null : false,
  }));
}

/**
 * 构建文件夹路径映射：zpk → 完整路径字符串（如 "工作/项目A"）
 * 跳过智能文件夹。
 */
export function buildFolderPathMap(folders: AppleFolder[]): Map<number, string> {
  const zpkToFolder = new Map<number, AppleFolder>();
  for (const f of folders) {
    if (!f.isSmart) {
      zpkToFolder.set(f.zpk, f);
    }
  }

  const cache = new Map<number, string>();

  function resolvePath(zpk: number): string {
    if (cache.has(zpk)) return cache.get(zpk)!;
    const folder = zpkToFolder.get(zpk);
    if (!folder) return '';

    let result: string;
    if (folder.parentZpk && zpkToFolder.has(folder.parentZpk)) {
      const parentPath = resolvePath(folder.parentZpk);
      result = parentPath ? `${parentPath}/${folder.title}` : folder.title;
    } else {
      result = folder.title;
    }
    cache.set(zpk, result);
    return result;
  }

  for (const zpk of zpkToFolder.keys()) {
    resolvePath(zpk);
  }
  return cache;
}

/**
 * 获取所有笔记（排除加密和已删除）。
 * @param accountZpks 可选，只返回指定账户的笔记
 */
export function listNotes(
  db: Database.Database,
  schema: SchemaVersion,
  accountZpks?: number[],
): AppleNote[] {
  let sql = `
    SELECT
      c.Z_PK, c.ZTITLE1, c.ZSNIPPET, c.ZIDENTIFIER,
      c.${schema.creationDateCol} AS creation_date,
      c.${schema.modificationDateCol} AS modification_date,
      c.ZFOLDER, c.${schema.accountFK} AS account_zpk,
      c.ZISPASSWORDPROTECTED, c.ZMARKEDFORDELETION,
      n.ZDATA
    FROM ZICCLOUDSYNCINGOBJECT c
    JOIN ZICNOTEDATA n ON c.ZNOTEDATA = n.Z_PK
    WHERE n.ZDATA IS NOT NULL
      AND (c.ZCRYPTOTAG IS NULL)
      AND (c.ZMARKEDFORDELETION IS NOT 1)
  `;
  const params: unknown[] = [];

  if (accountZpks && accountZpks.length > 0) {
    const placeholders = accountZpks.map(() => '?').join(',');
    sql += ` AND c.${schema.accountFK} IN (${placeholders})`;
    params.push(...accountZpks);
  }

  sql += ' ORDER BY c.' + schema.creationDateCol;

  const rows = db.prepare(sql).all(...params) as Array<{
    Z_PK: number;
    ZTITLE1: string | null;
    ZSNIPPET: string | null;
    ZIDENTIFIER: string;
    creation_date: number;
    modification_date: number;
    ZFOLDER: number | null;
    account_zpk: number | null;
    ZISPASSWORDPROTECTED: number | null;
    ZMARKEDFORDELETION: number | null;
    ZDATA: Buffer | null;
  }>;

  return rows.map(r => ({
    zpk: r.Z_PK,
    uuid: r.ZIDENTIFIER,
    title: r.ZTITLE1,
    snippet: r.ZSNIPPET,
    folderZpk: r.ZFOLDER,
    accountZpk: r.account_zpk,
    creationDate: r.creation_date,
    modificationDate: r.modification_date,
    isPasswordProtected: r.ZISPASSWORDPROTECTED === 1,
    markedForDeletion: r.ZMARKEDFORDELETION === 1,
    zdata: r.ZDATA,
  }));
}

/**
 * 增量查询：返回修改时间晚于 since 的笔记。
 */
export function listNotesModifiedSince(
  db: Database.Database,
  schema: SchemaVersion,
  since: number, // Core Data epoch
  accountZpks?: number[],
): AppleNote[] {
  let sql = `
    SELECT
      c.Z_PK, c.ZTITLE1, c.ZSNIPPET, c.ZIDENTIFIER,
      c.${schema.creationDateCol} AS creation_date,
      c.${schema.modificationDateCol} AS modification_date,
      c.ZFOLDER, c.${schema.accountFK} AS account_zpk,
      c.ZISPASSWORDPROTECTED, c.ZMARKEDFORDELETION,
      n.ZDATA
    FROM ZICCLOUDSYNCINGOBJECT c
    JOIN ZICNOTEDATA n ON c.ZNOTEDATA = n.Z_PK
    WHERE n.ZDATA IS NOT NULL
      AND (c.ZCRYPTOTAG IS NULL)
      AND (c.ZMARKEDFORDELETION IS NOT 1)
      AND c.${schema.modificationDateCol} > ?
  `;
  const params: unknown[] = [since];

  if (accountZpks && accountZpks.length > 0) {
    const placeholders = accountZpks.map(() => '?').join(',');
    sql += ` AND c.${schema.accountFK} IN (${placeholders})`;
    params.push(...accountZpks);
  }

  sql += ' ORDER BY c.' + schema.modificationDateCol;

  const rows = db.prepare(sql).all(...params) as Array<{
    Z_PK: number;
    ZTITLE1: string | null;
    ZSNIPPET: string | null;
    ZIDENTIFIER: string;
    creation_date: number;
    modification_date: number;
    ZFOLDER: number | null;
    account_zpk: number | null;
    ZISPASSWORDPROTECTED: number | null;
    ZMARKEDFORDELETION: number | null;
    ZDATA: Buffer | null;
  }>;

  return rows.map(r => ({
    zpk: r.Z_PK,
    uuid: r.ZIDENTIFIER,
    title: r.ZTITLE1,
    snippet: r.ZSNIPPET,
    folderZpk: r.ZFOLDER,
    accountZpk: r.account_zpk,
    creationDate: r.creation_date,
    modificationDate: r.modification_date,
    isPasswordProtected: r.ZISPASSWORDPROTECTED === 1,
    markedForDeletion: r.ZMARKEDFORDELETION === 1,
    zdata: r.ZDATA,
  }));
}

/**
 * 一次性加载所有笔记的 hashtags，按 noteZpk 分组返回。
 * 取代 N+1 查询模式。
 */
export function preloadNoteTags(
  db: Database.Database,
  noteZpks: number[],
): Map<number, AppleTag[]> {
  const result = new Map<number, AppleTag[]>();
  if (noteZpks.length === 0) return result;

  try {
    // 检测 ZNOTE1 列是否存在（iOS 15+）
    const columns = db.pragma('table_info(ZICCLOUDSYNCINGOBJECT)') as Array<{ name: string }>;
    const hasZNote1 = columns.some(c => c.name === 'ZNOTE1');
    const noteJoinCol = hasZNote1 ? '(ZNOTE IN (SELECT value FROM json_each(?)) OR ZNOTE1 IN (SELECT value FROM json_each(?)))' : 'ZNOTE IN (SELECT value FROM json_each(?))';
    const noteZpksJson = JSON.stringify(noteZpks);

    const sql = `
      SELECT ZDISPLAYTEXT, ZNOTE, ZNOTE1
      FROM ZICCLOUDSYNCINGOBJECT
      WHERE ${noteJoinCol}
        AND ZTYPEUTI1 = ?
        AND ZDISPLAYTEXT IS NOT NULL
    `;
    const params = hasZNote1
      ? [noteZpksJson, noteZpksJson, ATTACHMENT_UTIS.HASHTAG]
      : [noteZpksJson, ATTACHMENT_UTIS.HASHTAG];

    const rows = db.prepare(sql).all(...params) as Array<{
      ZDISPLAYTEXT: string;
      ZNOTE: number | null;
      ZNOTE1?: number | null;
    }>;

    for (const row of rows) {
      const nz = row.ZNOTE ?? row.ZNOTE1;
      if (nz == null) continue;
      const list = result.get(nz) ?? [];
      list.push({ displayText: row.ZDISPLAYTEXT, noteZpk: nz });
      result.set(nz, list);
    }
  } catch (err) {
    log.warn('预加载 hashtags 失败:', (err as Error).message);
  }

  return result;
}

/**
 * 一次性加载所有笔记的附件文本（OCR/手写/音频转录），按 noteZpk 分组返回。
 * 取代 N+1 查询模式。
 */
export function preloadNoteAttachmentTexts(
  db: Database.Database,
  noteZpks: number[],
): Map<number, AttachmentText[]> {
  const result = new Map<number, AttachmentText[]>();
  if (noteZpks.length === 0) return result;

  try {
    const noteZpksJson = JSON.stringify(noteZpks);
    const rows = db.prepare(`
      SELECT ZIDENTIFIER, ZTYPEUTI, ZOCRSUMMARY, ZADDITIONALINDEXABLETEXT, ZNOTE
      FROM ZICCLOUDSYNCINGOBJECT
      WHERE ZNOTE IN (SELECT value FROM json_each(?))
        AND ZTYPEUTI IS NOT NULL
        AND (ZOCRSUMMARY IS NOT NULL OR ZADDITIONALINDEXABLETEXT IS NOT NULL)
    `).all(noteZpksJson) as Array<{
      ZIDENTIFIER: string;
      ZTYPEUTI: string;
      ZOCRSUMMARY: string | null;
      ZADDITIONALINDEXABLETEXT: string | null;
      ZNOTE: number;
    }>;

    for (const row of rows) {
      const list = result.get(row.ZNOTE) ?? [];
      list.push({
        uuid: row.ZIDENTIFIER,
        typeUti: row.ZTYPEUTI,
        ocrSummary: row.ZOCRSUMMARY,
        additionalIndexableText: row.ZADDITIONALINDEXABLETEXT,
      });
      result.set(row.ZNOTE, list);
    }
  } catch (err) {
    log.warn('预加载附件文本失败:', (err as Error).message);
  }

  return result;
}

/**
 * 轻量查询：只返回所有当前存在（非加密、非删除）笔记的 UUID 集合。
 * 用于增量同步时检测被用户删除的笔记。
 */
export function listAllNoteUuids(
  db: Database.Database,
  schema: SchemaVersion,
  accountZpks?: number[],
): Set<string> {
  let sql = `
    SELECT c.ZIDENTIFIER
    FROM ZICCLOUDSYNCINGOBJECT c
    JOIN ZICNOTEDATA n ON c.ZNOTEDATA = n.Z_PK
    WHERE n.ZDATA IS NOT NULL
      AND (c.ZCRYPTOTAG IS NULL)
      AND (c.ZMARKEDFORDELETION IS NOT 1)
  `;
  const params: unknown[] = [];

  if (accountZpks && accountZpks.length > 0) {
    const placeholders = accountZpks.map(() => '?').join(',');
    sql += ` AND c.${schema.accountFK} IN (${placeholders})`;
    params.push(...accountZpks);
  }

  const rows = db.prepare(sql).all(...params) as Array<{ ZIDENTIFIER: string }>;
  return new Set(rows.map(r => r.ZIDENTIFIER));
}

/**
 * 计算指定账户下的笔记总数（排除加密和已删除）。
 */
export function countNotes(
  db: Database.Database,
  schema: SchemaVersion,
  accountZpks?: number[],
): number {
  let sql = `
    SELECT COUNT(*) AS cnt
    FROM ZICCLOUDSYNCINGOBJECT c
    JOIN ZICNOTEDATA n ON c.ZNOTEDATA = n.Z_PK
    WHERE n.ZDATA IS NOT NULL
      AND (c.ZCRYPTOTAG IS NULL)
      AND (c.ZMARKEDFORDELETION IS NOT 1)
  `;
  const params: unknown[] = [];

  if (accountZpks && accountZpks.length > 0) {
    const placeholders = accountZpks.map(() => '?').join(',');
    sql += ` AND c.${schema.accountFK} IN (${placeholders})`;
    params.push(...accountZpks);
  }

  const row = db.prepare(sql).get(...params) as { cnt: number };
  return row.cnt;
}

/**
 * 从 path 字段解析账户 Z_PK 列表。
 * 存储格式：`/path/to/NoteStore.sqlite?accounts=1,3`
 *
 * 注意：sourcePath 是**文件系统原始路径** + 可选 `?accounts=` 后缀，不是 URL。
 * 不能用 `new URL(sourcePath, 'file://').pathname` 解析——WHATWG URL 会对
 * 空格/中文/emoji 做 percent-encoding（`/Users/han siyuan/...` → `/Users/han%20siyuan/...`），
 * 后续 fs.existsSync / openNoteStoreDb 会因路径不存在而失败。
 * 这里直接用字符串切分 `?` 保留原始路径，query 部分交给 URLSearchParams。
 */
export function parseAccountsFromPath(sourcePath: string): { dbPath: string; accountZpks: number[] | undefined } {
  const queryIdx = sourcePath.indexOf('?');
  const dbPath = queryIdx === -1 ? sourcePath : sourcePath.slice(0, queryIdx);
  const queryStr = queryIdx === -1 ? '' : sourcePath.slice(queryIdx + 1);
  const accountsParam = new URLSearchParams(queryStr).get('accounts');
  const accountZpks = accountsParam
    ? accountsParam.split(',').map(Number).filter(n => !isNaN(n))
    : undefined;
  return { dbPath, accountZpks };
}
