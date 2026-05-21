import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Brain, Clock, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import logoSrc from '../assets/logo.png'
import { getProFeatures } from '../feature-registry'
import { CloudStatus } from './sidebar/CloudStatus'
import { LLMHealthBadge } from './sidebar/LLMHealthBadge'
import { UpdaterBadge } from './sidebar/UpdaterBadge'

const coreNavKeys = [
  { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { to: '/knowledge', icon: Brain, labelKey: 'nav.explorer' },
  { to: '/timeline', icon: Clock, labelKey: 'nav.timeline' },
  { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
]

function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    // F4: setState after unmount 警告守卫
    let cancelled = false
    window.api.app.getVersion()
      .then(v => { if (!cancelled) setVersion(v) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return version
}

export function Sidebar() {
  const { t } = useTranslation()
  const appVersion = useAppVersion()
  return (
    <aside className="glass-sidebar w-56 flex-shrink-0 flex flex-col" style={{
      borderRight: '1px solid var(--border-faint)',
    }}>
      {/* 标题区 + macOS 交通灯留白 */}
      <div className="drag-region px-4" style={{ paddingTop: 38 }}>
        <div className="flex items-center gap-2 pb-2.5">
          <img src={logoSrc} alt="Tide Mind" className="w-7 h-7 rounded-md flex-shrink-0" />
          <h1 className="text-[15px] font-semibold tracking-wide" style={{ color: 'var(--fg-primary)' }}>
            Tide Mind
          </h1>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex-1 mt-3 px-2.5 space-y-0.5">
        {[...coreNavKeys.map(n => ({ ...n, label: t(n.labelKey) })), ...(getProFeatures()?.sidebarItems ?? [])].map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `no-drag relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
              }`
            }
            style={({ isActive }) => isActive ? {
              background: 'var(--active-bg)',
              boxShadow: 'var(--active-shadow)',
            } : {}}
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    className="nav-active-indicator"
                    style={{ color: 'var(--indicator)' }}
                  />
                )}
                <item.icon
                  size={16}
                  style={{ color: isActive ? 'var(--fg-primary)' : 'var(--fg-tertiary)' }}
                />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* 渐变分隔线 */}
      <div className="mx-3 mb-2" style={{
        height: '1px',
        background: 'linear-gradient(90deg, transparent, var(--border-faint) 30%, var(--border-faint) 70%, transparent)',
      }} />

      {/* LLM 健康状态 */}
      <LLMHealthBadge />

      {/* Cloud 状态 */}
      <CloudStatus />

      {/* 自动更新状态 */}
      <UpdaterBadge />

      {/* 底部版本号 */}
      {appVersion && (
        <div className="px-4 py-3 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          v{appVersion}
        </div>
      )}
    </aside>
  )
}
