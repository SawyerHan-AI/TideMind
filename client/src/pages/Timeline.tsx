import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useIPC } from '../hooks/useIPC'
import { useDataRevision } from '../contexts/DataChangeContext'
import { TimelineFilters } from '../components/timeline/TimelineFilters'
import { TimelineItem } from '../components/timeline/TimelineItem'
import { Skeleton } from '../components/Skeleton'

const ALL_TYPES = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution', 'config']
const ALL_ACTORS = ['user', 'agent', 'brain']
const PAGE_SIZE = 30

export function Timeline() {
  const { t } = useTranslation('timeline')
  const navigate = useNavigate()
  const [activeTypes, setActiveTypes] = useState<string[]>([...ALL_TYPES])
  const [activeActors, setActiveActors] = useState<string[]>([...ALL_ACTORS])
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggleType = useCallback((type: string) => {
    setActiveTypes(prev => {
      const next = prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
      return next.length > 0 ? next : prev
    })
    setPage(0)
  }, [])

  const toggleActor = useCallback((actor: string) => {
    setActiveActors(prev => {
      const next = prev.includes(actor) ? prev.filter(a => a !== actor) : [...prev, actor]
      return next.length > 0 ? next : prev
    })
    setPage(0)
  }, [])

  const rev = useDataRevision(['timeline'])

  const fetchTimeline = useCallback(
    () =>
      window.api.timeline.list({
        types: activeTypes.length < ALL_TYPES.length ? activeTypes : undefined,
        actors: activeActors.length < ALL_ACTORS.length ? activeActors : undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [activeTypes, activeActors, page, rev],
  )
  const { data, loading } = useIPC(fetchTimeline)

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE)

  const handleNodeClick = useCallback(
    (id: string) => navigate(`/knowledge?node=${id}`),
    [navigate],
  )

  const total = data?.total ?? 0

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="flex-shrink-0 px-4 pt-9 pb-3 border-b border-white/5">
        <TimelineFilters
          activeTypes={activeTypes}
          onToggleType={toggleType}
          activeActors={activeActors}
          onToggleActor={toggleActor}
        />
      </div>

      {/* Timeline body */}
      <div className="flex-1 overflow-y-auto px-6">
        {loading ? (
          <div className="space-y-3 pl-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5 px-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
        ) : data?.events.length === 0 ? (
          <div className="text-center py-16 text-gray-500 text-sm">
            {t('noEvents')}
          </div>
        ) : (
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-[11px] top-0 bottom-0 w-px bg-white/10" />

            {/* Events */}
            <div className="space-y-0.5">
              {data?.events.map((event, index) => {
                const uniqueId = `${event.source}-${event.id}`
                return (
                  <motion.div
                    key={uniqueId}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    // F10: stagger 封顶 10 项,避免大列表下后面的项 delay 累计到几秒甚至几十秒
                    transition={{ delay: Math.min(index, 10) * 0.03, duration: 0.25 }}
                  >
                    <TimelineItem
                      event={event}
                      isExpanded={expandedId === uniqueId}
                      onToggle={() =>
                        setExpandedId(prev => (prev === uniqueId ? null : uniqueId))
                      }
                      onNodeClick={handleNodeClick}
                    />
                  </motion.div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 底部常驻栏：总数 + 分页 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-white/5">
        <span className="text-[11px] text-gray-500">{t('total', { count: total })}</span>
        {totalPages > 1 ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setPage(p => Math.max(0, p - 1)); setExpandedId(null) }}
              disabled={page === 0}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-[11px] text-gray-400 tabular-nums">{page + 1} / {totalPages}</span>
            <button
              onClick={() => { setPage(p => Math.min(totalPages - 1, p + 1)); setExpandedId(null) }}
              disabled={page >= totalPages - 1}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 transition-all"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        ) : (
          <span />
        )}
      </div>
    </div>
  )
}
