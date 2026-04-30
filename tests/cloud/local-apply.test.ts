import { describe, expect, it } from 'vitest'
import { setupTestDb } from '../helpers/test-db.js'
import { seedNode } from '../helpers/test-db.js'
import { applyCloudNodeRow, applyCloudRows } from '../../client/electron/cloud/local-apply.js'

describe('cloud local row apply', () => {
  function createFallbackVecTable(db: ReturnType<typeof setupTestDb>): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes_vec (
        id TEXT PRIMARY KEY,
        embedding BLOB
      )
    `)
  }

  it('cleans local vector segments when a cloud node tombstone is applied', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'local active node' })
    db.prepare(
      'INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)',
    ).run(`${node.id}#0`, node.id, 0)

    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: node.content,
      archived: true,
      heat: 1,
      refinement: 0,
      connectivity: 0,
      independence: 0,
      maturity_score: 0.2,
      created: node.created,
      updated: '2026-04-30T00:00:00Z',
    })

    const row = db.prepare('SELECT archived FROM nodes WHERE id = ?').get(node.id) as { archived: number }
    const segments = db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }
    expect(row.archived).toBe(1)
    expect(segments.cnt).toBe(0)
  })

  it('cleans physical nodes_vec rows by segment id when a cloud node tombstone is applied', () => {
    const db = setupTestDb()
    createFallbackVecTable(db)
    const node = seedNode(db, { content: 'local active node with vectors' })
    const other = seedNode(db, { content: 'other node keeps vectors' })

    for (const segmentId of [`${node.id}#0`, `${node.id}#1`, `${other.id}#0`]) {
      const nodeId = segmentId.startsWith(node.id) ? node.id : other.id
      const segmentIndex = segmentId.endsWith('#1') ? 1 : 0
      db.prepare(
        'INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)',
      ).run(segmentId, nodeId, segmentIndex)
      db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(segmentId, Buffer.from([1, 2, 3]))
    }

    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: node.content,
      archived: true,
      created: node.created,
      updated: '2026-04-30T00:00:00Z',
    })

    const archivedVecs = db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id LIKE ?').get(`${node.id}#%`) as { cnt: number }
    const otherVecs = db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id LIKE ?').get(`${other.id}#%`) as { cnt: number }
    const archivedSegments = db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }

    expect(archivedVecs.cnt).toBe(0)
    expect(archivedSegments.cnt).toBe(0)
    expect(otherVecs.cnt).toBe(1)
  })

  it('applies mixed cloud rows through the shared helper', () => {
    const db = setupTestDb()

    applyCloudRows(db, 'nodes', [
      { id: 'cloud-a', type: 'fact', content: 'A', tags: ['x'], created: '2026-01-01T00:00:00Z' },
      { id: 'cloud-b', type: 'idea', content: 'B', tags: [], created: '2026-01-01T00:00:00Z' },
    ])
    applyCloudRows(db, 'links', [
      {
        id: 'cloud-link',
        from_id: 'cloud-a',
        to_id: 'cloud-b',
        relation: [{ type: 'supports', confidence: 0.8 }],
        created: '2026-01-01T00:00:00Z',
      },
    ])

    const nodes = db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE id IN (?, ?)').get('cloud-a', 'cloud-b') as { cnt: number }
    const link = db.prepare('SELECT relation FROM links WHERE id = ?').get('cloud-link') as { relation: string }
    expect(nodes.cnt).toBe(2)
    expect(JSON.parse(link.relation)).toEqual([{ type: 'supports', confidence: 0.8 }])
  })

  it('normalizes malformed cloud JSON fields instead of storing broken relation text', () => {
    const db = setupTestDb()

    applyCloudRows(db, 'nodes', [
      { id: 'json-node', type: 'fact', content: 'node', tags: '"not an array"', created: '2026-01-01T00:00:00Z' },
    ])
    applyCloudRows(db, 'links', [
      {
        id: 'json-link',
        from_id: 'json-node',
        to_id: 'json-node',
        relation: '{"type":"supports"}',
        created: '2026-01-01T00:00:00Z',
      },
    ])

    const node = db.prepare('SELECT tags FROM nodes WHERE id = ?').get('json-node') as { tags: string }
    const link = db.prepare('SELECT relation FROM links WHERE id = ?').get('json-link') as { relation: string }
    expect(JSON.parse(node.tags)).toEqual([])
    expect(JSON.parse(link.relation)).toEqual([])
  })
})
