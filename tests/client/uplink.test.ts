/**
 * 实时上行(M6)测试:脏集触发器 + 回声抑制 guard + claimDirty 取删原子 + pumpUplink。
 */

import { describe, expect, it, vi } from 'vitest'
import { setupTestDb, seedNode } from '../helpers/test-db.js'
import { withApplyGuard } from '../../client/electron/cloud/local-apply.js'

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudBaseUrl: () => 'https://cloud.test',
  refreshTokenIfNeeded: vi.fn(async () => 'token'),
}))

import { claimDirty, pumpUplink } from '../../client/electron/cloud/uplink.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dirtyIds(db: any, table: 'nodes' | 'links'): string[] {
  return (db.prepare('SELECT id FROM cloud_dirty WHERE tbl = ? ORDER BY id').all(table) as Array<{ id: string }>).map((r) => r.id)
}

describe('M6 脏集触发器 + 回声抑制 guard', () => {
  it('本地新建 nodes → 记入 cloud_dirty', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'local write' })
    expect(dirtyIds(db, 'nodes')).toContain(node.id)
  })

  it('UPDATE nodes 也记脏集', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    db.prepare('DELETE FROM cloud_dirty').run()
    db.prepare('UPDATE nodes SET content = ? WHERE id = ?').run('updated', node.id)
    expect(dirtyIds(db, 'nodes')).toContain(node.id)
  })

  it('withApplyGuard 内的写不记脏集(回声抑制)', () => {
    const db = setupTestDb()
    let id = ''
    withApplyGuard(db, () => {
      id = seedNode(db, { content: 'downlink apply' }).id
    })
    expect(dirtyIds(db, 'nodes')).not.toContain(id)
  })

  it('links 写也记脏集', () => {
    const db = setupTestDb()
    const a = seedNode(db, { content: 'A' })
    const b = seedNode(db, { content: 'B' })
    db.prepare('DELETE FROM cloud_dirty').run()
    db.prepare("INSERT INTO links (id, from_id, to_id, relation, created) VALUES ('l1', ?, ?, '[]', '2026-01-01')").run(a.id, b.id)
    expect(dirtyIds(db, 'links')).toContain('l1')
  })
})

describe('M6 claimDirty 取删原子', () => {
  it('取出脏集后从表删除,再取为空', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    expect(claimDirty(db, 'nodes', 50)).toContain(node.id)
    expect(dirtyIds(db, 'nodes')).not.toContain(node.id)
    expect(claimDirty(db, 'nodes', 50)).toEqual([])
  })

  it('claim 后再改同 id → 触发器重新入脏集(TOCTOU 不丢)', () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'v1' })
    claimDirty(db, 'nodes', 50) // 取删(模拟上行中)
    expect(dirtyIds(db, 'nodes')).not.toContain(node.id)
    db.prepare('UPDATE nodes SET content = ? WHERE id = ?').run('v2', node.id) // 期间用户再改
    expect(dirtyIds(db, 'nodes')).toContain(node.id) // 重新入脏集,下次 pump 上行 v2
  })
})

describe('M6 pumpUplink', () => {
  it('上行成功 → 删脏集', async () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => ({ processed: 1 }), text: async () => '' } as any)
    await pumpUplink(db)
    expect(fetchSpy).toHaveBeenCalled()
    expect(dirtyIds(db, 'nodes')).not.toContain(node.id)
    fetchSpy.mockRestore()
  })

  it('上行失败(500) → 脏集保留(下次重试)', async () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: false, status: 500, text: async () => 'err' } as any)
    await pumpUplink(db)
    expect(dirtyIds(db, 'nodes')).toContain(node.id)
    fetchSpy.mockRestore()
  })
})

describe('M7 uplink 配额耗尽处理', () => {
  it('server 返回 quota_exhausted skip(200) → 脏集不 requeue、写 metadata 时间戳', async () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ processed: 0, skipped: [{ id: node.id, reason: 'quota_exhausted' }] }),
      text: async () => '',
    } as any)
    await pumpUplink(db)
    // claim 已删脏集,quota_exhausted 不 requeue(避免 3s 死循环),靠 reconcile 兜底
    expect(dirtyIds(db, 'nodes')).toEqual([])
    // metadata 时间戳已写(供 UI 提示用户升级)
    const ts = db.prepare("SELECT value FROM metadata WHERE key = 'cloud.quota_exhausted_at'").get() as { value?: string } | undefined
    expect(ts?.value).toBeTruthy()
    fetchSpy.mockRestore()
  })

  it('非配额 skip(server_newer)→ 不 requeue 也不写 quota metadata', async () => {
    const db = setupTestDb()
    const node = seedNode(db, { content: 'x' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ processed: 0, skipped: [{ id: node.id, reason: 'server_newer' }] }),
      text: async () => '',
    } as any)
    await pumpUplink(db)
    expect(dirtyIds(db, 'nodes')).toEqual([])
    const ts = db.prepare("SELECT value FROM metadata WHERE key = 'cloud.quota_exhausted_at'").get() as { value?: string } | undefined
    expect(ts).toBeUndefined() // 未写 quota 标记
    fetchSpy.mockRestore()
  })
})
