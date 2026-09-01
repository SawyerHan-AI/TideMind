import { useState, useEffect, useRef, type KeyboardEvent } from 'react'
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
import { subscribeAgentIntegrationInboxRefresh } from '../lib/agent-integration-inbox-refresh'

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
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [agentUnreadCount, setAgentUnreadCount] = useState(0)

  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.api.agentIntegrations.inbox(1).then(inbox => {
        if (active) setAgentUnreadCount(inbox.actionableUnreadCount)
      }).catch(() => {})
    }
    refresh()
    const unsubscribe = window.api.agentIntegrations.onNotification(refresh)
    const unsubscribeVisibleRefresh = subscribeAgentIntegrationInboxRefresh(window, document, refresh)
    return () => {
      active = false
      unsubscribe()
      unsubscribeVisibleRefresh()
    }
  }, [])

  // 从 URL 参数读取初始 tab，支持 /settings?tab=model&sub=connection
  const urlTab = searchParams.get('tab') || 'general'
  const [tab, setTab] = useState<string>(
    TABS.some(tb => tb.id === urlTab) ? urlTab : 'general'
  )

  // URL 参数变化时同步 tab
  useEffect(() => {
    const t = searchParams.get('tab')
    // 用函数式 setState 避免 stale closure: 之前 deps 漏 `tab` 时,t === tab
    // 比较的是初次 mount 的闭包值，可能误判跳过更新。
    setTab(prev => (t && TABS.some(tb => tb.id === t) && t !== prev) ? t : prev)
  }, [searchParams])

  const handleTabChange = (id: string) => {
    setTab(id)
    // 用户在 tab 间切换时只清掉 tab/sub 参数（这两个对子页有同步意义），
    // 其他 query 保留。旧实现直接 setSearchParams({}) 把 sub 也清了 →
    // 从 Dashboard banner 跳 /settings?tab=external&sub=note 进来,点 tab 后
    // sub 立刻被重置到默认值，用户感知不到为何"跳错位置"。
    if (searchParams.has('tab') || searchParams.has('sub')) {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev)
          next.delete('tab')
          next.delete('sub')
          return next
        },
        { replace: true },
      )
    }
  }

  const selectTab = (id: string, focus = false) => {
    handleTabChange(id)
    if (focus) requestAnimationFrame(() => tabRefs.current.get(id)?.focus())
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = TABS.findIndex(item => item.id === id)
    if (index < 0) return
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    selectTab(TABS[next].id, true)
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div
        className="overflow-x-auto overscroll-x-contain"
        style={{ borderBottom: '1px solid var(--border-faint)' }}
      >
        <div
          className="flex w-max min-w-full items-center gap-0.5 pb-0"
          role="tablist"
          aria-label={t('settings:title', 'Settings')}
        >
          {TAB_ITEMS.map((item, idx) => {
            if ('separator' in item) {
              return (
                <div
                  key={`sep-${idx}`}
                  aria-hidden="true"
                  className="w-px h-4 mx-1 flex-shrink-0"
                  style={{ background: 'var(--border-faint)' }}
                />
              )
            }
            const tb = item
            return (
              <button
                key={tb.id}
                ref={element => {
                  if (element) tabRefs.current.set(tb.id, element)
                  else tabRefs.current.delete(tb.id)
                }}
                id={`settings-tab-${tb.id}`}
                role="tab"
                aria-selected={tab === tb.id}
                aria-controls={`settings-panel-${tb.id}`}
                tabIndex={tab === tb.id ? 0 : -1}
                onClick={() => selectTab(tb.id)}
                onKeyDown={event => handleTabKeyDown(event, tb.id)}
                className={`flex flex-shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all duration-150 relative ${
                  tab === tb.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <tb.icon size={13} />
                {t(tb.labelKey)}
                {tb.id === 'external' && agentUnreadCount > 0 && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden />
                    <span className="sr-only">{t('settings:agent.managed.unreadUpdates', { count: agentUnreadCount })}</span>
                  </>
                )}
                {tab === tb.id && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full" style={{ background: 'var(--indicator)' }} />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <motion.div
        key={tab}
        id={`settings-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        tabIndex={0}
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
