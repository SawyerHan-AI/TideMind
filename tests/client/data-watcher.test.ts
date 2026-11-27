/**
 * data-watcher 轮询:哪些表的变化会推送 data-changed,以及归入哪个范围。
 *
 * 这里走的是 watcher 的降级路径:内存库不能以只读方式再打开一次,better-sqlite3
 * 在加载原生模块之前就抛 TypeError,watcher 回落到传入的连接。所以 client/
 * 下为 Electron ABI 编译的 better-sqlite3 不会被加载,不需要像其它 client 测试
 * 那样把它 mock 到根目录的副本。生产用的独立只读连接不在本测试覆盖范围内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { setupTestDb, seedNode } from '../helpers/test-db.js'
import { logOperation, logTimelineEvent } from '../../src/db/log.js'

const { electronMock, sent } = vi.hoisted(() => {
  const sent: Array<{ channel: string; payload: { scopes: string[] } }> = []
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { send: (channel: string, payload: { scopes: string[] }) => { sent.push({ channel, payload }) } },
  }
  return { sent, electronMock: { BrowserWindow: { getAllWindows: () => [win] } } }
})
vi.mock('electron', () => electronMock)
vi.mock('../../client/node_modules/electron/index.js', () => electronMock)

const { startDataWatcher, stopDataWatcher } = await import('../../client/electron/data-watcher.js')
const { getActivityState } = await import('../../client/electron/activity-state.js')

const POLL_MS = 8_000

describe('data-watcher', { timeout: 30_000 }, () => {
  let db: Database.Database

  beforeEach(() => {
    vi.useFakeTimers()
    getActivityState().__resetForTests()
    sent.length = 0
    db = setupTestDb()
    seedNode(db, { content: '星海科技季度复盘' })
    logTimelineEvent(db, { type: 'digest', subtype: 'created', title: '初始事件' })
    logOperation(db, { operation: 'digest', input_summary: '初始操作' })
    startDataWatcher(db)
  })

  afterEach(() => {
    stopDataWatcher()
    getActivityState().__resetForTests()
    vi.useRealTimers()
    db.close()
  })

  it('没有任何变化时不推送', () => {
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(sent).toEqual([])
  })

  it('只有 operation_log 新增一行时,按 timeline 范围推送', () => {
    logOperation(db, { operation: 'prepare', input_summary: 'DataPilot 会话开始' })
    vi.advanceTimersByTime(POLL_MS)
    expect(sent).toEqual([{ channel: 'data-changed', payload: { scopes: ['timeline'] } }])

    vi.advanceTimersByTime(POLL_MS)
    expect(sent).toHaveLength(1)
  })

  it('timeline_events 与 operation_log 同时变化时 timeline 只出现一次', () => {
    logTimelineEvent(db, { type: 'digest', subtype: 'created', title: '新事件' })
    logOperation(db, { operation: 'recall', input_summary: '没有结果的检索' })
    vi.advanceTimersByTime(POLL_MS)
    expect(sent).toEqual([{ channel: 'data-changed', payload: { scopes: ['timeline'] } }])
  })

  it('nodes 变化仍按 nodes 范围推送', () => {
    seedNode(db, { content: 'DataPilot 上线计划' })
    vi.advanceTimersByTime(POLL_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.scopes).toContain('nodes')
    expect(sent[0].payload.scopes).not.toContain('timeline')
  })
})
