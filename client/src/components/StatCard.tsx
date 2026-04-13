import { motion, useMotionValue, useTransform, animate } from 'framer-motion'
import { useEffect } from 'react'
import type { LucideIcon } from 'lucide-react'
import { InfoTip } from './InfoTip'
import { brand } from '../lib/tokens'

export function StatCard({ icon: Icon, label, value, color = brand.primary, tip }: {
  icon: LucideIcon
  label: string
  value: number
  color?: string
  tip?: string
}) {
  const count = useMotionValue(0)
  const rounded = useTransform(count, v => Math.round(v))

  useEffect(() => {
    const controls = animate(count, value, { duration: 0.8, ease: 'easeOut' })
    return controls.stop
  }, [value])

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg" style={{ backgroundColor: `${color}20` }}>
          <Icon size={18} style={{ color }} />
        </div>
        <div>
          <motion.p className="text-2xl font-bold text-white tabular-nums">
            {rounded}
          </motion.p>
          <p className="text-xs text-gray-400 mt-0.5">
            {label}
            {tip && <InfoTip content={tip} />}
          </p>
        </div>
      </div>
    </div>
  )
}
