import { useEffect, useState } from 'react'

const DAY_MS = 24 * 60 * 60 * 1000

/** UTC 日期,形如 2026-01-02。 */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 距离下一个 UTC 零点的毫秒数,恒为正。 */
export function msUntilNextUtcDay(now: number): number {
  return DAY_MS - (now % DAY_MS)
}

/**
 * 返回当前 UTC 日期,跨天时更新。
 *
 * 给按"今日"统计的查询当 refreshKey 用:这类查询的结果会随日期变化,而跨天时
 * 不一定有数据写入来触发刷新。用 UTC 是因为统计 SQL 用 date('now') 划分今日。
 * 除了零点定时器,窗口可见性变化时也核对一次:系统休眠期间定时器不走。
 */
export function useUtcDayKey(): string {
  const [dayKey, setDayKey] = useState(() => utcDayKey(Date.now()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const sync = () => {
      const now = Date.now()
      setDayKey(utcDayKey(now))
      clearTimeout(timer)
      timer = setTimeout(sync, msUntilNextUtcDay(now) + 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  return dayKey
}
