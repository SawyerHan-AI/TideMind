/**
 * 数据变更检测器
 *
 * 每 3 秒轮询 SQLite 关键表的最新状态,检测到变化时通过 IPC 推送
 * 'data-changed' 事件到渲染进程。覆盖所有写入源(MCP 独立进程 + Daemon 主进程)。
 *
 * 检测维度:
 *  - MAX(rowid):捕获 INSERT(新增)
 *  - MAX(updated):捕获 UPDATE(更新内容/heat/归档等)
 *  - COUNT(*):捕获 DELETE(软删除/硬删除)
 *
 * 老版本只看 MAX(rowid),node archive、supersede、refinement 调整、link 删除
 * 等都不触发 UI 刷新,用户必须手动切换页面才能看到最新状态。
 *
 * 修复 M28(2026-05-09):用独立的 readonly 连接轮询,避免与主进程写连接共享
 * busy_timeout 队列。WAL 模式下 readonly 不阻塞写,但若 daemon 正在写大事务,
 * 同一连接读仍可能被 busy_timeout 上限(10s)阻塞 UI。专用 readonly 连接绕过
 * 整个写锁链。
 */

import { BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { getActivityState } from './activity-state'
import { createLogger } from '@server/utils/logger.js'

const log = createLogger('data-watcher')

// perf-optimization-2026-05-17 P2-3:3s → 8s。
// 3s 在 daemon 跑大事务时即便 readonly 也要争 CPU;UI 数据变化的感知延迟
// 从 ~1.5s 变 ~4s,但仍快于人眼对"列表自动刷新"的关注阈值。代价是后台
// SQL 频率 ↓ ~60%。
const POLL_INTERVAL_MS = 8_000

interface TableState {
  maxRowid: number;
  maxUpdated: string;
  count: number;
}

let timer: ReturnType<typeof setInterval> | null = null
let watcherDb: Database.Database | null = null
let lastTimelineId = 0
let lastNodes: TableState = { maxRowid: 0, maxUpdated: '', count: 0 }
let lastLinks: TableState = { maxRowid: 0, maxUpdated: '', count: 0 }
let unsubscribeActivity: (() => void) | null = null

function snapshotTable(db: Database.Database, table: 'nodes' | 'links'): TableState {
  const r = db.prepare(
    `SELECT MAX(rowid) as rowid, COALESCE(MAX(updated), '') as updated, COUNT(*) as cnt FROM ${table}`,
  ).get() as { rowid: number | null; updated: string; cnt: number } | undefined
  return {
    maxRowid: r?.rowid ?? 0,
    maxUpdated: r?.updated ?? '',
    count: r?.cnt ?? 0,
  }
}

function tablesDiffer(a: TableState, b: TableState): boolean {
  return a.maxRowid !== b.maxRowid || a.maxUpdated !== b.maxUpdated || a.count !== b.count
}

/** 跑一次轮询并推送变更。pollDb 必须已初始化。 */
function pollOnce(pollDb: Database.Database): void {
  try {
    const curTimeline = (pollDb.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined)?.v ?? 0
    const curNodes = snapshotTable(pollDb, 'nodes')
    const curLinks = snapshotTable(pollDb, 'links')

    const nodesChanged = tablesDiffer(lastNodes, curNodes)
    const linksChanged = tablesDiffer(lastLinks, curLinks)
    const timelineChanged = curTimeline !== lastTimelineId

    if (!timelineChanged && !nodesChanged && !linksChanged) {
      return // 无变化
    }

    const scopes: string[] = []
    if (timelineChanged) scopes.push('timeline')
    if (nodesChanged) scopes.push('nodes')
    if (linksChanged) scopes.push('links')

    lastTimelineId = curTimeline
    lastNodes = curNodes
    lastLinks = curLinks

    // 推送到所有可见窗口
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isVisible()) {
        win.webContents.send('data-changed', { scopes })
      }
    }
  } catch {
    // DB 短暂锁定时静默忽略，下次重试
  }
}

function startInterval(pollDb: Database.Database): void {
  if (timer) return
  timer = setInterval(() => pollOnce(pollDb), POLL_INTERVAL_MS)
}

function stopInterval(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function startDataWatcher(db: Database.Database): void {
  if (watcherDb !== null || timer !== null) return // 已启动

  // 用独立 readonly 连接轮询(M28 修复):传入的 db 是写连接,共享同一连接
  // 池/锁队列;readonly 直接旁路写锁,WAL 模式下读永不阻塞写,反之亦然。
  // 失败时降级回原 db,保留原有行为。
  try {
    watcherDb = new Database(db.name, { readonly: true, fileMustExist: true })
  } catch {
    watcherDb = null
  }
  const pollDb = watcherDb ?? db

  // 初始化基线值
  const initTimeline = pollDb.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined
  lastTimelineId = initTimeline?.v ?? 0
  lastNodes = snapshotTable(pollDb, 'nodes')
  lastLinks = snapshotTable(pollDb, 'links')

  // 跟随 activity-state:idle 时停 setInterval(SQL 没意义且会和 sync-client 抢 CPU),
  // active 时立即跑一次让用户尽快看到积累的变化 + restart interval。
  const activity = getActivityState()
  if (activity.getState() === 'active') {
    startInterval(pollDb)
  }
  unsubscribeActivity = activity.onChange((state) => {
    if (state === 'idle') {
      stopInterval()
    } else {
      pollOnce(pollDb) // 立即一次,把 idle 期间积累的变更推给 renderer
      startInterval(pollDb)
    }
  })
}

export function stopDataWatcher(): void {
  if (unsubscribeActivity) {
    unsubscribeActivity()
    unsubscribeActivity = null
  }
  stopInterval()
  if (watcherDb) {
    // close 抛错通常意味着有未释放的 prepared statement(罕见但值得留痕迹,
    // 比静默吞掉更有助于排查"为什么 db 行为怪")。仍继续置 null:错误不可恢复,
    // 但下次 start 时会重开新连接。
    try { watcherDb.close() } catch (err) {
      log.warn(`watcherDb close failed: ${(err as Error).message}`)
    }
    watcherDb = null
  }
}
