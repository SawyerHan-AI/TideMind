import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw, Clock } from 'lucide-react'
import { useUpdaterState } from '../hooks/useUpdaterState'

/**
 * Mandatory(强制)更新模态:全屏阻塞,60s 倒计时 + 最多 3 次"再等 10 分钟"
 * (2026-05-20 产品决策 #1 B 方案)。
 *
 * 显示条件:updater.state.status === 'downloaded' && mandatory === true。
 * 用于安全修复 / 云端 API 协议变更等老版本无法继续工作的场景,普通版本升级不该触发。
 *
 * 行为:
 *   1. 弹出时显示 60 秒倒计时,期间用户可点"立即重启"或"再等 10 分钟"
 *   2. "再等 10 分钟"最多按 3 次,之后该按钮消失,只能"立即重启"
 *   3. 倒计时归零自动调 install
 *
 * 挂载位置:**App.tsx 根**(HashRouter 外),保证任何路由 / Onboarding / Suspense
 * fallback 下都覆盖全屏,不被 Outlet unmount。
 */

const COUNTDOWN_SECONDS = 60
const SNOOZE_MAX = 3
const SNOOZE_MS = 10 * 60 * 1000

export function MandatoryUpdateModal() {
  const { t } = useTranslation('common')
  const state = useUpdaterState()
  const [snoozeCount, setSnoozeCount] = useState(0)
  const [snoozedUntil, setSnoozedUntil] = useState<number>(0)
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS)
  const [installing, setInstalling] = useState(false)

  const isShowing =
    state.status === 'downloaded' &&
    state.mandatory === true &&
    Date.now() >= snoozedUntil &&
    !installing

  // 进入 showing 时重启 60 秒倒计时
  useEffect(() => {
    if (!isShowing) {
      setSecondsLeft(COUNTDOWN_SECONDS)
      return
    }
    setSecondsLeft(COUNTDOWN_SECONDS)
    const timer = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timer)
          // 倒计时归零 → 自动安装
          setInstalling(true)
          window.api.updater.install()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [isShowing])

  // snooze 到点后重新显示模态
  useEffect(() => {
    if (snoozedUntil === 0 || snoozedUntil <= Date.now()) return
    // 用 timer 避免和外层 `t`(translation function)同名
    const timer = setTimeout(() => setSnoozedUntil(0), snoozedUntil - Date.now())
    return () => clearTimeout(timer)
  }, [snoozedUntil])

  if (!isShowing) return null
  // isShowing 是 boolean 推导不是 TS type guard,这里显式 narrow 让下面读
  // state.version / state.releaseNotes / state.mandatory 时 TS 能保证类型安全。
  if (state.status !== 'downloaded') return null

  const canSnooze = snoozeCount < SNOOZE_MAX
  const remainingSnooze = SNOOZE_MAX - snoozeCount

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 backdrop-blur-md">
      <div
        className="max-w-md w-[90%] rounded-2xl border border-red-500/30 bg-zinc-900/95 p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-red-500/20 p-2">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">
            {t('updater.mandatoryTitle')}
          </h2>
        </div>

        <p className="text-sm text-gray-300 leading-relaxed mb-3">
          {t('updater.mandatoryDesc', { version: state.version })}
        </p>

        {/* 倒计时区域 */}
        <div className="flex items-center gap-2 mb-4 text-xs text-amber-300/90 bg-amber-500/10 rounded-lg px-3 py-2">
          <Clock size={14} />
          <span>{t('updater.mandatoryCountdown', { seconds: secondsLeft })}</span>
        </div>

        {state.releaseNotes && (
          <div className="text-xs text-gray-400 bg-white/[0.04] rounded-lg p-3 mb-5 max-h-32 overflow-y-auto whitespace-pre-line">
            {state.releaseNotes}
          </div>
        )}

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setInstalling(true)
              window.api.updater.install()
            }}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 px-4 py-3 text-sm font-medium text-red-100 transition-colors"
          >
            <RotateCw size={14} />
            {t('updater.mandatoryRestart')}
          </button>

          {canSnooze && (
            <button
              type="button"
              onClick={() => {
                setSnoozedUntil(Date.now() + SNOOZE_MS)
                setSnoozeCount((c) => c + 1)
              }}
              className="w-full rounded-lg border border-white/10 hover:border-white/20 px-4 py-2 text-xs font-medium text-gray-400 hover:text-white transition-colors"
            >
              {t('updater.mandatorySnooze', { remaining: remainingSnooze })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
