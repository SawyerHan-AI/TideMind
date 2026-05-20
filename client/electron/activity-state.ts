/**
 * 应用活动状态(active / idle)单例 + 状态变化广播。
 *
 * 背景:macOS 把 BrowserWindow 隐藏/最小化几小时后,Chromium 会节流主进程
 * setInterval。回到前台时定时器队列里积累的 tick 一次性 fire,撞上 better-sqlite3
 * 的同步 API,主线程被串行 SQL 锁住几十秒到一分钟,鼠标转圈(2026-05-21 排查)。
 *
 * 这里把"用户走了 / 回来了"做成一个全局事件源:
 *   - data-watcher / sync-client / daemon 订阅这个信号,各自决定 idle 时 pause、
 *     active 时错峰恢复。
 *   - 不依赖 Chromium 的 backgroundThrottling(那个会让后台一直跑全速 setInterval,
 *     电池代价大),我们显式管理。
 *
 * 输入信号:
 *   - BrowserWindow hide / minimize  → 立即 idle("用户主动离开窗口")
 *   - BrowserWindow show / restore / focus → 立即 active
 *   - BrowserWindow blur(焦点切到别 app)→ 延迟 BLUR_TO_IDLE_MS 才 idle,
 *     避免切个对话框回来就触发恢复路径
 *   - powerMonitor suspend → 立即 idle("系统睡眠")
 *   - powerMonitor resume / unlock-screen → 立即 active
 *
 * 输出:
 *   - getState() 同步读
 *   - onChange(listener) 订阅,返回 unsubscribe
 *
 * 为什么不用 `powerMonitor.getSystemIdleTime` / `getSystemIdleState`:
 *   那两个 API 返回的是"系统级用户输入静默时长",跟"我们的窗口被隐藏多久"
 *   不是一回事。用户在别的 app 里活跃打字,系统 idle time 为 0,但 TideMind 的
 *   BrowserWindow 仍然 hidden,Chromium 节流仍在生效。要的是"我们的渲染窗口
 *   对用户可见吗",这是 BrowserWindow 事件 + powerMonitor suspend 的并集,
 *   不是系统 idle。
 */

import { EventEmitter } from 'node:events'
import { createLogger } from '@server/utils/logger.js'

const log = createLogger('activity-state')

export type ActivityState = 'active' | 'idle'

/**
 * blur(焦点离开)多久后才把状态降为 idle。
 *
 * 短时切窗(查 Slack、看邮件)很常见,不能一切窗就把 sync/watcher 全 pause —
 * 否则用户切回来还得等一次错峰恢复(2s+),感知就是变卡。60s 是经验值:
 * 真"走开几小时"远 > 60s,真"切个窗就回来"远 < 60s。
 */
const BLUR_TO_IDLE_MS = 60_000

export class ActivityStateManager extends EventEmitter {
  private state: ActivityState = 'active'
  private blurTimer: ReturnType<typeof setTimeout> | null = null

  getState(): ActivityState {
    return this.state
  }

  /**
   * 订阅状态变化。listener 在每次状态改变时被调用,初始状态不会触发。
   * 返回 unsubscribe;调用方应在 stop/destroy 时清理。
   */
  onChange(listener: (state: ActivityState) => void): () => void {
    this.on('change', listener)
    return () => { this.off('change', listener) }
  }

  /** 窗口 hide / minimize:明确的"用户离开"信号,立即 idle。 */
  notifyHidden(reason: 'hide' | 'minimize'): void {
    this.clearBlurTimer()
    this.setState('idle', reason)
  }

  /** 窗口 show / restore / focus:用户回来了,立即 active。 */
  notifyVisible(reason: 'show' | 'restore' | 'focus'): void {
    this.clearBlurTimer()
    this.setState('active', reason)
  }

  /**
   * 窗口 blur(焦点切到别 app)。不立即 idle,延迟 BLUR_TO_IDLE_MS。
   * 期间任何 visible 信号都会取消 timer 保持 active。
   */
  notifyBlur(): void {
    if (this.state === 'idle') return // 已 idle,blur 是噪声
    if (this.blurTimer) return        // 已在倒计时
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null
      this.setState('idle', `blur-timeout-${BLUR_TO_IDLE_MS}ms`)
    }, BLUR_TO_IDLE_MS)
  }

  /** powerMonitor suspend(系统睡眠):立即 idle。 */
  notifySuspend(): void {
    this.clearBlurTimer()
    this.setState('idle', 'power-suspend')
  }

  /** powerMonitor resume / unlock-screen:立即 active。 */
  notifyResume(reason: 'resume' | 'unlock-screen'): void {
    this.clearBlurTimer()
    this.setState('active', `power-${reason}`)
  }

  /**
   * 内部状态迁移。state = next 先于 emit:re-entrant listener 调 getState()
   * 看到的是新状态。但 EventEmitter 同步派发时把 listener 列表快照下来,
   * 所以"在 listener 内调 notifyXxx 触发嵌套切换"会让同批后续 listener
   * 收到的 `next` 参数与 `getState()` 不一致。**约定 listener 内不要再调
   * notifyXxx,要做副作用就 setImmediate / queueMicrotask 推到下一轮事件循环。**
   */
  private setState(next: ActivityState, reason: string): void {
    if (this.state === next) return
    log.info(`${this.state} → ${next} (${reason})`)
    this.state = next
    this.emit('change', next)
  }

  private clearBlurTimer(): void {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer)
      this.blurTimer = null
    }
  }

  /** 仅测试用:重置内部状态。 */
  __resetForTests(): void {
    this.clearBlurTimer()
    this.state = 'active'
    this.removeAllListeners('change')
  }
}

let instance: ActivityStateManager | null = null

export function getActivityState(): ActivityStateManager {
  if (!instance) instance = new ActivityStateManager()
  return instance
}
