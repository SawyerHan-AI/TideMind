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
  it('overwrites existing local row when cloud updated is newer', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'old local' })
    // 本地 updated 设为过去,确保云端 updated 更新 → 整行覆盖(情形 2)
    db.prepare('UPDATE nodes SET updated = ? WHERE id = ?').run('2026-01-01T00:00:00Z', node.id)
    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: 'new from cloud',
      created: node.created,
      updated: '2099-01-01T00:00:00Z',
      edit_seq: 2, // M3:云端 edit_seq 高于本地(seedNode createNode=1)才取云端
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

describe('applyCloudLinkRow — M10 软删 + links 下行防护', () => {
  // 返回 {from, to}:真实 seeded 节点(links 表有 FK,from_id/to_id 必须指向存在的节点)
  function endpoints(db: ReturnType<typeof setupTestDb>): { from: string; to: string } {
    return { from: seedNode(db, { content: 'A' }).id, to: seedNode(db, { content: 'B' }).id }
  }
  const del = (db: ReturnType<typeof setupTestDb>) =>
    db.prepare('SELECT deleted, edit_seq, note FROM links WHERE id = ?').get('L') as
      { deleted: number; edit_seq: number; note: string | null }

  it('云端 deleted=1 下行 → 本地新 link 标记 deleted(删除传播到本地)', () => {
    const db = setupTestDb()
    const { from, to } = endpoints(db)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-02-01T00:00:00Z', edit_seq: 2, deleted: 1 })
    expect(del(db).deleted).toBe(1)
  })

  it('防复活:本地已软删(edit_seq 高)→ 云端旧 alive 版本(edit_seq 低、updated 更新)不复活', () => {
    const db = setupTestDb()
    const { from, to } = endpoints(db)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', edit_seq: 1, deleted: 0 })
    // 本地软删:deleted=1, edit_seq=2, updated 推到 2026-02
    db.prepare('UPDATE links SET deleted = 1, edit_seq = 2, updated = ? WHERE id = ?').run('2026-02-01T00:00:00Z', 'L')
    // 云端推来 stale alive(edit_seq 1 < 本地 2,但 updated 2026-03 更新 → 纯 updated 会误复活)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-03-01T00:00:00Z', edit_seq: 1, deleted: 0 })
    const row = del(db)
    expect(row.deleted).toBe(1)   // 因果序 edit_seq 为主:保留本地软删,未复活
    expect(row.edit_seq).toBe(2)
  })

  it('本地 link 编辑(edit_seq 高)不被云端旧版本下行覆盖', () => {
    const db = setupTestDb()
    const { from, to } = endpoints(db)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [{ type: 'supports', confidence: 0.9 }], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', edit_seq: 1 })
    db.prepare('UPDATE links SET edit_seq = 3, note = ? WHERE id = ?').run('local note', 'L')
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2099-01-01T00:00:00Z', edit_seq: 2 })
    const row = del(db)
    expect(row.note).toBe('local note') // edit_seq 3 > 2:保留本地
    expect(row.edit_seq).toBe(3)
  })

  it('云端 edit_seq 更高 → 整行取云端(含 deleted=1)', () => {
    const db = setupTestDb()
    const { from, to } = endpoints(db)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', edit_seq: 1, deleted: 0 })
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-02-01T00:00:00Z', edit_seq: 5, deleted: 1 })
    const row = del(db)
    expect(row.deleted).toBe(1)
    expect(row.edit_seq).toBe(5)
  })

  it('flag=off → 无条件覆盖(逃生舱,云端 deleted=0 覆盖本地软删)', () => {
    const db = setupTestDb()
    db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.downlink_guard', 'off')`).run()
    const { from, to } = endpoints(db)
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', edit_seq: 1, deleted: 0 })
    db.prepare('UPDATE links SET deleted = 1, edit_seq = 2 WHERE id = ?').run('L')
    applyCloudLinkRow(db, { id: 'L', from_id: from, to_id: to, relation: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', edit_seq: 1, deleted: 0 })
    expect(del(db).deleted).toBe(0) // 逃生舱:无条件覆盖
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

describe('applyCloudNodeRow — M1 下行版本防护(字段分层)', () => {
  /** 造一个"本地有未上行编辑"的节点:updated 推到远未来。 */
  function seedLocalEdited(db: ReturnType<typeof setupTestDb>, content: string): string {
    const node = seedNode(db, { content })
    db.prepare('UPDATE nodes SET updated = ? WHERE id = ?').run('2099-01-01T00:00:00Z', node.id)
    return node.id
  }

  it('本地内容更新时,云端旧内容不覆盖 content,但派生字段仍取云端(止血 #4)', () => {
    const db = setupTestDb()
    const id = seedLocalEdited(db, 'local NEW edit')
    applyCloudNodeRow(db, {
      id, type: 'fact', content: 'STALE cloud content',
      heat: 0.9, created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z',
    })
    const row = db.prepare('SELECT content, heat FROM nodes WHERE id = ?').get(id) as { content: string; heat: number }
    expect(row.content).toBe('local NEW edit') // 内容类:保留本地
    expect(row.heat).toBe(0.9)                 // 派生类:取云端
  })

  it('情形 3 不修改本地 updated(reconcile 仍能判定本地较新并上行)', () => {
    const db = setupTestDb()
    const id = seedLocalEdited(db, 'local')
    applyCloudNodeRow(db, { id, content: 'stale', created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z' })
    const row = db.prepare('SELECT updated FROM nodes WHERE id = ?').get(id) as { updated: string }
    expect(row.updated).toBe('2099-01-01T00:00:00Z')
  })

  it('情形 3 保留本地三维(内容类,与 content 同源,不取云端)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'local' })
    db.prepare('UPDATE nodes SET updated = ?, specificity = 0.2 WHERE id = ?').run('2099-01-01T00:00:00Z', node.id)
    applyCloudNodeRow(db, {
      id: node.id, content: 'stale', specificity: 0.9,
      created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z',
    })
    const row = db.prepare('SELECT specificity FROM nodes WHERE id = ?').get(node.id) as { specificity: number }
    expect(row.specificity).toBe(0.2)
  })

  it('情形 3 全部派生字段同步云端', () => {
    const db = setupTestDb()
    const id = seedLocalEdited(db, 'local')
    applyCloudNodeRow(db, {
      id, content: 'stale', created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      heat: 0.7, refinement: 0.3, connectivity: 0.6, independence: 0.4, maturity_score: 0.55,
      is_crystal: true, is_keystone: true,
    })
    const row = db.prepare(
      'SELECT heat, refinement, connectivity, independence, maturity_score, is_crystal, is_keystone FROM nodes WHERE id = ?',
    ).get(id) as Record<string, number>
    expect(row.heat).toBe(0.7)
    expect(row.refinement).toBe(0.3)
    expect(row.connectivity).toBe(0.6)
    expect(row.independence).toBe(0.4)
    expect(row.maturity_score).toBe(0.55)
    expect(row.is_crystal).toBe(1)
    expect(row.is_keystone).toBe(1)
  })

  it('云端较新时整行覆盖内容(情形 2)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'local old' })
    db.prepare('UPDATE nodes SET updated = ? WHERE id = ?').run('2026-01-01T00:00:00Z', node.id)
    applyCloudNodeRow(db, { id: node.id, content: 'cloud newer', created: '2026-01-01T00:00:00Z', updated: '2099-01-01T00:00:00Z', edit_seq: 2 })
    const row = db.prepare('SELECT content FROM nodes WHERE id = ?').get(node.id) as { content: string }
    expect(row.content).toBe('cloud newer')
  })

  it('对抗态:本地 edit_seq 更高、云端 updated 更新但 edit_seq 不高 → 内容保留本地(M3 关死过时代谢)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'user edit' }) // createNode edit_seq=1
    // 用户再编辑一次 → edit_seq=2;updated 设为较早(模拟编辑发生在早些时候)
    db.prepare('UPDATE nodes SET edit_seq = 2, updated = ? WHERE id = ?').run('2026-01-01T00:00:00Z', node.id)
    // 云端代谢改写:updated 更新(2099)但 edit_seq 只到 1(代谢不 bump edit_seq)
    applyCloudNodeRow(db, {
      id: node.id, content: 'stale metabolism rewrite', heat: 0.9,
      created: '2026-01-01T00:00:00Z', updated: '2099-01-01T00:00:00Z', edit_seq: 1,
    })
    const row = db.prepare('SELECT content, heat FROM nodes WHERE id = ?').get(node.id) as { content: string; heat: number }
    expect(row.content).toBe('user edit') // edit_seq 2 > 1:内容保留本地,不被云端较新 updated 覆盖
    expect(row.heat).toBe(0.9)            // 派生字段仍取云端
  })

  it('云端归档 tombstone 优先(即使本地 updated 较新也接受归档)', () => {
    const db = setupTestDb()
    const id = seedLocalEdited(db, 'local active')
    applyCloudNodeRow(db, {
      id, content: 'archived on cloud', archived: true,
      created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z',
    })
    const row = db.prepare('SELECT archived FROM nodes WHERE id = ?').get(id) as { archived: number }
    expect(row.archived).toBe(1)
  })

  it('flag=off 时回退无条件覆盖(逃生舱)', () => {
    const db = setupTestDb()
    db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.downlink_guard', 'off')`).run()
    const id = seedLocalEdited(db, 'local NEW')
    applyCloudNodeRow(db, { id, content: 'stale cloud', created: '2026-01-01T00:00:00Z', updated: '2026-04-30T00:00:00Z' })
    const row = db.prepare('SELECT content FROM nodes WHERE id = ?').get(id) as { content: string }
    expect(row.content).toBe('stale cloud')
  })

  it('新节点(本地不存在)直接整行插入(情形 1)', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, { id: 'brand-new', content: 'fresh', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' })
    const row = db.prepare('SELECT content FROM nodes WHERE id = ?').get('brand-new') as { content: string }
    expect(row.content).toBe('fresh')
  })
})
