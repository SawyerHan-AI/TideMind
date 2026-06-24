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

/** 无条件整行写入(新节点 / 云端归档 / 关闭防护 / 云端较新时用)。
 *  localSuperseded:调用方传入的本地 is_superseded 态,与云端值 OR 合并(单调粘滞)。 */
function insertFullNodeRow(db: Database.Database, row: Record<string, unknown>, localSuperseded = false): void {
  // 纵深防御(2026-06-18 supersede-heat-cloud-roundtrip):退休(superseded)节点的派生字段
  // 必须落地板。即便服务端因旧版本/部署 skew 仍下发高 heat/connectivity/maturity,本地镜像
  // 也强制 heat=0.01/connectivity=0/maturity_score=0,杜绝旧版本在图谱里以高热/大节点复活。
  //
  // sup = 本地||云端(单调,退休只增不减)。HIGH-B 修复(2026-06-18 三轮审计):情形2(contentTakesCloud)
  // 传 localSuperseded → 多设备并发下"另一端陈旧 active 但 edit_seq 更高的行"经情形2 整行写时,
  // 本地已退休则 sup=true、强制落地板 + is_superseded 保持 1,不被翻回 active+高热(与情形3/服务端
  // 两路 upsert 对称)。情形1(新节点无本地态 / 归档 tombstone / guard-off 逃生舱)默认 false:guard-off
  // 语义就是"放弃下行防护、无条件覆盖"(同 backlog 已记的 guard-off 复活已删 link),不单独保单调。
  const sup = localSuperseded || toBool(row.is_superseded)
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
    sup ? 0.01 : Number(row.heat ?? 1.0),
    Number(row.refinement ?? 0.0),
    sup ? 0 : Number(row.connectivity ?? 0.0),
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
    sup ? 1 : 0,
    row.source_device ?? 'cloud',
    sup ? 0 : Number(row.maturity_score ?? 0.0),
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
    .prepare(`SELECT edit_seq, updated, is_superseded FROM nodes WHERE id = ?`)
    .get(id) as { edit_seq?: number; updated?: string; is_superseded?: number } | undefined

  // 情形 1:新节点 / 云端归档(tombstone 优先,不受本地 edit_seq/updated 阻拦)/ 关闭防护 → 整行写入。
  // F1 修复(2026-06-24 logseq-orphan):local 存在且 guard 开(主要是 cloudArchived 子情况)时传
  // localSuperseded 做 is_superseded OR 单调,防陈旧云端 active 整行覆盖把本地退休节点复活——这是
  // supersede-heat 审计标 LOW-3 未修的 Case1 洞,实测在 2026-06-21/23 复活了 ~3000 个退休孤儿。
  // !local(新节点无本地态)与 guard-off(逃生舱,放弃所有下行防护)传 false 维持既定语义。
  const guardOn = downlinkGuardEnabled(db)
  if (!local || cloudArchived || !guardOn) {
    insertFullNodeRow(db, row, !!local && guardOn ? (local.is_superseded ?? 0) === 1 : false)
    if (cloudArchived) deleteVectorIfPresent(db, id)
    return
  }

  // 情形 2:云端内容不旧于本地((edit_seq, updated) 字典序)→ 整行取云端。
  // HIGH-B 修复:传本地 is_superseded 做 OR 合并 —— 多设备并发下,另一端陈旧 active 但 edit_seq 更高
  // 的行会经 contentTakesCloud 走到这里,不能把本地刚退休节点翻回 active(supersede 单调)。
  if (contentTakesCloud(row, local)) {
    insertFullNodeRow(db, row, (local.is_superseded ?? 0) === 1)
    return
  }

  // 情形 3:本地内容更新(本地 edit_seq 更高)→ 只同步派生字段(含 decay_gen),
  // 内容类 + updated + version + edit_seq 保留本地。
  // 纵深防御(2026-06-18 supersede-heat-cloud-roundtrip):同 insertFullNodeRow,退休节点的
  // heat/connectivity/maturity 强制落地板,不被云端旧高值污染。
  //
  // CRITICAL 修复(C1,2026-06-18 审计):is_superseded 在情形 3 **单调粘滞**——本地已退休(=1)时,
  // 不被云端**滞后的** is_superseded=0 翻回 active。情形 3 的前提是"本地 edit_seq 更高=本地权威",
  // 而本地刚 supersede(bump 了 edit_seq)、其 uplink 尚未落地时,一个陈旧云端 active 行下行恰好
  // 走到这里;若把 is_superseded 当普通派生字段无条件取云端,会把刚退休节点改回 active+高热,且
  // 下一次 uplink 用实时行(SELECT *)把污染推回服务端、永不自愈。全仓无任何合法 un-supersede 路径
  // (is_superseded 只增不减),故 OR 合并(本地||云端)安全:只要任一端认定退休即保持退休。
  // supEffective 据合并值判定 → 本地已退休时强制三字段落地板。
  const localSuperseded = (local.is_superseded ?? 0) === 1
  const supEffective = localSuperseded || toBool(row.is_superseded)
  db.prepare(`
    UPDATE nodes SET
      heat = ?, refinement = ?, connectivity = ?, independence = ?,
      maturity_score = ?, is_crystal = ?, is_tag = ?, is_meta = ?,
      is_keystone = ?, is_superseded = ?, last_reconsolidated = ?, decay_gen = ?
    WHERE id = ?
  `).run(
    supEffective ? 0.01 : Number(row.heat ?? 1.0),
    Number(row.refinement ?? 0.0),
    supEffective ? 0 : Number(row.connectivity ?? 0.0),
    Number(row.independence ?? 0.0),
    supEffective ? 0 : Number(row.maturity_score ?? 0.0),
    toBool(row.is_crystal) ? 1 : 0,
    toBool(row.is_tag) ? 1 : 0,
    toBool(row.is_meta) ? 1 : 0,
    toBool(row.is_keystone) ? 1 : 0,
    supEffective ? 1 : 0,
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
