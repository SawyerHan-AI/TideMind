/**
 * 纯函数工具,不依赖 electron / better-sqlite3 等重量级运行时,
 * 以便被 Electron 主进程代码 + 测试(vitest 节点环境)共用。
 *
 * reconciler.ts 从这里 re-export,单元测试直接从这里 import 避免触发
 * 顶部的 electron import 链(vitest 在根目录跑,client 的 electron 包
 * 不在根 node_modules 里,会 MODULE_NOT_FOUND)。
 */

/** 时间戳相等容差(毫秒)。SQLite datetime('now') 无毫秒、PG now() 带毫秒,
 * 同一次写入双方时间戳可能有 1s 以内抖动。超过该容差才认为是真正不同的版本。*/
export const TS_EQUAL_TOLERANCE_MS = 1000;

export interface ReconcileManifestEntry {
  id: string
  updated: string
  archived?: boolean
}

export type ManifestWinner = 'same' | 'local' | 'server'

export interface ReconcileActionPlan {
  onlyLocal: string[]
  onlyServer: string[]
  toUpload: string[]
  toDownload: string[]
  conflicts: Array<{ id: string; winner: 'local' | 'server' }>
}

/**
 * 把 SQLite / PG / JS 三种格式的时间戳字符串规范化为毫秒数。
 *  - SQLite `datetime('now')`: '2026-04-20 10:30:00'(无 T、无时区,UTC)
 *  - PG JSONB ISO:            '2026-04-20T10:30:00.123+00:00' 或 '...Z'
 *  - JS Date.toISOString():   '2026-04-20T10:30:00.123Z'
 * 无效输入返回 0。
 */
export function normalizeTs(ts: string | null | undefined): number {
  if (!ts) return 0;
  let s = String(ts).trim();
  if (!s) return 0;
  // SQLite 'YYYY-MM-DD HH:MM:SS[.fff]' → ISO 'YYYY-MM-DDTHH:MM:SS[.fff]'
  if (!s.includes('T') && s.length >= 10 && s[10] === ' ') {
    s = s.slice(0, 10) + 'T' + s.slice(11);
  }
  // SQLite 默认 UTC 但不带时区后缀;若只有 T 没有 Z/+/- 时区,补 Z
  const hasTz = /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  if (s.includes('T') && !hasTz) {
    s += 'Z';
  }
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** 两个时间戳是否"实质相等"(容忍 1s 抖动)。 */
export function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = normalizeTs(a);
  const db = normalizeTs(b);
  if (da === 0 && db === 0) return true;
  return Math.abs(da - db) < TS_EQUAL_TOLERANCE_MS;
}

export function chooseManifestWinner(
  local: ReconcileManifestEntry,
  server: ReconcileManifestEntry,
): ManifestWinner {
  const localArchived = local.archived === true
  const serverArchived = server.archived === true
  if (localArchived !== serverArchived) return localArchived ? 'local' : 'server'
  if (timestampsEqual(local.updated, server.updated)) return 'same'
  return normalizeTs(local.updated) > normalizeTs(server.updated) ? 'local' : 'server'
}

export function planReconcileActions(
  localManifest: ReconcileManifestEntry[],
  serverManifest: ReconcileManifestEntry[],
): ReconcileActionPlan {
  const serverMap = new Map(serverManifest.map(entry => [entry.id, entry]))
  const localMap = new Map(localManifest.map(entry => [entry.id, entry]))
  const onlyLocal: string[] = []
  const onlyServer: string[] = []
  const conflicts: Array<{ id: string; winner: 'local' | 'server' }> = []

  for (const [id, local] of localMap.entries()) {
    const server = serverMap.get(id)
    if (!server) {
      onlyLocal.push(id)
      continue
    }

    const winner = chooseManifestWinner(local, server)
    if (winner !== 'same') conflicts.push({ id, winner })
  }

  for (const id of serverMap.keys()) {
    if (!localMap.has(id)) onlyServer.push(id)
  }

  return {
    onlyLocal,
    onlyServer,
    toUpload: [...onlyLocal, ...conflicts.filter(item => item.winner === 'local').map(item => item.id)],
    toDownload: [...onlyServer, ...conflicts.filter(item => item.winner === 'server').map(item => item.id)],
    conflicts,
  }
}
