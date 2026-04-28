import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import type { Variants } from 'framer-motion'
import { Tag, Info } from 'lucide-react'
import { useFormatters } from '../../hooks/useFormatters'
import type { DashboardData } from '../../lib/api'

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

interface RecentTagsProps {
  tags: DashboardData['recentTags']
  onTagClick: (tag: string) => void
}

export function RecentTags({ tags, onTagClick }: RecentTagsProps) {
  const { t } = useTranslation('dashboard')
  const { timeAgo } = useFormatters()
  const coreTags = tags.filter(item => item.isCore)
  const [showTip, setShowTip] = useState(false)

  if (coreTags.length === 0) return null

  return (
    <motion.div variants={fadeUp}>
      <div className="flex items-center gap-1.5 mb-3">
        <h3 className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>{t('recentTags.title')}</h3>
        <div className="relative">
          <Info
            size={12}
            className="text-gray-500 cursor-help"
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          />
          {showTip && (
            <div className="absolute left-4 top-0 z-10 px-2.5 py-1.5 rounded-lg bg-gray-800 border border-white/10 text-[10px] text-gray-300 whitespace-nowrap shadow-lg">
              {t('recentTags.coreOnly')}
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {coreTags.map((item) => (
          <button
            key={item.tag}
            onClick={() => onTagClick(item.tag)}
            className="glass-card rounded-xl p-4 hover:bg-white/[0.07] transition-all duration-200 text-left w-full"
          >
            <div className="flex items-center gap-2 mb-2">
              <Tag size={14} className="text-gray-400" />
              <span className="text-sm font-medium text-white truncate">
                {item.tag}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-gray-500">
              <span>{timeAgo(item.lastActivity)}</span>
              <span className="text-gray-600">|</span>
              <span>{item.count} {t('common:units.memories')}</span>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  )
}
