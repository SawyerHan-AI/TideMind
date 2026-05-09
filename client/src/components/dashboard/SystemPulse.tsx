import { motion, useMotionValue, useTransform, animate } from 'framer-motion'
import type { Variants } from 'framer-motion'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Zap, Link2, Search } from 'lucide-react'
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts'
import type { LucideIcon } from 'lucide-react'
import type { DashboardData } from '../../lib/api'
import { brand } from '../../lib/tokens'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

interface MiniStatCardProps {
  icon: LucideIcon
  label: string
  value: number
  color: string
  trendData: Array<{ date: string; count: number }>
  gradientId: string
}

function MiniStatCard({ icon: Icon, label, value, color, trendData, gradientId }: MiniStatCardProps) {
  const count = useMotionValue(0)
  const rounded = useTransform(count, v => Math.round(v))

  useEffect(() => {
    const controls = animate(count, value, { duration: 0.8, ease: 'easeOut' })
    // 修复 M34(2026-05-09):返回箭头函数确保 controls.stop 以正确 this 调用。
    // 原 `return controls.stop` 是 unbound 方法引用,React cleanup 调用时
    // `this===undefined`,某些 framer-motion 版本依赖 this 会抛错或不停动画。
    return () => controls.stop()
  }, [value])

  return (
    <motion.div variants={fadeUp} className="glass-card rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div
          className="p-2 rounded-lg flex-shrink-0"
          style={{ backgroundColor: `${color}18` }}
        >
          <Icon size={15} style={{ color }} />
        </div>
        <div className="min-w-0 flex-1">
          <motion.p className="text-2xl font-semibold text-white tabular-nums leading-none">
            {rounded}
          </motion.p>
          <p className="text-[9px] text-gray-500 mt-1 leading-tight tracking-wide">{label}</p>
        </div>
      </div>
      {trendData.length > 1 && (() => {
        const vals = trendData.map(d => d.count)
        const min = Math.min(...vals)
        const max = Math.max(...vals)
        const range = max - min
        const lowerPad = Math.max(range * 0.2, 1)
        const upperPad = Math.max(range * 0.15, 1)
        return (
          <div className="h-7 -mx-1 -mb-1">
            <ResponsiveContainer width="100%" height={28}>
              <AreaChart data={trendData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={brand.primary} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={brand.secondary} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <YAxis hide domain={[min - lowerPad, max + upperPad]} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke={brand.secondary}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )
      })()}
    </motion.div>
  )
}

/** 将每日增量转为累计曲线 */
function toCumulative(trend: Array<{ date: string; count: number }>, baseTotal: number): Array<{ date: string; count: number }> {
  if (trend.length === 0) return []
  const totalInRange = trend.reduce((s, d) => s + d.count, 0)
  let running = baseTotal - totalInRange
  return trend.map(d => {
    running += d.count
    return { date: d.date, count: running }
  })
}

export function SystemPulse({ data }: { data: DashboardData }) {
  const { t } = useTranslation('dashboard')
  const memoryTrendCumulative = useMemo(
    () => toCumulative(data.memoryTrend, data.totalMemories),
    [data.memoryTrend, data.totalMemories],
  )

  return (
    <motion.div variants={fadeUp} className="grid grid-cols-4 gap-3">
      <MiniStatCard
        icon={Brain}
        label={t('systemPulse.totalMemories')}
        value={data.totalMemories}
        color={brand.primary}
        trendData={memoryTrendCumulative}
        gradientId="pulse-1"
      />
      <MiniStatCard
        icon={Zap}
        label={t('systemPulse.todayDigests')}
        value={data.todayDigests}
        color={brand.primary}
        trendData={data.digestTrend}
        gradientId="pulse-2"
      />
      <MiniStatCard
        icon={Link2}
        label={t('systemPulse.todayLinks')}
        value={data.todayNewLinks}
        color={brand.primary}
        trendData={data.linkTrend}
        gradientId="pulse-3"
      />
      <MiniStatCard
        icon={Search}
        label={t('systemPulse.todayRecalls')}
        value={data.todayRecalls}
        color={brand.primary}
        trendData={data.recallTrend}
        gradientId="pulse-4"
      />
    </motion.div>
  )
}
