/**
 * tests/client/local-apply.test.ts
 *
 * 补充 client/electron/cloud/local-apply.ts 的覆盖:
 *   - 默认字段填充(content/heat/refinement/...)
 *   - 各 boolean flag 的 truthy 转换(toBool)
 *   - source_device + maturity_score 字段
 *   - is_keystone / is_superseded
 *   - links: relation 数组/字符串两种输入,strength/status/auto/note
 *   - applyCloudRows 事务行为(空数组提前 return)
 *   - vector 清理在 vec 表不存在时静默 swallow
 *
 * 注意:不修改已有的 tests/cloud/local-apply.test.ts。
 */

import { describe, expect, it } from 'vitest'
import { setupTestDb, seedNode } from '../helpers/test-db.js'
import {
  applyCloudNodeRow,
  applyCloudLinkRow,
  applyCloudRows,
} from '../../client/electron/cloud/local-apply.js'

describe('applyCloudNodeRow — default values', () => {
  it('uses fact as default type when missing', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-deftype', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT type FROM nodes WHERE id = ?').get('n-deftype') as { type: string }
    expect(row.type).toBe('fact')
  })

  it('uses empty string content when content missing', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defcontent', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT content FROM nodes WHERE id = ?').get('n-defcontent') as { content: string }
    expect(row.content).toBe('')
  })

  it('uses heat=1.0 / refinement=0 / connectivity=0 / independence=0 defaults', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defmat', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare(
      'SELECT heat, refinement, connectivity, independence FROM nodes WHERE id = ?',
    ).get('n-defmat') as { heat: number; refinement: number; connectivity: number; independence: number }
    expect(row.heat).toBe(1.0)
    expect(row.refinement).toBe(0.0)
    expect(row.connectivity).toBe(0.0)
    expect(row.independence).toBe(0.0)
  })

  it('uses specificity/subjectivity/actuality=0.5 defaults', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defss', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT specificity, subjectivity, actuality FROM nodes WHERE id = ?').get('n-defss') as {
      specificity: number
      subjectivity: number
      actuality: number
    }
    expect(row.specificity).toBe(0.5)
    expect(row.subjectivity).toBe(0.5)
    expect(row.actuality).toBe(0.5)
  })

  it('uses cloud as default source_device when missing', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defsrc', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT source_device FROM nodes WHERE id = ?').get('n-defsrc') as {
      source_device: string
    }
    expect(row.source_device).toBe('cloud')
  })

  it('explicit source_device wins over cloud default', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-explicitsrc',
      content: 'x',
      created: '2026-01-01T00:00:00Z',
      source_device: 'phone-xyz',
    })
    const row = db.prepare('SELECT source_device FROM nodes WHERE id = ?').get('n-explicitsrc') as {
      source_device: string
    }
    expect(row.source_device).toBe('phone-xyz')
  })

  it('version=1 default', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defver', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT version FROM nodes WHERE id = ?').get('n-defver') as { version: number }
    expect(row.version).toBe(1)
  })

  it('maturity_score=0 default', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defmat2', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT maturity_score FROM nodes WHERE id = ?').get('n-defmat2') as {
      maturity_score: number
    }
    expect(row.maturity_score).toBe(0.0)
  })

  it('updated falls back to created when missing both', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-defupd', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT created, updated FROM nodes WHERE id = ?').get('n-defupd') as {
      created: string
      updated: string
    }
    expect(row.updated).toBe(row.created)
  })

  it('synthesizes created/updated if both missing (ISO string)', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-synth', content: 'x' })
    const row = db.prepare('SELECT created, updated FROM nodes WHERE id = ?').get('n-synth') as {
      created: string
      updated: string
    }
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('applyCloudNodeRow — boolean flag conversion (toBool)', () => {
  it('accepts true literal for is_crystal', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-cr-bool',
      type: 'crystal',
      content: 'x',
      is_crystal: true,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_crystal FROM nodes WHERE id = ?').get('n-cr-bool') as {
      is_crystal: number
    }
    expect(row.is_crystal).toBe(1)
  })

  it('accepts numeric 1 for is_crystal', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-cr-num',
      type: 'crystal',
      content: 'x',
      is_crystal: 1,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_crystal FROM nodes WHERE id = ?').get('n-cr-num') as {
      is_crystal: number
    }
    expect(row.is_crystal).toBe(1)
  })

  it('accepts string "true" for is_crystal', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-cr-str',
      type: 'crystal',
      content: 'x',
      is_crystal: 'true',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_crystal FROM nodes WHERE id = ?').get('n-cr-str') as {
      is_crystal: number
    }
    expect(row.is_crystal).toBe(1)
  })

  it('treats false/0/undefined as 0', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-falsy',
      content: 'x',
      is_crystal: false,
      is_tag: 0,
      is_meta: undefined,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_crystal, is_tag, is_meta FROM nodes WHERE id = ?').get('n-falsy') as {
      is_crystal: number
      is_tag: number
      is_meta: number
    }
    expect(row.is_crystal).toBe(0)
    expect(row.is_tag).toBe(0)
    expect(row.is_meta).toBe(0)
  })

  it('persists is_keystone flag', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-keystone',
      content: 'x',
      is_keystone: true,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_keystone FROM nodes WHERE id = ?').get('n-keystone') as {
      is_keystone: number
    }
    expect(row.is_keystone).toBe(1)
  })

  it('persists is_superseded flag', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-super',
      content: 'x',
      is_superseded: true,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_superseded FROM nodes WHERE id = ?').get('n-super') as {
      is_superseded: number
    }
    expect(row.is_superseded).toBe(1)
  })

  it('is_tag flag persists via toBool path', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-tag',
      type: 'fact',
      content: 'x',
      is_tag: '1',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT is_tag FROM nodes WHERE id = ?').get('n-tag') as { is_tag: number }
    expect(row.is_tag).toBe(1)
  })
})

