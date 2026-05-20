/**
 * activity-state 状态机测试。
 *
 * 覆盖:
 *   - hide/minimize 立即 idle
 *   - show/restore/focus 立即 active
 *   - blur 延迟 60s 才 idle,期间 visible 信号取消 timer
 *   - powerMonitor suspend / resume / unlock-screen
 *   - idempotent:相同状态重复 emit 不触发 change
 *   - unsubscribe 后 listener 不再被调
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getActivityState } from '../../client/electron/activity-state.js'

describe('activity-state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getActivityState().__resetForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    getActivityState().__resetForTests()
  })

  it('默认初始状态为 active', () => {
    expect(getActivityState().getState()).toBe('active')
  })

  it('notifyHidden(hide) 立即 → idle 并 emit change', () => {
    const states: string[] = []
    getActivityState().onChange((s) => states.push(s))

    getActivityState().notifyHidden('hide')
    expect(getActivityState().getState()).toBe('idle')
    expect(states).toEqual(['idle'])
  })

  it('notifyHidden(minimize) 也立即 → idle', () => {
    getActivityState().notifyHidden('minimize')
    expect(getActivityState().getState()).toBe('idle')
  })

  it('notifyVisible(show/restore/focus) 从 idle 立即 → active', () => {
    const states: string[] = []
    getActivityState().notifyHidden('hide')
    getActivityState().onChange((s) => states.push(s))

    getActivityState().notifyVisible('show')
    expect(getActivityState().getState()).toBe('active')
    expect(states).toEqual(['active'])
  })

  it('idempotent:已 active 再 notifyVisible 不重复 emit', () => {
    const listener = vi.fn()
    getActivityState().onChange(listener)

    getActivityState().notifyVisible('focus') // 已 active
    expect(listener).not.toHaveBeenCalled()
  })

  it('idempotent:已 idle 再 notifyHidden 不重复 emit', () => {
    getActivityState().notifyHidden('hide')
    const listener = vi.fn()
    getActivityState().onChange(listener)

    getActivityState().notifyHidden('minimize')
    expect(listener).not.toHaveBeenCalled()
  })

  it('blur 延迟 60s 才 → idle', () => {
    const listener = vi.fn()
    getActivityState().onChange(listener)

    getActivityState().notifyBlur()
    expect(getActivityState().getState()).toBe('active') // 还没到时间
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(59_000)
    expect(getActivityState().getState()).toBe('active')

    vi.advanceTimersByTime(2_000) // 跨过 60s
    expect(getActivityState().getState()).toBe('idle')
    expect(listener).toHaveBeenCalledWith('idle')
  })

  it('blur 期间收到 visible 信号 → 取消 idle timer,保持 active', () => {
    const listener = vi.fn()
    getActivityState().onChange(listener)

    getActivityState().notifyBlur()
    vi.advanceTimersByTime(30_000) // blur 30s

    getActivityState().notifyVisible('focus')
    expect(getActivityState().getState()).toBe('active')

    vi.advanceTimersByTime(60_000) // 再走 60s
    expect(getActivityState().getState()).toBe('active') // 不该变 idle
    // listener 一次都没被调过(state 没真的换过)
    expect(listener).not.toHaveBeenCalled()
  })

  it('多次 notifyBlur 不叠加 timer', () => {
    getActivityState().notifyBlur()
    vi.advanceTimersByTime(30_000)
    getActivityState().notifyBlur() // 重复调,不该重置 timer

    vi.advanceTimersByTime(31_000) // 距首次 blur 61s
    expect(getActivityState().getState()).toBe('idle')
  })

  it('powerMonitor suspend → idle, resume → active', () => {
    const states: string[] = []
    getActivityState().onChange((s) => states.push(s))

    getActivityState().notifySuspend()
    expect(getActivityState().getState()).toBe('idle')

    getActivityState().notifyResume('resume')
    expect(getActivityState().getState()).toBe('active')

    expect(states).toEqual(['idle', 'active'])
  })

  it('unlock-screen 视为 resume', () => {
    getActivityState().notifySuspend()
    getActivityState().notifyResume('unlock-screen')
    expect(getActivityState().getState()).toBe('active')
  })

  it('hidden 状态下 blur 是 no-op(不开新 timer 不 emit)', () => {
    getActivityState().notifyHidden('hide')
    const listener = vi.fn()
    getActivityState().onChange(listener)

    getActivityState().notifyBlur()
    vi.advanceTimersByTime(120_000) // 怎么走都不该触发
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribe 后 listener 不再被调', () => {
    const listener = vi.fn()
    const unsubscribe = getActivityState().onChange(listener)

    getActivityState().notifyHidden('hide')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    getActivityState().notifyVisible('show')
    expect(listener).toHaveBeenCalledTimes(1) // 不再被调
  })

  it('visible 信号会清掉未触发的 blur timer', () => {
    getActivityState().notifyBlur()

    getActivityState().notifyVisible('show')
    // 即使现在 advance 过了 60s,blur timer 已被清,不会触发 idle
    vi.advanceTimersByTime(60_000)
    expect(getActivityState().getState()).toBe('active')
  })

  it('hidden 信号会清掉未触发的 blur timer', () => {
    getActivityState().notifyBlur()
    getActivityState().notifyHidden('hide') // 立即 idle

    // 之前的 blur timer 已被清。如果再 visible,
    // 不应该有"延迟的 idle"在 60s 后突然触发把 state 弄回 idle。
    getActivityState().notifyVisible('show')
    vi.advanceTimersByTime(120_000)
    expect(getActivityState().getState()).toBe('active')
  })

  it('suspend 会清掉未触发的 blur timer:resume 回 active 后 stale timer 不能拍回 idle', () => {
    // 真实场景:用户切窗 30s(blur timer 还剩 30s 到期)→ 合盖 → 5min 后开盖
    getActivityState().notifyBlur()
    vi.advanceTimersByTime(30_000)
    getActivityState().notifySuspend()         // 立即 idle,应清 blur timer
    getActivityState().notifyResume('resume')  // 立即 active

    // 走过原 blur deadline(60s 从 blur 起算 = 再 30s),如果 stale timer 还在
    // 会把 state 拍回 idle。
    vi.advanceTimersByTime(60_000)
    expect(getActivityState().getState()).toBe('active')
  })

  it('resume 也会独立清 blur timer(防 suspend 信号缺失的兜底)', () => {
    // 防御性:有些 Linux 桌面环境 powerMonitor 可能不发 suspend 信号,
    // resume 自己也必须能清掉 stale blur timer。
    getActivityState().notifyBlur()
    getActivityState().notifyResume('resume')
    vi.advanceTimersByTime(120_000)
    expect(getActivityState().getState()).toBe('active')
  })

  it('__resetForTests 清掉 in-flight blur timer + listener + 重置 state', () => {
    // 元测试:reset 自身的正确性是其他所有测试隔离的基础,必须自检。
    const listener = vi.fn()
    getActivityState().onChange(listener)
    getActivityState().notifyBlur()             // 起一个 in-flight timer
    getActivityState().notifyHidden('minimize') // 此处 listener 被调一次

    getActivityState().__resetForTests()
    listener.mockClear() // 关注的是 reset 之后,清掉历史调用

    // reset 后:state 回到 active
    expect(getActivityState().getState()).toBe('active')
    // 旧 listener 已被 removeAllListeners 移除:后续状态变化不会被调
    getActivityState().notifyHidden('hide')
    expect(listener).not.toHaveBeenCalled()
    // 之前的 blur timer 也已被清:advance 60s+ 不会触发"延迟 idle"emit
    // (此时 state 已经是 idle,关键是观察新订阅的 listener2 收不到额外 'idle')
    const listener2 = vi.fn()
    getActivityState().onChange(listener2)
    vi.advanceTimersByTime(120_000)
    expect(listener2).not.toHaveBeenCalled()
  })
})
