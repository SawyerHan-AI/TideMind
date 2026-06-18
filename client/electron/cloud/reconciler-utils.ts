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
  edit_seq?: number
  version?: number
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

/** 因果序:edit_seq 优先(>0),缺失回退 version,再回退 0。与服务端 reconcile-policy.causalSeq 对齐。 */
export function manifestCausalSeq(e: { edit_seq?: number; version?: number }): number {
  const ed = Number(e.edit_seq ?? NaN)
  if (Number.isFinite(ed) && ed > 0) return ed
  const v = Number(e.version ?? NaN)
  if (Number.isFinite(v) && v > 0) return v
  return 0
}

export function chooseManifestWinner(
  local: ReconcileManifestEntry,
  server: ReconcileManifestEntry,
): ManifestWinner {
  const localArchived = local.archived === true
  const serverArchived = server.archived === true
  if (localArchived !== serverArchived) {
    // 审计修复(HIGH):archived 不一致不再纯 tombstone,按 edit_seq **直接**比较,对齐 server
    // decideNodeUpsert 的 unarchive 例外。archive/unarchive 不 bump version,故不用 causalSeq
    // (version 兜底会因 version 相等误判);edit_seq 高的一侧赢 —— 跨设备 unarchive 的 active
    // (local edit_seq 高、server archived 低)不再被 ≤7 天 reconcile 兜底通道重新归档。相等
    // (含旧数据双 0)退回 tombstone 优先(归档侧),与 M5 前行为一致、不复活过时 active。
    const lae = Number(local.edit_seq ?? 0)
    const sae = Number(server.edit_seq ?? 0)
    if (lae !== sae) return lae > sae ? 'local' : 'server'
    return localArchived ? 'local' : 'server'
  }
  // 内容方向:(edit_seq, updated) 字典序——edit_seq 为主,updated 解平局。这是把 M3 因果版本
  // 贯彻到 reconcile 的关键:本地有未上行编辑(edit_seq 更高)时判 'local' 上行,不被云端派生
  // 改动(只 bump updated 不 bump edit_seq)的较新 updated 误导成 'server'(updated 双角色陷阱)。
  const le = manifestCausalSeq(local)
  const se = manifestCausalSeq(server)
  if (le !== se) return le > se ? 'local' : 'server'
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
