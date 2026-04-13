import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useIPC } from '../hooks/useIPC'
import { useDataRevision } from '../contexts/DataChangeContext'
import { Skeleton } from '../components/Skeleton'
import { ModelWarningBanner } from '../components/dashboard/ModelWarningBanner'
import { InitBanner } from '../components/dashboard/InitBanner'
import { SystemPulse } from '../components/dashboard/SystemPulse'
import { RecentActivity } from '../components/dashboard/RecentActivity'
import { Discoveries } from '../components/dashboard/Discoveries'
import { RecentTags } from '../components/dashboard/RecentTags'
import { EmptyState } from '../components/dashboard/EmptyState'

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
}

export function Dashboard() {
  const rev = useDataRevision()
  const { data: dashboard, loading } = useIPC(() => window.api.stats.dashboard(), [rev])
  const navigate = useNavigate()

  const handleNodeClick = (id: string) => {
    navigate(`/knowledge?node=${id}`)
  }

  const handleTagClick = (tag: string) => {
    navigate(`/knowledge?tag=${encodeURIComponent(tag)}`)
  }

  if (loading || !dashboard) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="col-span-2 h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    )
  }

  const isEmpty = dashboard.totalMemories === 0

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-6">
      <ModelWarningBanner />
      <InitBanner />

      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          <SystemPulse data={dashboard} />

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <RecentActivity
                activity={dashboard.recentActivity}
                onNodeClick={handleNodeClick}
              />
            </div>
            <div className="col-span-1">
              <Discoveries />
            </div>
          </div>

          <RecentTags
            tags={dashboard.recentTags}
            onTagClick={handleTagClick}
          />
        </>
      )}
    </motion.div>
  )
}
