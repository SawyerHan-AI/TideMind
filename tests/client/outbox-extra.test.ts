/**
 * tests/client/outbox-extra.test.ts
 *
 * 补充 client/electron/cloud/outbox.ts 的覆盖:
 *   - enqueueOutbox 唯一性 + JSON 序列化 round-trip
 *   - markOutboxFailed UPDATE last_error/retry_count 路径(未到 dead-letter)
 *   - getOutboxDiagnostics 空库 / 缺 dead 表 / pendingByOperation 排序 / LIMIT 8
 *   - getDeadLetterCount 在 dead 表不存在时 return 0
 *   - createOutboxTable 在 dead 表已存在时仍幂等
 *
 * 不重复 tests/cloud/outbox.test.ts 和 tests/client/outbox-dead-letter.test.ts 已有的 case。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createOutboxTable,
  enqueueOutbox,
  getOutboxItems,
  getOutboxCount,
  getDeadLetterCount,
  getOutboxDiagnostics,
  markOutboxFailed,
  OUTBOX_MAX_RETRIES,
} from '../../client/electron/cloud/outbox.js'

describe('enqueueOutbox — id uniqueness + JSON round-trip', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createOutboxTable(db)
  })

  it('生成的 id 在多次 enqueue 间不重复', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      ids.add(enqueueOutbox(db, 'op', { i }))
    }
    expect(ids.size).toBe(50)
  })

  it('payload JSON round-trip 保留嵌套对象/数组结构', () => {
    const nested = {
      id: 'n1',
      tags: ['a', 'b'],
      nested: { x: 1, y: [true, false] },
      relation: [{ type: 'supports', confidence: 0.7 }],
    }
    enqueueOutbox(db, 'node_create', nested)
    const [item] = getOutboxItems(db, 10)
    expect(JSON.parse(item.payload)).toEqual(nested)
  })

  it('空 payload {} 也能正确存储与还原', () => {
    enqueueOutbox(db, 'empty', {})
    const [item] = getOutboxItems(db, 10)
    expect(JSON.parse(item.payload)).toEqual({})
  })

  it('payload 含 unicode / 中文 / emoji 不损坏', () => {
    const payload = { content: '中文测试 🌊 emoji', extras: ['café'] }
    enqueueOutbox(db, 'unicode', payload)
    const [item] = getOutboxItems(db, 10)
    expect(JSON.parse(item.payload)).toEqual(payload)
  })

  it('返回的 id 与 SELECT 出来的 id 完全一致', () => {
    const id = enqueueOutbox(db, 'op', { x: 1 })
    const row = db.prepare('SELECT id FROM local_outbox WHERE id = ?').get(id) as { id: string }
    expect(row.id).toBe(id)
  })

  it('multiple operations differ in operation field', () => {
    enqueueOutbox(db, 'node_create', {})
    enqueueOutbox(db, 'node_update', {})
    enqueueOutbox(db, 'link_delete', {})
    const items = getOutboxItems(db)
    const ops = items.map(i => i.operation).sort()
    expect(ops).toEqual(['link_delete', 'node_create', 'node_update'])
  })
})

describe('markOutboxFailed — non-dead-letter UPDATE path', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createOutboxTable(db)
  })

  it('first failure: retry_count=1, last_error 持久化', () => {
    const id = enqueueOutbox(db, 'op', {})
    const r = markOutboxFailed(db, id, 'transient HTTP 503')
    expect(r.deadLettered).toBe(false)
    const [item] = getOutboxItems(db, 1)
    expect(item.retry_count).toBe(1)
    expect(item.last_error).toBe('transient HTTP 503')
  })

  it('second failure overwrites last_error, retry_count 单调递增', () => {
    const id = enqueueOutbox(db, 'op', {})
    markOutboxFailed(db, id, 'err 1')
    markOutboxFailed(db, id, 'err 2')
    const [item] = getOutboxItems(db, 1)
    expect(item.retry_count).toBe(2)
    expect(item.last_error).toBe('err 2')
  })

  it('failure 不影响其他 item', () => {
    const id1 = enqueueOutbox(db, 'op', { n: 1 })
    const id2 = enqueueOutbox(db, 'op', { n: 2 })
    markOutboxFailed(db, id1, 'only 1 failed')
    const item2 = db.prepare('SELECT retry_count, last_error FROM local_outbox WHERE id = ?').get(id2) as {
      retry_count: number
      last_error: string | null
    }
    expect(item2.retry_count).toBe(0)
    expect(item2.last_error).toBeNull()
  })

  it('error 长度恰好 500 字符不截断', () => {
    const id = enqueueOutbox(db, 'op', {})
    const exact500 = 'x'.repeat(500)
    markOutboxFailed(db, id, exact500)
    const [item] = getOutboxItems(db, 1)
    expect(item.last_error).toHaveLength(500)
    expect(item.last_error).toBe(exact500)
  })

  it('error 长度 501 字符截到 500', () => {
    const id = enqueueOutbox(db, 'op', {})
    markOutboxFailed(db, id, 'x'.repeat(501))
    const [item] = getOutboxItems(db, 1)
    expect(item.last_error).toHaveLength(500)
  })

  it('返回 { deadLettered: false } 直到达到阈值', () => {
    const id = enqueueOutbox(db, 'op', {})
    for (let i = 0; i < OUTBOX_MAX_RETRIES - 1; i++) {
      expect(markOutboxFailed(db, id, `attempt ${i}`).deadLettered).toBe(false)
    }
  })
})

describe('createOutboxTable — idempotence + migration', () => {
  it('已建表后再次调用不报错', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    createOutboxTable(db)
    createOutboxTable(db)
    // verify tables still queryable
    expect(() => db.prepare('SELECT COUNT(*) FROM local_outbox').get()).not.toThrow()
    expect(() => db.prepare('SELECT COUNT(*) FROM local_outbox_dead').get()).not.toThrow()
  })

  it('已有 last_error 列时 ALTER TABLE 失败被吞掉(race condition 兜底)', () => {
    const db = new Database(':memory:')
    createOutboxTable(db) // 已经有 last_error
    // 再调一次 ALTER 必然失败,但 createOutboxTable 内部有 try/catch
    expect(() => createOutboxTable(db)).not.toThrow()
  })

  it('已存在 local_outbox_dead 表时不冲突', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    // 表已存在 → 再 createOutboxTable 不报错
    expect(() => createOutboxTable(db)).not.toThrow()
  })

  it('从空库到完整表只需一次 createOutboxTable', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_outbox', 'local_outbox_dead')`)
      .all() as Array<{ name: string }>
    expect(tables.map(t => t.name).sort()).toEqual(['local_outbox', 'local_outbox_dead'])
  })
})

describe('getDeadLetterCount — dead 表不存在容错', () => {
  it('dead 表存在但为空时返回 0', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    expect(getDeadLetterCount(db)).toBe(0)
  })

  it('dead 表 DROP 掉后返回 0(不抛)', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    db.exec('DROP TABLE local_outbox_dead')
    expect(getDeadLetterCount(db)).toBe(0)
  })

  it('插入若干 dead 记录后返回正确 count', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    for (let i = 0; i < 3; i++) {
      const id = enqueueOutbox(db, 'op', { i })
      for (let j = 0; j < OUTBOX_MAX_RETRIES; j++) {
        markOutboxFailed(db, id, `${i}-${j}`)
      }
    }
    expect(getDeadLetterCount(db)).toBe(3)
    expect(getOutboxCount(db)).toBe(0) // 全搬到 dead
  })
})

describe('getOutboxDiagnostics — 字段完整性 + 边界', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createOutboxTable(db)
  })

  it('空库:所有 count = 0, all timestamps null', () => {
    const d = getOutboxDiagnostics(db)
    expect(d.pendingCount).toBe(0)
    expect(d.deadLetterCount).toBe(0)
    expect(d.oldestPendingAt).toBeNull()
    expect(d.newestPendingAt).toBeNull()
    expect(d.maxRetryCount).toBe(0)
    expect(d.lastPendingError).toBeNull()
    expect(d.lastDeadLetterError).toBeNull()
    expect(d.lastDeadLetterAt).toBeNull()
    expect(d.pendingByOperation).toEqual([])
    expect(d.deadLetterByOperation).toEqual([])
  })

  it('包含未失败 item 时 lastPendingError = null', () => {
    enqueueOutbox(db, 'op', {})
    const d = getOutboxDiagnostics(db)
    expect(d.pendingCount).toBe(1)
    expect(d.lastPendingError).toBeNull()
  })

  it('lastPendingError 只取最近 created 那条非空错误', () => {
    const a = enqueueOutbox(db, 'op', {})
    // 让 b 的 created 晚于 a
    db.prepare(`UPDATE local_outbox SET created = '2026-01-01T00:00:00Z' WHERE id = ?`).run(a)
    const b = enqueueOutbox(db, 'op', {})
    db.prepare(`UPDATE local_outbox SET created = '2026-02-01T00:00:00Z' WHERE id = ?`).run(b)
    markOutboxFailed(db, a, 'older fail')
    markOutboxFailed(db, b, 'newer fail')
    const d = getOutboxDiagnostics(db)
    expect(d.lastPendingError).toBe('newer fail')
  })

  it('lastDeadLetterError 只取最近 failed_at 那条', () => {
    const a = enqueueOutbox(db, 'op', {})
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, a, 'first poison')
    // 手动调 failed_at 防 same-second 撞车
    db.prepare(`UPDATE local_outbox_dead SET failed_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(a)

    const b = enqueueOutbox(db, 'op', {})
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, b, 'second poison')
    db.prepare(`UPDATE local_outbox_dead SET failed_at = '2026-02-01T00:00:00Z' WHERE id = ?`).run(b)

    const d = getOutboxDiagnostics(db)
    expect(d.lastDeadLetterError).toBe('second poison')
  })

  it('maxRetryCount 是 pending 中最大重试次数', () => {
    const a = enqueueOutbox(db, 'op', {})
    const b = enqueueOutbox(db, 'op', {})
    markOutboxFailed(db, a, 'a fail 1')
    markOutboxFailed(db, a, 'a fail 2')
    markOutboxFailed(db, b, 'b fail 1')
    const d = getOutboxDiagnostics(db)
    expect(d.maxRetryCount).toBe(2)
  })

  it('pendingByOperation 按 count DESC 排序', () => {
    enqueueOutbox(db, 'op_a', {})
    enqueueOutbox(db, 'op_a', {})
    enqueueOutbox(db, 'op_a', {})
    enqueueOutbox(db, 'op_b', {})
    enqueueOutbox(db, 'op_c', {})
    enqueueOutbox(db, 'op_c', {})
    const d = getOutboxDiagnostics(db)
    expect(d.pendingByOperation[0]).toEqual({ operation: 'op_a', count: 3 })
    expect(d.pendingByOperation[1]).toEqual({ operation: 'op_c', count: 2 })
    expect(d.pendingByOperation[2]).toEqual({ operation: 'op_b', count: 1 })
  })

  it('pendingByOperation 同 count 按 operation ASC 排', () => {
    enqueueOutbox(db, 'beta', {})
    enqueueOutbox(db, 'alpha', {})
    enqueueOutbox(db, 'gamma', {})
    const d = getOutboxDiagnostics(db)
    expect(d.pendingByOperation.map(x => x.operation)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('pendingByOperation 截断到 LIMIT 8', () => {
    for (let i = 0; i < 10; i++) {
      enqueueOutbox(db, `op_${String.fromCharCode(97 + i)}`, {})
    }
    const d = getOutboxDiagnostics(db)
    expect(d.pendingByOperation).toHaveLength(8)
  })

  it('deadLetterByOperation 反映 dead 表的分布', () => {
    const a = enqueueOutbox(db, 'kind_x', {})
    const b = enqueueOutbox(db, 'kind_y', {})
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, a, 'a poison')
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, b, 'b poison')
    const d = getOutboxDiagnostics(db)
    expect(d.deadLetterByOperation.length).toBe(2)
    const ops = d.deadLetterByOperation.map(x => x.operation).sort()
    expect(ops).toEqual(['kind_x', 'kind_y'])
  })

  it('oldestPendingAt < newestPendingAt 时序正确', () => {
    const a = enqueueOutbox(db, 'op', {})
    db.prepare(`UPDATE local_outbox SET created = '2026-01-01T00:00:00Z' WHERE id = ?`).run(a)
    const b = enqueueOutbox(db, 'op', {})
    db.prepare(`UPDATE local_outbox SET created = '2026-03-01T00:00:00Z' WHERE id = ?`).run(b)
    const d = getOutboxDiagnostics(db)
    expect(d.oldestPendingAt).toBe('2026-01-01T00:00:00Z')
    expect(d.newestPendingAt).toBe('2026-03-01T00:00:00Z')
  })

  it('lastDeadLetterAt 反映最近的 failed_at(数据库时间格式)', () => {
    const a = enqueueOutbox(db, 'op', {})
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, a, 'poison')
    const d = getOutboxDiagnostics(db)
    expect(d.lastDeadLetterAt).toBeTruthy()
    expect(d.lastDeadLetterAt).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('诊断包含 dead-letter 和 pending 数 sum 的正确分布', () => {
    // 1 pending,1 dead-letter
    const a = enqueueOutbox(db, 'op_p', {})
    const b = enqueueOutbox(db, 'op_d', {})
    markOutboxFailed(db, a, 'pending fail') // a 还在 local_outbox
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++) markOutboxFailed(db, b, 'dead poison')
    const d = getOutboxDiagnostics(db)
    expect(d.pendingCount).toBe(1)
    expect(d.deadLetterCount).toBe(1)
  })

  it('在 dead 表不存在时调用 getOutboxDiagnostics 会先 createOutboxTable 兜底', () => {
    // 模拟"老库,只有 outbox 表,没有 dead 表"
    const fresh = new Database(':memory:')
    fresh.exec(`CREATE TABLE local_outbox (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT,
      created TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT
    )`)
    expect(() => getOutboxDiagnostics(fresh)).not.toThrow()
    const d = getOutboxDiagnostics(fresh)
    expect(d.deadLetterCount).toBe(0)
  })
})

describe('outbox lifecycle — 综合场景', () => {
  it('enqueue → mark-failed → recover (remove) 流程', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    const id = enqueueOutbox(db, 'recovery_test', { payload: true })
    markOutboxFailed(db, id, 'transient error')
    // 第二次尝试假装成功:从队列移除
    db.prepare('DELETE FROM local_outbox WHERE id = ?').run(id)
    expect(getOutboxCount(db)).toBe(0)
    expect(getDeadLetterCount(db)).toBe(0)
  })

  it('多个 source 标签隔离', () => {
    const db = new Database(':memory:')
    createOutboxTable(db)
    enqueueOutbox(db, 'op', { x: 1 }, 'mcp')
    enqueueOutbox(db, 'op', { x: 2 }, 'ui')
    enqueueOutbox(db, 'op', { x: 3 }, 'mcp')
    const items = getOutboxItems(db, 100)
    const mcp = items.filter(i => i.source === 'mcp')
    const ui = items.filter(i => i.source === 'ui')
    expect(mcp.length).toBe(2)
    expect(ui.length).toBe(1)
  })
})
