import { describe, expect, it, vi } from 'vitest'
import {
  deriveSchedulerExecutionMode,
  SchedulerExecutionModeManager,
  type SchedulerWindowObservation,
} from '../../client/electron/scheduler-execution-mode.js'

function windowState(
  visible: boolean,
  minimized: boolean,
  focused: boolean,
): SchedulerWindowObservation {
  return {
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
  }
}

describe('scheduler execution mode', () => {
  it.each([
    [true, false, true, false, 'foreground'],
    [true, false, false, false, 'background'],
    [true, true, false, false, 'background'],
    [false, false, false, false, 'background'],
    [true, false, true, true, 'paused'],
  ] as const)(
    'visible=%s minimized=%s focused=%s suspended=%s => %s',
    (visible, minimized, focused, suspended, expected) => {
      expect(
        deriveSchedulerExecutionMode(windowState(visible, minimized, focused), suspended),
      ).toBe(expected)
    },
  )

  it('show/restore等可见但未focus的窗口仍是background', () => {
    const manager = new SchedulerExecutionModeManager()
    const listener = vi.fn()
    manager.onChange(listener)

    manager.sampleWindow(windowState(true, false, false))
    expect(manager.getMode()).toBe('background')
    expect(listener).not.toHaveBeenCalled()

    manager.sampleWindow(windowState(true, false, true))
    expect(manager.getMode()).toBe('foreground')
    expect(listener).toHaveBeenLastCalledWith('foreground')
  })

  it('suspend进入paused，resume后重新采样而不是默认foreground', () => {
    const manager = new SchedulerExecutionModeManager()
    manager.sampleWindow(windowState(true, false, true))
    manager.notifySuspend()
    expect(manager.getMode()).toBe('paused')

    manager.notifyResume(windowState(true, false, false))
    expect(manager.getMode()).toBe('background')
  })
})
