import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { ModelConnection } from './ModelConnection'
import { ModelSelection } from './ModelSelection'
import { ModelUsage } from './ModelUsage'

// ============================================================
// Model Config: 子 tab 壳 — 模型对接 / 模型选择 / 用量统计
// ============================================================

type SubTab = 'connection' | 'selection' | 'usage'
const SUB_TAB_KEYS: SubTab[] = ['connection', 'selection', 'usage']

function parseSubTab(value: string | undefined): SubTab | null {
  return value && SUB_TAB_KEYS.includes(value as SubTab) ? value as SubTab : null
}

export function ModelConfig({ initialSub }: { initialSub?: string } = {}) {
  const { t } = useTranslation('settings')
  const [subTab, setSubTab] = useState<SubTab>(() => parseSubTab(initialSub) ?? 'connection')

  useEffect(() => {
    setSubTab(parseSubTab(initialSub) ?? 'connection')
  }, [initialSub])

  const SUB_TABS: { key: SubTab; label: string }[] = [
    { key: 'connection', label: t('model.subtabs.connection') },
    { key: 'selection', label: t('model.subtabs.selection') },
    { key: 'usage', label: t('model.subtabs.usage') },
  ]

  return (
    <div className="space-y-4">
      {/* Sub-tab switcher */}
      <div className="flex items-center gap-2">
        {SUB_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSubTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
              subTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
            }`}
            style={subTab === tab.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <motion.div
        key={subTab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        {subTab === 'connection' && <ModelConnection />}
        {subTab === 'selection' && <ModelSelection />}
        {subTab === 'usage' && <ModelUsage />}
      </motion.div>
    </div>
  )
}
