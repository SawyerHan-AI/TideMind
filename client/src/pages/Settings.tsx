import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Palette, Plug, Cpu, Sliders, Database, Info, Cloud, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { GeneralSettings } from '../components/settings/GeneralSettings'
import { ExternalIntegration } from '../components/settings/ExternalIntegration'
import { ModelConfig } from '../components/settings/ModelConfig'
import { InternalStrategy } from '../components/settings/InternalStrategy'
import { DataManagement } from '../components/settings/DataManagement'
import { AboutSection } from '../components/settings/AboutSection'
import { CloudSyncSettings } from '../components/settings/CloudSyncSettings'
import { AccountSettings } from '../components/settings/AccountSettings'

// ============================================================
// Tab definitions (grouped with separators)
// ============================================================

interface TabDef {
  id: string
  labelKey: string
  icon: typeof Palette
}

interface TabSeparator {
  separator: true
}

type TabItem = TabDef | TabSeparator

const TAB_ITEMS: TabItem[] = [
  // 本地设置
  { id: 'general', labelKey: 'settings:tabs.general', icon: Palette },
  { id: 'external', labelKey: 'settings:tabs.external', icon: Plug },
  { id: 'model', labelKey: 'settings:tabs.model', icon: Cpu },
  { id: 'strategy', labelKey: 'settings:tabs.strategy', icon: Sliders },
  { id: 'data', labelKey: 'settings:tabs.data', icon: Database },
  // 账号 + 云
  { separator: true },
  { id: 'account', labelKey: 'settings:tabs.account', icon: User },
  { id: 'cloud', labelKey: 'settings:tabs.cloud', icon: Cloud },
  // 关于
  { separator: true },
  { id: 'about', labelKey: 'settings:tabs.about', icon: Info },
]

const TABS = TAB_ITEMS.filter((t): t is TabDef => !('separator' in t))

// ============================================================
// Main Settings component
// ============================================================

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()

  // 从 URL 参数读取初始 tab，支持 /settings?tab=model&sub=connection
  const urlTab = searchParams.get('tab') || 'general'
  const [tab, setTab] = useState<string>(
    TABS.some(tb => tb.id === urlTab) ? urlTab : 'general'
  )

  // URL 参数变化时同步 tab
  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && TABS.some(tb => tb.id === t) && t !== tab) {
      setTab(t)
    }
  }, [searchParams])

  const handleTabChange = (id: string) => {
    setTab(id)
    // 清掉 URL 参数，避免残留
    if (searchParams.has('tab')) {
      setSearchParams({}, { replace: true })
    }
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-0.5 pb-0" style={{ borderBottom: '1px solid var(--border-faint)' }}>
        {TAB_ITEMS.map((item, idx) => {
          if ('separator' in item) {
            return (
              <div key={`sep-${idx}`} className="w-px h-4 mx-1 flex-shrink-0" style={{ background: 'var(--border-faint)' }} />
            )
          }
          const tb = item
          return (
            <button
              key={tb.id}
              onClick={() => handleTabChange(tb.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all duration-150 relative ${
                tab === tb.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <tb.icon size={13} />
              {t(tb.labelKey)}
              {tab === tb.id && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full" style={{ background: 'var(--indicator)' }} />
              )}
            </button>
          )
        })}
      </div>

      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        {tab === 'general' && <GeneralSettings />}
        {tab === 'external' && <ExternalIntegration initialSub={searchParams.get('sub') || undefined} />}
        {tab === 'model' && <ModelConfig initialSub={searchParams.get('sub') || undefined} />}
        {tab === 'strategy' && <InternalStrategy />}
        {tab === 'data' && <DataManagement />}
        {tab === 'account' && <AccountSettings />}
        {tab === 'cloud' && <CloudSyncSettings />}
        {tab === 'about' && <AboutSection />}
      </motion.div>
    </div>
  )
}
