import type Database from 'better-sqlite3'

export type CloudTable = 'nodes' | 'links'

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function jsonArrayText(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? JSON.stringify(parsed) : '[]'
    } catch {
      return '[]'
    }
  }
  return '[]'
}

function deleteVectorIfPresent(db: Database.Database, nodeId: string): void {
  try {
    const segments = db.prepare(
      'SELECT segment_id FROM node_segments WHERE node_id = ?',
    ).all(nodeId) as Array<{ segment_id: string }>
    try {
      const deleteVec = db.prepare('DELETE FROM nodes_vec WHERE id = ?')
      for (const segment of segments) deleteVec.run(segment.segment_id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/no such (table|module):/i.test(msg)) throw err
    }
    db.prepare('DELETE FROM node_segments WHERE node_id = ?').run(nodeId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/no such (table|module):/i.test(msg)) throw err
  }
}

/** ISO `updated` 时间戳比较:a >= b。null/无效当最旧(epoch),两者皆无效时返回 true(取云端,与历史无条件覆盖一致)。 */
function updatedGte(a: unknown, b: unknown): boolean {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN
  const tb = typeof b === 'string' ? Date.parse(b) : NaN
  const va = Number.isNaN(ta) ? -Infinity : ta
  const vb = Number.isNaN(tb) ? -Infinity : tb
  return va >= vb
}

/**
 * 内容方向裁决:云端内容是否不旧于本地。`(edit_seq, updated)` 字典序——edit_seq 为主、
 * updated 次。edit_seq 缺失(旧数据/旧客户端,默认 0)时退化为纯 `updated` 比较,与 M1 一致。
 * 这是 M3 关死"云端代谢晚于编辑、但基于旧版本改写"对抗态的核心:用户编辑 bump edit_seq,
 * 过时代谢的 edit_seq 不超过本地 → 内容保留本地。
 */
function contentTakesCloud(
  cloud: { edit_seq?: unknown; updated?: unknown },
  local: { edit_seq?: number; updated?: string },
): boolean {
  const ce = Number(cloud.edit_seq ?? 0)
  const le = Number(local.edit_seq ?? 0)
  if (ce !== le) return ce > le
  return updatedGte(cloud.updated, local.updated)
}

/** 下行版本防护开关:metadata['cloud.downlink_guard']。默认开;显式设为 'off' 时回退到无条件覆盖(逃生舱)。 */
function downlinkGuardEnabled(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(`SELECT value FROM metadata WHERE key = 'cloud.downlink_guard'`)
      .get() as { value?: string } | undefined
    return row?.value !== 'off'
  } catch {
    return true
  }
}

/** 无条件整行写入(新节点 / 云端归档 / 关闭防护 / 云端较新时用)。 */
function insertFullNodeRow(db: Database.Database, row: Record<string, unknown>): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (
      id, type, content, title,
      heat, refinement, connectivity, independence,
      specificity, subjectivity, actuality,
      is_crystal, is_tag, is_meta,
      source_tool, source_session, source_stream, source_timestamp,
      tags, created, last_reconsolidated, version, archived,
      is_keystone, is_superseded, source_device, maturity_score, updated,
      edit_seq, decay_gen
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.id,
    row.type ?? 'fact',
    row.content ?? '',
    row.title ?? null,
    Number(row.heat ?? 1.0),
    Number(row.refinement ?? 0.0),
    Number(row.connectivity ?? 0.0),
    Number(row.independence ?? 0.0),
    Number(row.specificity ?? 0.5),
    Number(row.subjectivity ?? 0.5),
    Number(row.actuality ?? 0.5),
    toBool(row.is_crystal) ? 1 : 0,
    toBool(row.is_tag) ? 1 : 0,
    toBool(row.is_meta) ? 1 : 0,
    row.source_tool ?? null,
    row.source_session ?? null,
    row.source_stream ?? null,
    row.source_timestamp ?? null,
    jsonArrayText(row.tags),
    row.created ?? new Date().toISOString(),
    row.last_reconsolidated ?? null,
    Number(row.version ?? 1),
    toBool(row.archived) ? 1 : 0,
    toBool(row.is_keystone) ? 1 : 0,
    toBool(row.is_superseded) ? 1 : 0,
    row.source_device ?? 'cloud',
    Number(row.maturity_score ?? 0.0),
    row.updated ?? row.created ?? new Date().toISOString(),
    Number(row.edit_seq ?? 0),
    Number(row.decay_gen ?? 0),
  )
}

/**
 * 下行 apply 一个云端节点行(M1:`updated` wall-clock 字段分层防护)。
 *
 * 分三种情形:
 *  1. 新节点 / 关闭防护 / 云端归档(tombstone 优先,与服务端 reconcile-policy 对称)→ 整行写入。
 *  2. 云端 active 且 `updated` 不旧于本地 → 整行写入(现行为)。
 *  3. 本地内容更新(本地有未上行编辑)→ **只更新派生字段**(heat/refinement/connectivity/
 *     independence/maturity_score/is_* 等代谢产物),内容类字段(content/title/type/tags/三维/
 *     archived/version)与 `updated` **保留本地**。
 *
 * 情形 3 是止血 current-state #4(下行盲覆盖永久丢失本地未上行编辑)的关键:既不丢用户编辑,
 * 又让派生字段继续跟随云端代谢权威;且因 `updated` 保留本地(更新),后续 reconcile 仍判定
 * "本地较新"从而把本地新内容上行。M3 会把 `updated` 比较升级为 `(edit_seq, updated)` 因果版本,
 * 关死"云端代谢晚于编辑、但基于旧版本改写"的对抗态。
 */
