import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TimelineEvent } from '../../lib/api'
import { EVENT_TYPE_COLORS, EVENT_SUBTYPE_LABELS, ACTOR_LABELS, ACTOR_COLORS } from '../../lib/constants'
import { useFormatters } from '../../hooks/useFormatters'
import { resolveEventTitle } from '../../lib/timeline-utils'
import { TimelineExpanded } from './TimelineExpanded'
import { brand } from '../../lib/tokens'

/** Dot fill color — all event types use brand primary. */
const DOT_COLORS: Record<string, string> = {
  memory: brand.primary,
  think_associate: brand.primary,
  think_emerge: brand.primary,
  output: brand.primary,
  evolution: brand.primary,
  config: brand.primary,
}

export function TimelineItem({
  event,
  isExpanded,
  onToggle,
  onNodeClick,
}: {
  event: TimelineEvent
  isExpanded: boolean
  onToggle: () => void
  onNodeClick: (id: string) => void
}) {
  const { t } = useTranslation()
  const { timeAgo, formatDate } = useFormatters()
  const dotColor = DOT_COLORS[event.type] ?? brand.primary
  const isImportant = event.important === 1

  return (
    <div className={`relative pl-8 ${isImportant ? 'border-l-2 border-amber-400 ml-[10px]' : ''}`}>
      {/* Dot on the timeline line — centered on the vertical line at left-[11px] */}
      <div
        className="absolute top-3 flex items-center justify-center"
        style={{ left: isImportant ? '-8px' : '6px' }}
      >
        <div
          className={`rounded-full ${isImportant ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'}`}
          style={{ backgroundColor: dotColor }}
        />
      </div>

      {/* Main row — clickable */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 py-2.5 px-3 hover:bg-white/[0.05] rounded-lg transition-all duration-150 text-left group"
      >
        <span
          className="text-xs text-gray-500 tabular-nums flex-shrink-0 w-24"
          title={formatDate(event.created)}
        >
          {timeAgo(event.created)}
        </span>

        <span
          className={`flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-medium ${
            EVENT_TYPE_COLORS[event.type] ?? 'bg-gray-500/20 text-gray-400'
          }`}
        >
          {EVENT_SUBTYPE_LABELS[event.subtype] ?? event.subtype}
        </span>

        <span
          className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] ${
            ACTOR_COLORS[event.actor] ?? 'bg-slate-500/20 text-slate-300'
          }`}
        >
          {ACTOR_LABELS[event.actor] ?? event.actor}
        </span>

        <span className="flex-1 text-sm text-gray-200 truncate">
          {resolveEventTitle(event.title, t)}
        </span>

        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="text-gray-600 group-hover:text-gray-300 flex-shrink-0 transition-colors"
        >
          <ChevronRight size={14} />
        </motion.span>
      </button>

      {/* Expanded detail */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 ml-3 border-l border-white/[0.08]">
              <TimelineExpanded event={event} onNodeClick={onNodeClick} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
