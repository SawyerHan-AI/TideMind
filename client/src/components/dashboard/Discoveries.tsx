import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Sparkles, ThumbsUp, ThumbsDown } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useIPC } from '../../hooks/useIPC'
import { useDataRevision } from '../../contexts/DataChangeContext'
import { useFormatters } from '../../hooks/useFormatters'
import { resolveEventTitle } from '../../lib/timeline-utils'
import type { TimelineEvent } from '../../lib/api'

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

function FeedbackButtons({ event }: { event: TimelineEvent }) {
  const { t } = useTranslation('dashboard')
  const [submitted, setSubmitted] = useState<number | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const handleFeedback = async (signal: number) => {
    try {
      await window.api.write.submitFeedback(event.subtype, signal)
      if (mountedRef.current) setSubmitted(signal)
    } catch {
      // silently fail
    }
  }

  if (submitted !== null) {
    return (
      <span className="text-[10px] text-gray-500">
        {submitted > 0 ? t('discoveries.liked') : t('discoveries.disliked')}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <button
        onClick={() => handleFeedback(1)}
        className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-emerald-400 transition-colors"
      >
        <ThumbsUp size={12} />
      </button>
      <button
        onClick={() => handleFeedback(-1)}
        className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-red-400 transition-colors"
      >
        <ThumbsDown size={12} />
      </button>
    </span>
  )
}

export function Discoveries() {
  const { t } = useTranslation('dashboard')
  const { timeAgo } = useFormatters()
  const rev = useDataRevision(['timeline'])
  const { data } = useIPC(
    () => window.api.timeline.list({ types: ['think_emerge', 'evolution'], limit: 5 }),
    [rev],
  )

  const events = data?.events ?? []

  return (
    <motion.div variants={fadeUp} className="glass-card rounded-xl p-4 h-full">
      <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--fg-secondary)' }}>{t('discoveries.title')}</h3>

      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-gray-600">
          <Sparkles size={24} className="mb-2 opacity-40" />
          <p className="text-sm">{t('discoveries.brewing')}</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-auto">
          {events.map((event: TimelineEvent) => (
            <div
              key={`${event.source}-${event.id}`}
              className="flex items-start gap-2 text-xs py-1.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-gray-300 truncate">{resolveEventTitle(event.title, t)}</p>
                <p className="text-gray-500 text-[10px] mt-0.5">{timeAgo(event.created)}</p>
              </div>
              <FeedbackButtons event={event} />
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}
