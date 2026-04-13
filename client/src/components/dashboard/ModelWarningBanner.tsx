import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

/**
 * 模型未配置警告横幅
 *
 * 当没有任何 online 的模型连接时，在 Dashboard 顶部显示。
 * 点击跳转到 Settings → Model → Connection 页面。
 */
export function ModelWarningBanner() {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const connections = await window.api.connections.list(false)
        const hasOnline = connections?.some(
          (c: any) => c.status === 'online' && !c.archived
        )
        if (!cancelled) setShow(!hasOnline)
      } catch {
        if (!cancelled) setShow(true)
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  if (!show) return null

  return (
    <div
      className="rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors bg-amber-400/10 border border-amber-400/20 hover:bg-amber-400/15"
      onClick={() => navigate('/settings?tab=model&sub=connection')}
    >
      <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs text-white">{t('modelWarning.message')}</span>
      </div>
      <span className="text-xs text-amber-400 flex-shrink-0 font-medium">
        {t('modelWarning.action')}
      </span>
    </div>
  )
}
