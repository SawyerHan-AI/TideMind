import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw } from 'lucide-react'
import type { UpdaterState } from '../lib/api-contract'

/**
 * Mandatory(强制)更新模态:全屏阻塞,只能"立即重启"。
 *
 * 显示条件:updater.state.status === 'downloaded' && mandatory === true。
 * 用于安全修复 / 云端 API 协议变更等老版本无法继续工作的场景,普通版本升级不该触发。
 */
export function MandatoryUpdateModal() {
  const { t } = useTranslation('common')
  const [state, setState] = useState<UpdaterState>({ status: 'idle' })

  useEffect(() => {
    let cancelled = false
    window.api.updater.getState().then((s) => {
      if (!cancelled) setState(s)
    }).catch(() => {})
    const off = window.api.updater.onStateChanged((s) => setState(s))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  if (state.status !== 'downloaded') return null
  if (!state.mandatory) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md">
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

        <p className="text-sm text-gray-300 leading-relaxed mb-4">
          {t('updater.mandatoryDesc', { version: state.version })}
        </p>

        {state.releaseNotes && (
          <div className="text-xs text-gray-400 bg-white/[0.04] rounded-lg p-3 mb-5 max-h-32 overflow-y-auto whitespace-pre-line">
            {state.releaseNotes}
          </div>
        )}

        <button
          type="button"
          onClick={() => window.api.updater.install()}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 px-4 py-3 text-sm font-medium text-red-100 transition-colors"
        >
          <RotateCw size={14} />
          {t('updater.mandatoryRestart')}
        </button>
      </div>
    </div>
  )
}
