// ============================================================
// 笔记源 CRUD — 多实例管理
// ============================================================

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('note-sources');

export interface NoteSource {
  id: string;
  name: string;
  tool_type: string;
  path: string;
  poll_interval: number;
  archived: number;
  initialized: number;
  created: string;
  last_synced: string | null;
}

export interface NoteSourceStats {
  fileCount: number;
  nodeCount: number;
  lastSynced: string | null;
}

function generateId(): string {
  // 64-bit 熵：4 字节 (32-bit) 在 ~65k sources 时碰撞概率达 50%。
  return 'ns_' + crypto.randomBytes(8).toString('hex');
}

export function listNoteSources(db: Database.Database, includeArchived = false): NoteSource[] {
  if (includeArchived) {
    return db.prepare('SELECT * FROM note_sources ORDER BY archived ASC, created DESC').all() as NoteSource[];
  }
  return db.prepare('SELECT * FROM note_sources WHERE archived = 0 ORDER BY created DESC').all() as NoteSource[];
}

export function getNoteSource(db: Database.Database, id: string): NoteSource | null {
  return (db.prepare('SELECT * FROM note_sources WHERE id = ?').get(id) as NoteSource) ?? null;
}

export function createNoteSource(
  db: Database.Database,
  params: { name: string; toolType: string; path: string; pollInterval?: number },
): NoteSource {
  const id = generateId();
  const now = new Date().toISOString();
  const pollInterval = params.pollInterval ?? 60;

  db.prepare(
    'INSERT INTO note_sources (id, name, tool_type, path, poll_interval, created) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, params.name, params.toolType, params.path, pollInterval, now);

  return {
    id,
    name: params.name,
    tool_type: params.toolType,
    path: params.path,
    poll_interval: pollInterval,
    archived: 0,
    initialized: 0,
    created: now,
    last_synced: null,
  };
}

export function updateNoteSource(
  db: Database.Database,
  id: string,
  updates: { name?: string; path?: string; pollInterval?: number },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.path !== undefined) { sets.push('path = ?'); values.push(updates.path); }
  if (updates.pollInterval !== undefined) { sets.push('poll_interval = ?'); values.push(updates.pollInterval); }

  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE note_sources SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function markInitialized(db: Database.Database, id: string): void {
  db.prepare('UPDATE note_sources SET initialized = 1 WHERE id = ?').run(id);
}

export function updateLastSynced(db: Database.Database, id: string): void {
  db.prepare('UPDATE note_sources SET last_synced = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function archiveNoteSource(db: Database.Database, id: string): void {
  db.prepare('UPDATE note_sources SET archived = 1 WHERE id = ?').run(id);
}

export function unarchiveNoteSource(db: Database.Database, id: string): void {
  db.prepare('UPDATE note_sources SET archived = 0 WHERE id = ?').run(id);
}

export function deleteNoteSource(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM note_sources WHERE id = ?').run(id);
}

export function getNoteSourceStats(db: Database.Database, id: string): NoteSourceStats {
  const source = getNoteSource(db, id);
  if (!source) return { fileCount: 0, nodeCount: 0, lastSynced: null };

  const syncTable = source.tool_type === 'logseq'
    ? 'logseq_sync'
    : source.tool_type === 'obsidian'
      ? 'obsidian_sync'
      : source.tool_type === 'notion'
        ? 'notion_sync'
        : 'apple_notes_sync';

  try {
    // 文件数
    const fileRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM ${syncTable} WHERE source_id = ?`,
    ).get(id) as { cnt: number };

    // 节点数：从 sync 表的 node_ids 汇总
    const nodeRows = db.prepare(
      `SELECT node_ids FROM ${syncTable} WHERE source_id = ? AND node_ids IS NOT NULL`,
    ).all(id) as Array<{ node_ids: string }>;

    let nodeCount = 0;
    for (const row of nodeRows) {
      try {
        const ids = JSON.parse(row.node_ids);
        if (Array.isArray(ids)) nodeCount += ids.length;
      } catch { /* ignore */ }
    }

    return {
      fileCount: fileRow.cnt,
      nodeCount,
      lastSynced: source.last_synced,
    };
  } catch {
    // sync 表可能尚不存在
    return { fileCount: 0, nodeCount: 0, lastSynced: source.last_synced };
  }
}

/**
 * 启动所有已初始化且未归档的笔记源
 */
export async function startAllNoteSources(db: Database.Database): Promise<void> {
  // 确保 note_sources 表存在（可能还没跑 migration）
  try {
    db.prepare('SELECT COUNT(*) FROM note_sources').get();
  } catch {
    log.info('note_sources 表不存在，跳过笔记源启动');
    return;
  }

  const sources = db.prepare(
    'SELECT * FROM note_sources WHERE archived = 0 AND initialized = 1',
  ).all() as NoteSource[];

  if (sources.length === 0) {
    log.info('没有已配置的笔记源');
    return;
  }

  for (const source of sources) {
    try {
      if (source.tool_type === 'logseq') {
        const { startLogseqSource } = await import('../logseq/index.js');
        await startLogseqSource(db, source.id, source.path, source.poll_interval);
      } else if (source.tool_type === 'obsidian') {
        const { startObsidianSource } = await import('../obsidian/index.js');
        await startObsidianSource(db, source.id, source.path, source.poll_interval);
      } else if (source.tool_type === 'apple-notes') {
        const { startAppleNotesSource } = await import('../apple-notes/index.js');
        await startAppleNotesSource(db, source.id, source.path, source.poll_interval);
      } else if (source.tool_type === 'notion') {
        const { startNotionSource } = await import('../notion/index.js');
        await startNotionSource(db, source.id, source.path, source.poll_interval);
      }
      log.info(`笔记源已启动: ${source.name} (${source.tool_type})`);
    } catch (err) {
      log.error(`笔记源启动失败: ${source.name}:`, (err as Error).message);
    }
  }
}

/**
 * 停止所有笔记源（同步版本，用于 process exit）
 */
export function stopAllNoteSources(): void {
  // dynamic import 在 daemon 启动时已缓存，这里同步 .then 即可
  // 但为了绝对安全，用 try-catch 包裹
  import('../logseq/index.js')
    .then(mod => mod.stopLogseqIntegration())
    .catch(() => {});
  import('../obsidian/index.js')
    .then(mod => mod.stopObsidianIntegration())
    .catch(() => {});
  import('../apple-notes/index.js')
    .then(mod => mod.stopAppleNotesIntegration())
    .catch(() => {});
  import('../notion/index.js')
    .then(mod => mod.stopNotionIntegration())
    .catch(() => {});
}

/**
 * 停止所有笔记源（async 版本，用于需要等 drain 完成再 closeDb 的 shutdown 路径）。
 * logseq 的 stopLogseqIntegration 现在 async（drain 在途 processOneFile 串行链），**必须 await** 它跑完
 * setFileState/finally 再 closeDb——否则在途节点撞已关闭的 db、退休失败 → 残留活跃孤儿（第三轮审计 HIGH:
 * 桌面端 client/electron/daemon.ts 原走同步 stopAllNoteSources + 立即 closeDb，drain 在微任务里撞已关 db）。
 * 调用方必须把超时或任一 stop 失败视为退出失败并保留 DB。这里先等待所有 integration
 * 都完成，再把失败汇总抛出，避免一个失败掩盖其他 source 的 drain 结果。
 */
export async function stopAllNoteSourcesAsync(): Promise<void> {
  const results = await Promise.allSettled([
    import('../logseq/index.js').then(mod => mod.stopLogseqIntegration()),
    import('../obsidian/index.js').then(mod => mod.stopObsidianIntegration()),
    import('../apple-notes/index.js').then(mod => mod.stopAppleNotesIntegration()),
    import('../notion/index.js').then(mod => mod.stopNotionIntegration()),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'one or more note sources failed to stop');
  }
}