describe('applyCloudNodeRow — INSERT OR REPLACE (upsert)', () => {
  it('overwrites existing local row with cloud data', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'old local' })
    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: 'new from cloud',
      created: node.created,
      updated: '2026-04-30T00:00:00Z',
    })
    const row = db.prepare('SELECT content FROM nodes WHERE id = ?').get(node.id) as { content: string }
    expect(row.content).toBe('new from cloud')
  })

  it('does NOT delete vectors when archived=false on existing node', () => {
    const db = setupTestDb()
    db.exec(`CREATE TABLE IF NOT EXISTS nodes_vec (id TEXT PRIMARY KEY, embedding BLOB)`)
    const node = seedNode(db, { content: 'local' })
    db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(
      `${node.id}#0`, node.id, 0,
    )
    db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(`${node.id}#0`, Buffer.from([1]))

    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: 'update content not archived',
      archived: false,
      created: node.created,
      updated: '2026-04-30T00:00:00Z',
    })
    const vec = db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id = ?').get(`${node.id}#0`) as { cnt: number }
    expect(vec.cnt).toBe(1)
  })

  it('archived without nodes_vec table does not throw (no such table swallowed)', () => {
    const db = setupTestDb()
    // node_segments table from base schema, but no nodes_vec table
    const node = seedNode(db, { content: 'local' })
    db.prepare('INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)').run(
      `${node.id}#0`, node.id, 0,
    )
    expect(() =>
      applyCloudNodeRow(db, {
        id: node.id,
        content: 'archived',
        archived: true,
        created: node.created,
        updated: '2026-04-30T00:00:00Z',
      }),
    ).not.toThrow()
    // segments are still cleaned even without vec table
    const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM node_segments WHERE node_id = ?').get(node.id) as { cnt: number }
    expect(cnt.cnt).toBe(0)
  })
})

describe('applyCloudNodeRow — string archived input', () => {
  it('accepts archived="1"', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-arch-num-str',
      content: 'x',
      archived: '1',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT archived FROM nodes WHERE id = ?').get('n-arch-num-str') as {
      archived: number
    }
    expect(row.archived).toBe(1)
  })

  it('treats archived="0" as not archived', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-arch-0-str',
      content: 'x',
      archived: '0',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT archived FROM nodes WHERE id = ?').get('n-arch-0-str') as {
      archived: number
    }
    expect(row.archived).toBe(0)
  })
})

describe('applyCloudNodeRow — tags JSON normalization', () => {
  it('serializes array as JSON', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-tag-arr',
      content: 'x',
      tags: ['foo', 'bar'],
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT tags FROM nodes WHERE id = ?').get('n-tag-arr') as { tags: string }
    expect(JSON.parse(row.tags)).toEqual(['foo', 'bar'])
  })

  it('parses valid JSON string of array', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-tag-jsonstr',
      content: 'x',
      tags: '["a","b"]',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT tags FROM nodes WHERE id = ?').get('n-tag-jsonstr') as { tags: string }
    expect(JSON.parse(row.tags)).toEqual(['a', 'b'])
  })

  it('rejects non-array JSON string, falls back to []', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-tag-obj',
      content: 'x',
      tags: '{"not": "array"}',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT tags FROM nodes WHERE id = ?').get('n-tag-obj') as { tags: string }
    expect(JSON.parse(row.tags)).toEqual([])
  })

  it('falls back to [] when tags is null/undefined', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-tag-null',
      content: 'x',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT tags FROM nodes WHERE id = ?').get('n-tag-null') as { tags: string }
    expect(JSON.parse(row.tags)).toEqual([])
  })
})

