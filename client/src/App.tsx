import { useEffect, useState, useCallback } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { TimezoneProvider } from './contexts/TimezoneContext'
import { DataChangeProvider } from './contexts/DataChangeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { BrainExplorer } from './pages/BrainExplorer'
import { Timeline } from './pages/Timeline'
import { Settings } from './pages/Settings'
import { OnboardingProvider } from './onboarding/OnboardingContext'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { loadProFeatures, type ProFeatures } from './feature-registry'

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
      loadProFeatures().then(setProFeatures),
      window.api.config.get().then((config: any) => {
        if (!config?.onboarding_completed) {
          setNeedsOnboarding(true)
        }
      }),
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
        <HashRouter>
          {needsOnboarding ? (
            <Routes>
              <Route path="/onboarding" element={<OnboardingRoute onFinish={handleOnboardingFinish} />} />
              <Route path="*" element={<Navigate to="/onboarding" replace />} />
            </Routes>
          ) : (
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
          )}
        </HashRouter>
        </DataChangeProvider>
        </TimezoneProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
