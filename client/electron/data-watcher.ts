/**
 * 数据变更检测器
 *
 * 每 3 秒轮询 SQLite 关键表的最新 ID，
 * 检测到变化时通过 IPC 推送 'data-changed' 事件到渲染进程。
 * 覆盖所有写入源（MCP 独立进程 + Daemon 主进程）。
 */

import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'

const POLL_INTERVAL_MS = 3_000

let timer: ReturnType<typeof setInterval> | null = null
let lastTimelineId = 0
let lastNodeRowid = 0
let lastLinkRowid = 0

export function startDataWatcher(db: Database.Database): void {
  if (timer) return

  // 初始化基线值
  const initTimeline = db.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined
  const initNode = db.prepare('SELECT MAX(rowid) as v FROM nodes').get() as { v: number | null } | undefined
  const initLink = db.prepare('SELECT MAX(rowid) as v FROM links').get() as { v: number | null } | undefined

  lastTimelineId = initTimeline?.v ?? 0
  lastNodeRowid = initNode?.v ?? 0
  lastLinkRowid = initLink?.v ?? 0

  timer = setInterval(() => {
    try {
      const curTimeline = (db.prepare('SELECT MAX(id) as v FROM timeline_events').get() as { v: number | null } | undefined)?.v ?? 0
      const curNode = (db.prepare('SELECT MAX(rowid) as v FROM nodes').get() as { v: number | null } | undefined)?.v ?? 0
      const curLink = (db.prepare('SELECT MAX(rowid) as v FROM links').get() as { v: number | null } | undefined)?.v ?? 0

      if (curTimeline === lastTimelineId && curNode === lastNodeRowid && curLink === lastLinkRowid) {
        return // 无变化
      }

      const scopes: string[] = []
      if (curTimeline !== lastTimelineId) scopes.push('timeline')
      if (curNode !== lastNodeRowid) scopes.push('nodes')
      if (curLink !== lastLinkRowid) scopes.push('links')

      lastTimelineId = curTimeline
      lastNodeRowid = curNode
      lastLinkRowid = curLink

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