export function applyCloudNodeRow(db: Database.Database, row: Record<string, unknown>): void {
  const id = row.id
  const cloudArchived = toBool(row.archived)

  if (typeof id !== 'string') {
    insertFullNodeRow(db, row)
    return
  }

  const local = db
    .prepare(`SELECT edit_seq, updated FROM nodes WHERE id = ?`)
    .get(id) as { edit_seq?: number; updated?: string } | undefined

  // 情形 1:新节点 / 云端归档(tombstone 优先,不受本地 edit_seq/updated 阻拦)/ 关闭防护 → 整行写入。
  if (!local || cloudArchived || !downlinkGuardEnabled(db)) {
    insertFullNodeRow(db, row)
    if (cloudArchived) deleteVectorIfPresent(db, id)
    return
  }

  // 情形 2:云端内容不旧于本地((edit_seq, updated) 字典序)→ 整行取云端。
  if (contentTakesCloud(row, local)) {
    insertFullNodeRow(db, row)
    return
  }

  // 情形 3:本地内容更新(本地 edit_seq 更高)→ 只同步派生字段(含 decay_gen),
  // 内容类 + updated + version + edit_seq 保留本地。
  db.prepare(`
    UPDATE nodes SET
      heat = ?, refinement = ?, connectivity = ?, independence = ?,
      maturity_score = ?, is_crystal = ?, is_tag = ?, is_meta = ?,
      is_keystone = ?, is_superseded = ?, last_reconsolidated = ?, decay_gen = ?
    WHERE id = ?
  `).run(
    Number(row.heat ?? 1.0),
    Number(row.refinement ?? 0.0),
    Number(row.connectivity ?? 0.0),
    Number(row.independence ?? 0.0),
    Number(row.maturity_score ?? 0.0),
    toBool(row.is_crystal) ? 1 : 0,
    toBool(row.is_tag) ? 1 : 0,
    toBool(row.is_meta) ? 1 : 0,
    toBool(row.is_keystone) ? 1 : 0,
    toBool(row.is_superseded) ? 1 : 0,
    row.last_reconsolidated ?? null,
    Number(row.decay_gen ?? 0),
    id,
  )
}

export function applyCloudLinkRow(db: Database.Database, row: Record<string, unknown>): void {
  const id = row.id
  // M10 + links 下行防护(审计 HIGH):本地 link 若 (edit_seq, updated) 更新(有未上行的编辑/软删)
  // → 不被云端旧版本盲覆盖。否则本地软删(deleted=1、edit_seq 已 bump)会被云端 deleted=0 下行
  // 复活,或本地 link 编辑被云端 strength decay 的旧版本覆盖丢失(对齐 nodes 的 contentTakesCloud)。
  if (typeof id === 'string' && downlinkGuardEnabled(db)) {
    const local = db
      .prepare(`SELECT edit_seq, updated FROM links WHERE id = ?`)
      .get(id) as { edit_seq?: number; updated?: string } | undefined
    if (local && !contentTakesCloud(row, local)) return
  }
  db.prepare(`
    INSERT OR REPLACE INTO links (
      id, from_id, to_id, relation, strength, note, auto, status, created, updated, edit_seq, deleted
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.id,
    row.from_id,
    row.to_id,
    jsonArrayText(row.relation),
    Number(row.strength ?? 0.5),
    row.note ?? null,
    toBool(row.auto) ? 1 : 0,
    row.status ?? 'confirmed',
    row.created ?? new Date().toISOString(),
    row.updated ?? row.created ?? new Date().toISOString(),
    Number(row.edit_seq ?? 0),
    toBool(row.deleted) ? 1 : 0,
  )
}

/**
 * 回声抑制(M6):下行 apply 期间置 sync_apply_guard.applying=1,使 nodes/links 写触发器不记
 * 脏集(cloud_dirty),避免"下行写入被当成本地写又上行"的回声环。guard 表不存在(旧 schema 未
 * 迁移)时静默跳过(那种库也没触发器,无需抑制)。
 */
export function withApplyGuard<T>(db: Database.Database, fn: () => T): T {
  let guarded = false
  try {
    db.prepare(`UPDATE sync_apply_guard SET applying = 1 WHERE k = 0`).run()
    guarded = true
  } catch { /* 无 guard 表 → 无触发器,无需抑制 */ }
  try {
    return fn()
  } finally {
    if (guarded) {
      try { db.prepare(`UPDATE sync_apply_guard SET applying = 0 WHERE k = 0`).run() } catch { /* 同上 */ }
    }
  }
}

export function applyCloudRows(
  db: Database.Database,
  table: CloudTable,
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) return
  const insert = db.transaction((items: Array<Record<string, unknown>>) => {
    for (const row of items) {
      if (table === 'nodes') applyCloudNodeRow(db, row)
      else applyCloudLinkRow(db, row)
    }
  })
  withApplyGuard(db, () => insert(rows))
}
