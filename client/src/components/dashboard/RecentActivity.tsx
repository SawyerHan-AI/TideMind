import { motion } from 'framer-motion'
import type { Variants } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { CircleDashed } from 'lucide-react'
import { truncate } from '../../lib/format'
import { useFormatters } from '../../hooks/useFormatters'
import { EVENT_TYPE_COLORS, EVENT_TYPE_LABELS, EVENT_SUBTYPE_LABELS } from '../../lib/constants'
import { resolveEventTitle } from '../../lib/timeline-utils'
import type { DashboardData } from '../../lib/api'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

interface RecentActivityProps {
  activity: DashboardData['recentActivity']
  onNodeClick: (id: string) => void
}

export function RecentActivity({ activity, onNodeClick }: RecentActivityProps) {
  const { t } = useTranslation('dashboard')
  const { timeAgo } = useFormatters()
  return (
    <motion.div variants={fadeUp} className="glass-card rounded-xl p-4 h-full">
      <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--fg-secondary)' }}>{t('recentActivity.title')}</h3>

      {activity.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-gray-500">
          <CircleDashed size={24} className="mb-2 opacity-40" />
          <p className="text-sm">{t('recentActivity.brainNotStarted')}</p>
        </div>
      ) : (
        <div className="space-y-1 max-h-64 overflow-auto">
          {activity.map((event) => {
            const nodeIds = event.node_ids ? (() => { try { return JSON.parse(event.node_ids!) as string[] } catch { return [] } })() : []
            const firstNodeId = nodeIds[0]
            const colorClass = EVENT_TYPE_COLORS[event.type] ?? 'bg-gray-500/20 text-gray-400'
            const typeLabel = EVENT_TYPE_LABELS[event.type] ?? event.type
            const subtypeLabel = EVENT_SUBTYPE_LABELS[event.subtype] ?? event.subtype

            return (
              <button
                key={`${event.type}-${event.id}-${event.created}`}
                onClick={() => firstNodeId && onNodeClick(firstNodeId)}
                disabled={!firstNodeId}
                className="w-full flex items-center gap-3 text-xs py-2 px-2 rounded-lg hover:bg-white/[0.06] transition-all duration-150 text-left disabled:opacity-40 disabled:cursor-default"
              >
                <span className="text-gray-500 tabular-nums w-16 flex-shrink-0">
                  {timeAgo(event.created)}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${colorClass}`}>
                  {subtypeLabel || typeLabel}
                </span>
                <span className="text-gray-300 truncate">
                  {truncate(resolveEventTitle(event.title, t), 60)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}
