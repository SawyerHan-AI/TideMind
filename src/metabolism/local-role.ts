import type Database from 'better-sqlite3';

/**
 * 本机是否承担后台记忆整理。
 *
 * 设计：docs/design/primary-device-selection-2026-11-20.md §5.1。
 * 桌面端主进程求值后写入 metadata；调度器、向量运行时、MCP 进程、daemon 只读这个键，
 * 不需要联网，也不需要知道登录状态。
 */
const KEY = 'metabolism.local_role';

export interface LocalRoleRecord {
  organizer: boolean;
  /** 云端主设备 revision；本机求值或云端未升级时为 null。 */
  revision: number | null;
  /** local = 未登录/未开同步或尚未取得角色；server = 云端主设备状态；legacy = 云端未升级，按旧开关。 */
  source: 'local' | 'server' | 'legacy';
}

export function readLocalRoleRecord(db: Database.Database): LocalRoleRecord | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<LocalRoleRecord>;
    if (typeof parsed.organizer !== 'boolean') return null;
    return {
      organizer: parsed.organizer,
      revision: typeof parsed.revision === 'number' ? parsed.revision : null,
      source: parsed.source === 'server' || parsed.source === 'legacy' ? parsed.source : 'local',
    };
  } catch {
    return null;
  }
}

/**
 * 键不存在（桌面端从未写入过：开源版、只跑 daemon）时用 fallback，
 * 调用方传旧的本地开关值，保持这些环境的原有行为。
 */
export function readLocalOrganizerRole(db: Database.Database, fallback = true): boolean {
  return readLocalRoleRecord(db)?.organizer ?? fallback;
}

/**
 * 写入本机角色。云端来源的写入不会被更旧的 revision 覆盖。
 * 返回“是否承担整理”是否发生了变化。
 */
export function writeLocalRole(db: Database.Database, next: LocalRoleRecord): boolean {
  return db.transaction(() => {
    const current = readLocalRoleRecord(db);
    if (
      next.source === 'server' && current?.source === 'server'
      && current.revision !== null && next.revision !== null && next.revision < current.revision
    ) return false;
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY, JSON.stringify(next));
    return current === null || current.organizer !== next.organizer;
  }).immediate();
}
