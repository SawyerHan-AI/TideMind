import { lazy, Suspense, useEffect, useState, useCallback } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { TimezoneProvider } from './contexts/TimezoneContext'
import { DataChangeProvider } from './contexts/DataChangeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { MandatoryUpdateModal } from './components/MandatoryUpdateModal'
import { SkeletonCard } from './components/Skeleton'
import { OnboardingProvider } from './onboarding/OnboardingContext'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { loadProFeatures, type ProFeatures } from './feature-registry'
import { useTranslation } from 'react-i18next'
import type { AgentIntegrationUserNotificationDto } from './lib/api-contract'

// 路由级代码分割(perf-optimization-2026-05-17 P0-3):4 个 page 不再
// 静态 import 进首包,首屏只加载 Dashboard 所需的 chunk;
// 切换路由时按需加载,Suspense fallback 兜底视觉连续。
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })))
const BrainExplorer = lazy(() => import('./pages/BrainExplorer').then(m => ({ default: m.BrainExplorer })))
const Timeline = lazy(() => import('./pages/Timeline').then(m => ({ default: m.Timeline })))
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })))

function RouteFallback() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonCard />
      <SkeletonCard />
    </div>
  )
}

function OnboardingRoute({ onFinish }: { onFinish: () => void }) {
  return (
    <OnboardingProvider onFinish={onFinish}>
      <OnboardingPage />
    </OnboardingProvider>
  )
}

function AgentIntegrationNotificationRouter() {
  const navigate = useNavigate()
  const { t } = useTranslation('settings')
  const [notification, setNotification] = useState<AgentIntegrationUserNotificationDto | null>(null)
  const openInstallation = useCallback((installationId: string | null) => {
    navigate(`/settings?tab=external&sub=agent${installationId
      ? `&installation=${encodeURIComponent(installationId)}`
      : ''}`)
  }, [navigate])

  useEffect(() => window.api.agentIntegrations.onOpenInstallation(openInstallation), [openInstallation])
  useEffect(() => window.api.agentIntegrations.onNotification(next => {
    setNotification(next)
    window.dispatchEvent(new CustomEvent('agent-integration-inbox-changed'))
  }), [])
  useEffect(() => {
    void window.api.agentIntegrations.inbox(10).then(inbox => {
      const latest = inbox.startupEvents[0]
      if (!latest) return
      setNotification({
        title: t('agent.managed.startupSummaryTitle'),
        body: t('agent.managed.startupSummaryBody', { count: inbox.startupUnreadCount }),
        level: latest.severity,
        eventId: latest.id,
        installationId: latest.installationId,
      })
    }).catch(() => {})
  }, [t])

  if (!notification) return null
  return (
    <div className="fixed bottom-5 right-5 z-[70] w-[min(360px,calc(100vw-2.5rem))] rounded-xl border border-white/10 bg-[#1b1b2b] p-4 shadow-2xl" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${notification.level === 'error'
          ? 'bg-red-400'
          : notification.level === 'warning' ? 'bg-amber-400' : 'bg-sky-400'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-gray-100">{notification.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">{notification.body}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => {
                const current = notification
                setNotification(null)
                void window.api.agentIntegrations.markEventRead(current.eventId).finally(() => {
                  window.dispatchEvent(new CustomEvent('agent-integration-inbox-changed'))
                })
                openInstallation(current.installationId)
              }}
              className="text-xs text-indigo-300 hover:text-indigo-200"
            >
              {t('agent.managed.viewDetails')}
            </button>
            <button type="button" onClick={() => setNotification(null)} className="text-xs text-gray-500 hover:text-gray-300">
              {t('agent.managed.dismiss')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const [proFeatures, setProFeatures] = useState<ProFeatures | null>(null)
  const [ready, setReady] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)

  useEffect(() => {
    Promise.all([
      loadProFeatures().then(setProFeatures).catch(() => null),
      window.api.config.get().then(config => {
        if (!config?.onboarding_completed) {
          setNeedsOnboarding(true)
        }
      }).catch(() => null),
    ]).finally(() => setReady(true))
  }, [])

  const handleOnboardingFinish = useCallback(() => {
    setNeedsOnboarding(false)
  }, [])

  if (!ready) return null

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TimezoneProvider>
        <DataChangeProvider>
        {/* MandatoryUpdateModal 必须挂在 HashRouter 外,确保任何路由 / Onboarding
            / Suspense fallback 状态下都覆盖全屏,不被 Outlet unmount。
            (2026-05-20 产品决策 #1 B 方案) */}
        <MandatoryUpdateModal />
        <HashRouter>
          <AgentIntegrationNotificationRouter />
          {needsOnboarding ? (
            <Routes>
              <Route path="/onboarding" element={<OnboardingRoute onFinish={handleOnboardingFinish} />} />
              <Route path="*" element={<Navigate to="/onboarding" replace />} />
            </Routes>
          ) : (
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/knowledge" element={<BrainExplorer />} />
                  <Route path="/timeline" element={<Timeline />} />
                  <Route path="/settings" element={<Settings />} />
                  {proFeatures?.routes.map((route, i) => (
                    <Route key={i} path={route.path} element={route.element} />
                  ))}
                </Route>
              </Routes>
            </Suspense>
          )}
        </HashRouter>
        </DataChangeProvider>
        </TimezoneProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
