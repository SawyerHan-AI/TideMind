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

  it('treats string tombstones as archived and cleans local vector rows', () => {
    const db = setupTestDb()
    createFallbackVecTable(db)
    const node = seedNode(db, { content: 'string archived node' })
    db.prepare(
      'INSERT INTO node_segments (segment_id, node_id, segment_index) VALUES (?, ?, ?)',
    ).run(`${node.id}#0`, node.id, 0)
    db.prepare('INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)').run(`${node.id}#0`, Buffer.from([1]))

    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: node.content,
      archived: 'true',
      created: node.created,
      updated: '2026-04-30T00:00:00Z',
    })

    const row = db.prepare('SELECT archived FROM nodes WHERE id = ?').get(node.id) as { archived: number }
    const vecs = db.prepare('SELECT COUNT(*) AS cnt FROM nodes_vec WHERE id = ?').get(`${node.id}#0`) as { cnt: number }
    expect(row.archived).toBe(1)
    expect(vecs.cnt).toBe(0)
  })

  // supersede-heat-cloud-roundtrip(2026-06-18)纵深防御:下行收到 superseded 行时,无论服务端
  // 发来多高的 heat/connectivity/maturity,本地都强制落地板(防旧版本在图谱里复活)。
  it('下行 superseded 新节点:heat/connectivity/maturity 强制落地板(整行写)', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'sup-new',
      type: 'fact',
      content: '退休旧版本',
      is_superseded: true,
      heat: 0.9,
      connectivity: 5,
      maturity_score: 0.8,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-05-20T16:38:00Z',
    })
    const row = db.prepare(
      'SELECT heat, connectivity, maturity_score, is_superseded FROM nodes WHERE id = ?',
    ).get('sup-new') as { heat: number; connectivity: number; maturity_score: number; is_superseded: number }
    expect(row.is_superseded).toBe(1)
    expect(row.heat).toBeCloseTo(0.01)
    expect(row.connectivity).toBe(0)
    expect(row.maturity_score).toBe(0)
  })

  it('下行 active 节点:派生字段不被 clamp(保持云端代谢权威)', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'active-new',
      type: 'fact',
      content: '活跃节点',
      is_superseded: false,
      heat: 0.9,
      connectivity: 5,
      maturity_score: 0.8,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-05-20T16:38:00Z',
    })
    const row = db.prepare(
      'SELECT heat, connectivity, maturity_score, is_superseded FROM nodes WHERE id = ?',
    ).get('active-new') as { heat: number; connectivity: number; maturity_score: number; is_superseded: number }
    expect(row.is_superseded).toBe(0)
    expect(row.heat).toBeCloseTo(0.9)
    expect(row.connectivity).toBeCloseTo(5)
    expect(row.maturity_score).toBeCloseTo(0.8)
  })

  it('下行 superseded + 本地内容更新(情形3 仅派生字段):内容保留本地,但三字段落地板', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: '本地较新内容', heat: 1 })
    // 本地 edit_seq 更高 → contentTakesCloud=false → 走情形3(仅同步派生字段,保留本地内容)
    db.prepare("UPDATE nodes SET edit_seq = 5, updated = '2026-06-18T00:00:00Z' WHERE id = ?").run(node.id)

    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: '云端旧内容(不应覆盖本地)',
      is_superseded: true,
      heat: 0.9,
      connectivity: 5,
      maturity_score: 0.8,
      edit_seq: 1,
      created: node.created,
      updated: '2026-05-20T16:38:00Z',
    })

    const row = db.prepare(
      'SELECT content, heat, connectivity, maturity_score, is_superseded FROM nodes WHERE id = ?',
    ).get(node.id) as { content: string; heat: number; connectivity: number; maturity_score: number; is_superseded: number }
    expect(row.content).toBe('本地较新内容')  // 内容保留本地(情形3)
    expect(row.is_superseded).toBe(1)          // 派生字段(含 is_superseded)取云端
    expect(row.heat).toBeCloseTo(0.01)          // 但强制 clamp 到地板
    expect(row.connectivity).toBe(0)
    expect(row.maturity_score).toBe(0)
  })

  // CRITICAL C1(2026-06-18 审计):情形3 的 is_superseded 单调粘滞。本地刚 supersede(=1, edit_seq 高)、
  // 其 uplink 尚未落地时,一个滞后的云端 active 行(is_superseded=0, 高热, edit_seq 低)下行 →
  // contentTakesCloud=false → 情形3。绝不能用云端 0 把本地刚退休节点翻回 active+高热(会经下次
  // uplink 实时行把污染推回服务端、永不自愈)。断言:本地保持 is_superseded=1 且三字段地板。
  it('C1: 情形3 不让云端滞后 is_superseded=0 把本地刚退休节点翻回 active', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: '刚退休的旧版本', heat: 1 })
    // 模拟本地刚 supersede:is_superseded=1 + 派生字段地板 + edit_seq 高 + updated 新
    db.prepare(
      "UPDATE nodes SET is_superseded = 1, heat = 0.01, connectivity = 0, maturity_score = 0, edit_seq = 5, updated = '2026-06-18T10:00:00Z' WHERE id = ?",
    ).run(node.id)

    // 滞后下行:云端那份仍是 active(supersede 尚未上行),edit_seq 更低 → contentTakesCloud=false → 情形3
    applyCloudNodeRow(db, {
      id: node.id,
      type: 'fact',
      content: '云端旧 active 内容',
      is_superseded: false,
      heat: 0.9,
      connectivity: 5,
      maturity_score: 0.8,
      edit_seq: 1,
      created: node.created,
      updated: '2026-05-20T16:38:00Z',
    })

    const row = db.prepare(
      'SELECT is_superseded, heat, connectivity, maturity_score FROM nodes WHERE id = ?',
    ).get(node.id) as { is_superseded: number; heat: number; connectivity: number; maturity_score: number }
    expect(row.is_superseded).toBe(1)        // 单调:本地已退休不被云端滞后 active 翻回
    expect(row.heat).toBeCloseTo(0.01)        // 仍地板,不取云端高值
    expect(row.connectivity).toBe(0)
    expect(row.maturity_score).toBe(0)
  })

  // guard-off 逃生舱既定行为(M1/L2,2026-06-18 审计):downlink_guard='off' 时走 insertFullNodeRow
  // 无条件整行覆盖,放弃所有下行防护(含 supersede 单调)。这是逃生舱预期语义、非 bug。本用例固化它,
  // 防将来误判为 bug 或被无意"修复"成单调(若要改需重新评估逃生舱整体语义,见 backlog guard-off 条目)。
  it('guard-off 逃生舱:放弃 supersede 单调(既定行为,非 bug)', () => {
    const db = setupTestDb()
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('cloud.downlink_guard', 'off')").run()
    const node = seedNode(db, { content: '本地退休', heat: 0.01 })
    db.prepare('UPDATE nodes SET is_superseded = 1, edit_seq = 9 WHERE id = ?').run(node.id)

    // guard off → 走情形1 insertFullNodeRow 整行覆盖(不比 edit_seq、不做 OR 单调)
    applyCloudNodeRow(db, {
      id: node.id, type: 'fact', content: '云端 active', is_superseded: false,
      heat: 0.9, connectivity: 5, maturity_score: 0.8, edit_seq: 1,
      created: node.created, updated: '2026-05-20T16:38:00Z',
    })

    const row = db.prepare('SELECT is_superseded, heat FROM nodes WHERE id = ?')
      .get(node.id) as { is_superseded: number; heat: number }
    expect(row.is_superseded).toBe(0)   // 逃生舱:取云端值(翻回),既定语义
    expect(row.heat).toBeCloseTo(0.9)   // 云端非 superseded → 不 clamp,取云端高值
  })

  // HIGH-B 修复(2026-06-18 三轮审计):情形2(contentTakesCloud=true,整行写)做 is_superseded OR 合并。
  // 多设备并发:另一端 active 编辑 edit_seq 更高 → 走情形2;不能把本地刚退休节点翻回 active+高热。
  it('HIGH-B: 情形2 多设备并发,云端 active 高 edit_seq 不翻回本地刚退休节点', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: '本地退休', heat: 0.01 })
    // 本地刚 supersede:is_superseded=1 + 地板 + edit_seq=5
    db.prepare("UPDATE nodes SET is_superseded=1, heat=0.01, connectivity=0, maturity_score=0, edit_seq=5, updated='2026-06-18T10:00:00Z' WHERE id=?").run(node.id)

    // 另一端 active 编辑,edit_seq=6 更高 → contentTakesCloud=true → 情形2 整行写
    applyCloudNodeRow(db, {
      id: node.id, type: 'fact', content: '另一端 active 编辑', is_superseded: false,
      heat: 0.9, connectivity: 5, maturity_score: 0.8, edit_seq: 6,
      created: node.created, updated: '2026-06-18T11:00:00Z',
    })

    const row = db.prepare('SELECT is_superseded, heat, connectivity, content FROM nodes WHERE id=?')
      .get(node.id) as { is_superseded: number; heat: number; connectivity: number; content: string }
    expect(row.is_superseded).toBe(1)            // 单调:不被翻回 active
    expect(row.heat).toBeCloseTo(0.01)            // sup=本地||云端=true → 落地板
    expect(row.connectivity).toBe(0)
    expect(row.content).toBe('另一端 active 编辑') // 内容仍取云端(情形2 整行写),但退休态保持
  })

  // F1 修复(2026-06-24 logseq-orphan):情形1 的 cloudArchived 子分支也做 is_superseded OR 单调。
  // 这是 supersede-heat 审计标 LOW-3 未修的洞,实测云端往返复活了 ~3000 个退休孤儿。
  it('F1: 情形1 cloudArchived 下本地 superseded 不被云端陈旧 active 翻回(OR 单调)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: '本地退休', heat: 0.01 })
    db.prepare("UPDATE nodes SET is_superseded=1, heat=0.01, connectivity=0, maturity_score=0 WHERE id=?").run(node.id)
    // 云端归档 tombstone(走情形1),但携带陈旧 is_superseded=0 + 高热
    applyCloudNodeRow(db, {
      id: node.id, type: 'fact', content: '云端归档旧内容', archived: true, is_superseded: false,
      heat: 0.9, connectivity: 5, maturity_score: 0.8, created: node.created, updated: '2026-05-20T16:38:00Z',
    })
    const row = db.prepare('SELECT is_superseded, archived, heat, connectivity FROM nodes WHERE id=?')
      .get(node.id) as { is_superseded: number; archived: number; heat: number; connectivity: number }
    expect(row.is_superseded).toBe(1)   // F1: OR 单调,不被陈旧云端 active 翻回
    expect(row.archived).toBe(1)         // 归档优先(tombstone)
    expect(row.heat).toBeCloseTo(0.01)   // sup → 地板,不取云端高值
    expect(row.connectivity).toBe(0)
  })

  it('F1: 情形1 新节点(本地不存在)正常整行写入,不受 OR 影响', () => {
    const db = setupTestDb()
    applyCloudNodeRow(db, {
      id: 'f1-new', type: 'fact', content: '云端新 active 节点', is_superseded: false,
      heat: 0.7, created: '2026-01-01T00:00:00Z', updated: '2026-05-20T16:38:00Z',
    })
    const row = db.prepare('SELECT is_superseded, heat FROM nodes WHERE id=?')
      .get('f1-new') as { is_superseded: number; heat: number }
    expect(row.is_superseded).toBe(0)   // 新节点无本地退休态,localSuperseded=false
    expect(row.heat).toBeCloseTo(0.7)    // active 不 clamp
  })
})
