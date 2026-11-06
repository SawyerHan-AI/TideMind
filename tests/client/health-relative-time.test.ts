import { expect, it } from 'vitest'
import { formatHealthRelativeTime } from '../../client/src/lib/health-relative-time'
it('uses yesterday for a previous-day success even after 42 hours', () => {
  expect(formatHealthRelativeTime(new Date(2026,10,5,3,23).getTime(), 'zh-CN','无记录',new Date(2026,10,6,21,35).getTime())).toBe('昨天')
})
it('crosses midnight by calendar day, without rounding a few minutes to today', () => {
  expect(formatHealthRelativeTime(new Date(2026,10,5,23,58).getTime(), 'en','Never',new Date(2026,10,6,0,2).getTime())).toBe('yesterday')
})
it('preserves an old success date and missing records', () => {
  expect(formatHealthRelativeTime(new Date(2026,6,30,13,42).getTime(), 'zh-CN','无记录',new Date(2026,10,6,21,35).getTime())).toBe('99天前')
  expect(formatHealthRelativeTime(0,'en','Never')).toBe('Never')
})
