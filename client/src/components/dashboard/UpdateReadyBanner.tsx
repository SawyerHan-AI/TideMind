import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RotateCw } from 'lucide-react'
import type { UpdaterState } from '../../lib/api-contract'

/**
 * 自动更新横幅:右下角浮窗,downloaded 状态才显示。
 *
 * 用户可"稍后"本地 dismiss(仅本进程内,下次启动重新弹);"立即重启"调
 * window.api.updater.install() 触发 quitAndInstall。
 */
export function UpdateReadyBanner() {
  const { t } = useTranslation('common')
  const [state, setState] = useState<UpdaterState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.updater.getState().then((s) => {
      if (!cancelled) setState(s)
    }).catch(() => {})

    const off = window.api.updater.onStateChanged((s) => {
      setState(s)
      setDismissed(false)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  if (dismissed) return null
  if (state.status !== 'downloaded') return null

  const version = state.version

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-md px-4 py-3 shadow-lg">
      <div className="flex items-start gap-3">
        <Download size={16} className="text-emerald-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-medium">
            {t('updater.ready', { version })}
          </div>
          <div className="text-xs text-gray-300 mt-0.5">
            {t('updater.readyDesc')}
          </div>
          <div className="flex gap-2 mt-2.5">
            <button
              type="button"
              onClick={() => window.api.updater.install()}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-100 transition-colors"
            >
              <RotateCw size={12} />
              {t('updater.installNow')}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md px-2.5 py-1 text-xs text-gray-300 hover:text-white transition-colors"
            >
              {t('updater.installLater')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