describe('applyCloudLinkRow', () => {
  function ensureNodes(db: ReturnType<typeof setupTestDb>): { a: string; b: string } {
    const a = seedNode(db, { content: 'A' })
    const b = seedNode(db, { content: 'B' })
    return { a: a.id, b: b.id }
  }

  it('inserts link with default strength=0.5, status=confirmed, auto=0', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-defaults',
      from_id: a,
      to_id: b,
      relation: [{ type: 'supports', confidence: 0.9 }],
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare(
      'SELECT strength, status, auto, note FROM links WHERE id = ?',
    ).get('link-defaults') as { strength: number; status: string; auto: number; note: string | null }
    expect(row.strength).toBe(0.5)
    expect(row.status).toBe('confirmed')
    expect(row.auto).toBe(0)
    expect(row.note).toBeNull()
  })

  it('preserves explicit strength/note/status', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-explicit',
      from_id: a,
      to_id: b,
      relation: [{ type: 'contradicts', confidence: 0.3 }],
      strength: 0.92,
      note: 'manual override',
      status: 'pending',
      auto: false,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT strength, status, auto, note FROM links WHERE id = ?').get('link-explicit') as {
      strength: number
      status: string
      auto: number
      note: string
    }
    expect(row.strength).toBe(0.92)
    expect(row.status).toBe('pending')
    expect(row.note).toBe('manual override')
    expect(row.auto).toBe(0)
  })

  it('coerces relation string to JSON array (already JSON of array)', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-relstr',
      from_id: a,
      to_id: b,
      relation: '[{"type":"supports","confidence":0.7}]',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT relation FROM links WHERE id = ?').get('link-relstr') as {
      relation: string
    }
    expect(JSON.parse(row.relation)).toEqual([{ type: 'supports', confidence: 0.7 }])
  })

  it('relation non-array JSON string → "[]"', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-relnonarr',
      from_id: a,
      to_id: b,
      relation: '"single string"',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT relation FROM links WHERE id = ?').get('link-relnonarr') as {
      relation: string
    }
    expect(JSON.parse(row.relation)).toEqual([])
  })

  it('relation null → "[]"', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-relnull',
      from_id: a,
      to_id: b,
      relation: null,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT relation FROM links WHERE id = ?').get('link-relnull') as {
      relation: string
    }
    expect(JSON.parse(row.relation)).toEqual([])
  })

  it('updated falls back to created when missing', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-defupd',
      from_id: a,
      to_id: b,
      relation: [],
      created: '2026-02-01T00:00:00Z',
    })
    const row = db.prepare('SELECT created, updated FROM links WHERE id = ?').get('link-defupd') as {
      created: string
      updated: string
    }
    expect(row.updated).toBe(row.created)
  })

  it('INSERT OR REPLACE overwrites existing link with same id', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-up',
      from_id: a,
      to_id: b,
      relation: [{ type: 'supports', confidence: 0.5 }],
      strength: 0.5,
      created: '2026-01-01T00:00:00Z',
    })
    applyCloudLinkRow(db, {
      id: 'link-up',
      from_id: a,
      to_id: b,
      relation: [{ type: 'contradicts', confidence: 0.9 }],
      strength: 0.95,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-04-01T00:00:00Z',
    })
    const row = db.prepare('SELECT relation, strength FROM links WHERE id = ?').get('link-up') as {
      relation: string
      strength: number
    }
    expect(row.strength).toBe(0.95)
    expect(JSON.parse(row.relation)).toEqual([{ type: 'contradicts', confidence: 0.9 }])
  })

  it('explicit auto=true persists as 1', () => {
    const db = setupTestDb()
    const { a, b } = ensureNodes(db)
    applyCloudLinkRow(db, {
      id: 'link-auto',
      from_id: a,
      to_id: b,
      relation: [],
      auto: true,
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT auto FROM links WHERE id = ?').get('link-auto') as { auto: number }
    expect(row.auto).toBe(1)
  })
})

