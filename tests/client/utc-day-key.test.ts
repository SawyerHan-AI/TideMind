import { describe, expect, it } from 'vitest'
import { msUntilNextUtcDay, utcDayKey } from '../../client/src/hooks/useUtcDayKey.ts'

describe('utc day key', () => {
  it('changes exactly at UTC midnight', () => {
    expect(utcDayKey(Date.UTC(2026, 0, 2, 23, 59, 59, 999))).toBe('2026-01-02')
    expect(utcDayKey(Date.UTC(2026, 0, 3, 0, 0, 0, 0))).toBe('2026-01-03')
  })

  it('measures the time left until the next UTC midnight', () => {
    expect(msUntilNextUtcDay(Date.UTC(2026, 0, 2, 23, 59, 59, 0))).toBe(1000)
    expect(msUntilNextUtcDay(Date.UTC(2026, 0, 2, 12, 0, 0, 0))).toBe(12 * 60 * 60 * 1000)
  })

  it('never returns zero at midnight itself', () => {
    const midnight = Date.UTC(2026, 0, 3, 0, 0, 0, 0)
    expect(msUntilNextUtcDay(midnight)).toBe(24 * 60 * 60 * 1000)
    expect(utcDayKey(midnight + msUntilNextUtcDay(midnight))).toBe('2026-01-04')
  })
})
