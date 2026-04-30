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

export function applyCloudNodeRow(db: Database.Database, row: Record<string, unknown>): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (
      id, type, content, title,
      heat, refinement, connectivity, independence,
      specificity, subjectivity, actuality,
      is_crystal, is_tag, is_meta,
      source_tool, source_session, source_stream, source_timestamp,
      tags, created, last_reconsolidated, version, archived,
      is_keystone, is_superseded, source_device, maturity_score, updated
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
  )

  if (toBool(row.archived) && typeof row.id === 'string') {
    deleteVectorIfPresent(db, row.id)
  }
}

export function applyCloudLinkRow(db: Database.Database, row: Record<string, unknown>): void {
  db.prepare(`
    INSERT OR REPLACE INTO links (
      id, from_id, to_id, relation, strength, note, auto, status, created, updated
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
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
  )
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
  insert(rows)
}
