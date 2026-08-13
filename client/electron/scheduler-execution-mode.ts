import { EventEmitter } from 'node:events'

export type SchedulerExecutionMode = 'foreground' | 'background' | 'paused'

export interface SchedulerWindowObservation {
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
}

export function deriveSchedulerExecutionMode(
  window: SchedulerWindowObservation | null,
  suspended: boolean,
): SchedulerExecutionMode {
  if (suspended) return 'paused'
  if (
    window
    && window.isVisible()
    && !window.isMinimized()
    && window.isFocused()
  ) {
    return 'foreground'
  }
  return 'background'
}

/**
 * Scheduler-only focus sampler.
 *
 * This intentionally does not reuse ActivityState's 60-second blur grace: watcher/cloud use that
 * grace to avoid churn, while scheduler admission must reflect whether the user is focused now.
 */
export class SchedulerExecutionModeManager extends EventEmitter {
  private mode: SchedulerExecutionMode = 'background'
  private suspended = false
  private lastWindow: SchedulerWindowObservation | null = null

  getMode(): SchedulerExecutionMode {
    return this.mode
  }

  onChange(listener: (mode: SchedulerExecutionMode) => void): () => void {
    this.on('change', listener)
    return () => { this.off('change', listener) }
  }

  sampleWindow(window: SchedulerWindowObservation | null): void {
    this.lastWindow = window
    this.setMode(deriveSchedulerExecutionMode(window, this.suspended))
  }

  notifySuspend(): void {
    this.suspended = true
    this.setMode('paused')
  }

  notifyResume(window: SchedulerWindowObservation | null = this.lastWindow): void {
    this.suspended = false
    this.sampleWindow(window)
  }

  private setMode(next: SchedulerExecutionMode): void {
    if (next === this.mode) return
    this.mode = next
    this.emit('change', next)
  }

  __resetForTests(): void {
    this.mode = 'background'
    this.suspended = false
    this.lastWindow = null
    this.removeAllListeners('change')
  }
}

let instance: SchedulerExecutionModeManager | null = null

export function getSchedulerExecutionMode(): SchedulerExecutionModeManager {
  if (!instance) instance = new SchedulerExecutionModeManager()
  return instance
}
