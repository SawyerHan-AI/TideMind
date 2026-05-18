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
  // perf-optimization-2026-05-17 P1-3:Dashboard 切片化拉数。
  // 原本一个 stats:dashboard 串行做 8+ 条 SQL(含全表 tags 聚合 500-1000ms),
  // 整个 Dashboard 必须等所有结果才能渲染。改成 3 个 IPC 并发:
  // metrics(毫秒级)先到先渲染骨架卡 → activity → tags 慢一拍但不阻塞。
  const { data: metrics, loading: metricsLoading } = useIPC(
    () => window.api.stats.dashboardMetrics(),
    [rev],
  )
  const { data: activity } = useIPC(
    () => window.api.stats.dashboardActivity(),
    [rev],
  )
  const { data: tags } = useIPC(
    () => window.api.stats.dashboardTags(),
    [rev],
  )
  const navigate = useNavigate()

  const handleNodeClick = (id: string) => {
    navigate(`/knowledge?node=${id}`)
  }

  const handleTagClick = (tag: string) => {
    navigate(`/knowledge?tag=${encodeURIComponent(tag)}`)
  }

  // 首屏依赖 metrics(指标卡 + 趋势 + isEmpty 判定)。activity / tags 可
  // 等到首帧之后填充,各自占位骨架。
  if (metricsLoading || !metrics) {
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

  const isEmpty = metrics.totalMemories === 0

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-6">
      <ModelWarningBanner />
      <InitBanner />

      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          <SystemPulse data={metrics} />

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              {activity ? (
                <RecentActivity
                  activity={activity}
                  onNodeClick={handleNodeClick}
                />
              ) : (
                <Skeleton className="h-64 rounded-xl" />
              )}
            </div>
            <div className="col-span-1">
              <Discoveries />
            </div>
          </div>

          {tags ? (
            <RecentTags tags={tags} onTagClick={handleTagClick} />
          ) : (
            <Skeleton className="h-40 rounded-xl" />
          )}
        </>
      )}
    </motion.div>
  )
}