describe('applyCloudRows — bulk and transaction behavior', () => {
  it('empty array is a no-op (no exception)', () => {
    const db = setupTestDb()
    expect(() => applyCloudRows(db, 'nodes', [])).not.toThrow()
    expect(() => applyCloudRows(db, 'links', [])).not.toThrow()
  })

  it('applies multiple nodes in one transaction (all-or-nothing)', () => {
    const db = setupTestDb()
    applyCloudRows(db, 'nodes', [
      { id: 'bulk-1', content: 'A', created: '2026-01-01T00:00:00Z' },
      { id: 'bulk-2', content: 'B', created: '2026-01-01T00:00:00Z' },
      { id: 'bulk-3', content: 'C', created: '2026-01-01T00:00:00Z' },
    ])
    const cnt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM nodes WHERE id IN ('bulk-1','bulk-2','bulk-3')`,
    ).get() as { cnt: number }
    expect(cnt.cnt).toBe(3)
  })

  it('one invalid node aborts the whole batch (transaction rollback)', () => {
    const db = setupTestDb()
    // Pre-seed one row to verify it's untouched after rollback
    seedNode(db, { content: 'existing' })
    const cntBefore = (db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number }).cnt
    // The bad row has type='invalid', violating the CHECK constraint.
    expect(() =>
      applyCloudRows(db, 'nodes', [
        { id: 'bulk-ok-1', content: 'ok', created: '2026-01-01T00:00:00Z' },
        { id: 'bulk-bad', type: 'invalid_type', content: 'bad', created: '2026-01-01T00:00:00Z' },
        { id: 'bulk-ok-2', content: 'ok2', created: '2026-01-01T00:00:00Z' },
      ]),
    ).toThrow()
    const cntAfter = (db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: number }).cnt
    expect(cntAfter).toBe(cntBefore) // 全回滚
  })

  it('routes links table to applyCloudLinkRow inside transaction', () => {
    const db = setupTestDb()
    const a = seedNode(db, { content: 'A' })
    const b = seedNode(db, { content: 'B' })
    applyCloudRows(db, 'links', [
      {
        id: 'bulk-link-1',
        from_id: a.id,
        to_id: b.id,
        relation: [{ type: 'supports', confidence: 0.5 }],
        created: '2026-01-01T00:00:00Z',
      },
    ])
    const row = db.prepare('SELECT id FROM links WHERE id = ?').get('bulk-link-1') as { id: string }
    expect(row.id).toBe('bulk-link-1')
  })

  it('mixed batch: nodes and links sequentially (caller picks table per call)', () => {
    const db = setupTestDb()
    applyCloudRows(db, 'nodes', [
      { id: 'mix-a', content: 'A', created: '2026-01-01T00:00:00Z' },
      { id: 'mix-b', content: 'B', created: '2026-01-01T00:00:00Z' },
    ])
    applyCloudRows(db, 'links', [
      {
        id: 'mix-link',
        from_id: 'mix-a',
        to_id: 'mix-b',
        relation: [],
        created: '2026-01-01T00:00:00Z',
      },
    ])
    const n = db.prepare(`SELECT COUNT(*) AS cnt FROM nodes WHERE id LIKE 'mix-%'`).get() as { cnt: number }
    const l = db.prepare(`SELECT COUNT(*) AS cnt FROM links WHERE id LIKE 'mix-%'`).get() as { cnt: number }
    expect(n.cnt).toBe(2)
    expect(l.cnt).toBe(1)
  })
})

describe('applyCloudNodeRow — title/source_session/source_tool nullable fields', () => {
  it('persists explicit title', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-title',
      content: 'x',
      title: 'My title',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare('SELECT title FROM nodes WHERE id = ?').get('n-title') as { title: string }
    expect(row.title).toBe('My title')
  })

  it('persists source_tool/source_session/source_stream/source_timestamp', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'n-sources',
      content: 'x',
      source_tool: 'claude-code',
      source_session: 'sess-1',
      source_stream: 'stream-z',
      source_timestamp: '2026-01-01T10:00:00Z',
      created: '2026-01-01T00:00:00Z',
    })
    const row = db.prepare(
      'SELECT source_tool, source_session, source_stream, source_timestamp FROM nodes WHERE id = ?',
    ).get('n-sources') as {
      source_tool: string
      source_session: string
      source_stream: string
      source_timestamp: string
    }
    expect(row.source_tool).toBe('claude-code')
    expect(row.source_session).toBe('sess-1')
    expect(row.source_stream).toBe('stream-z')
    expect(row.source_timestamp).toBe('2026-01-01T10:00:00Z')
  })

  it('title null when missing', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'n-no-title', content: 'x', created: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT title FROM nodes WHERE id = ?').get('n-no-title') as { title: string | null }
    expect(row.title).toBeNull()
  })
})
