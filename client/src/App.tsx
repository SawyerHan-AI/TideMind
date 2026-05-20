import { lazy, Suspense, useEffect, useState, useCallback } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
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

export function App() {
  const [proFeatures, setProFeatures] = useState<ProFeatures | null>(null)
  const [ready, setReady] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)

  useEffect(() => {
    Promise.all([
      loadProFeatures().then(setProFeatures).catch(() => null),
      window.api.config.get().then((config: any) => {
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
