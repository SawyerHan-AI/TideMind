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
 */

import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'

const POLL_INTERVAL_MS = 3_000

interface TableState {
  maxRowid: number;
  maxUpdated: string;
  count: number;
}

let timer: ReturnType<typeof setInterval> | null = null
let lastTimelineId = 0
let lastNodes: TableState = { maxRowid: 0, maxUpdated: '', count: 0 }
let lastLinks: TableState = { maxRowid: 0, maxUpdated: '', count: 0 }

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

export function startDataWatcher(db: Database.Database): void {
  if (timer) return

  // 初始化基线值
  const initTimeline = db.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined
  lastTimelineId = initTimeline?.v ?? 0
  lastNodes = snapshotTable(db, 'nodes')
  lastLinks = snapshotTable(db, 'links')

  timer = setInterval(() => {
    try {
      const curTimeline = (db.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined)?.v ?? 0
      const curNodes = snapshotTable(db, 'nodes')
      const curLinks = snapshotTable(db, 'links')

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
  }, POLL_INTERVAL_MS)
}

export function stopDataWatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
