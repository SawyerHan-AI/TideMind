import { useTranslation } from 'react-i18next'
import { useCloudStatus } from '../../hooks/useCloudStatus'

export function CloudStatus() {
  const { t } = useTranslation()
  const cloud = useCloudStatus()

  if (!cloud.loggedIn) return null

  // Determine state
  const isSyncing = cloud.syncing
  const isOnline = cloud.online

  const dotClass = isSyncing
    ? 'bg-blue-400 animate-pulse'
    : isOnline
      ? 'bg-emerald-400'
      : 'bg-gray-500'

  const dotShadow = isSyncing
    ? '0 0 6px rgba(96,165,250,0.5)'
    : isOnline
      ? '0 0 6px rgba(52,211,153,0.4)'
      : 'none'

  const label = isSyncing
    ? t('cloud.syncing', 'Syncing...')
    : isOnline
      ? t('cloud.connected', 'Connected')
      : t('cloud.offline', 'Offline')

  return (
    <div className="px-4 py-1.5 flex items-center gap-2 min-h-[28px]">
      <div
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`}
        style={{ boxShadow: dotShadow }}
      />
      <span className="text-[10px] text-gray-500 truncate">{label}</span>
      {cloud.outboxCount > 0 && (
        <span className="ml-auto text-[9px] font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full leading-none">
          {cloud.outboxCount}
        </span>
      )}
    </div>
  )
}
