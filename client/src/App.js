import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { TimezoneProvider } from './contexts/TimezoneContext';
import { DataChangeProvider } from './contexts/DataChangeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { SkeletonCard } from './components/Skeleton';
import { OnboardingProvider } from './onboarding/OnboardingContext';
import { OnboardingPage } from './onboarding/OnboardingPage';
import { loadProFeatures } from './feature-registry';
// 路由级代码分割(perf-optimization-2026-05-17 P0-3):4 个 page 不再
// 静态 import 进首包,首屏只加载 Dashboard 所需的 chunk;
// 切换路由时按需加载,Suspense fallback 兜底视觉连续。
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const BrainExplorer = lazy(() => import('./pages/BrainExplorer').then(m => ({ default: m.BrainExplorer })));
const Timeline = lazy(() => import('./pages/Timeline').then(m => ({ default: m.Timeline })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
function RouteFallback() {
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsx(SkeletonCard, {}), _jsx(SkeletonCard, {})] }));
}
function OnboardingRoute({ onFinish }) {
    return (_jsx(OnboardingProvider, { onFinish: onFinish, children: _jsx(OnboardingPage, {}) }));
}
export function App() {
    const [proFeatures, setProFeatures] = useState(null);
    const [ready, setReady] = useState(false);
    const [needsOnboarding, setNeedsOnboarding] = useState(false);
    useEffect(() => {
        Promise.all([
            loadProFeatures().then(setProFeatures).catch(() => null),
            window.api.config.get().then((config) => {
                if (!config?.onboarding_completed) {
                    setNeedsOnboarding(true);
                }
            }).catch(() => null),
        ]).finally(() => setReady(true));
    }, []);
    const handleOnboardingFinish = useCallback(() => {
        setNeedsOnboarding(false);
    }, []);
    if (!ready)
        return null;
    return (_jsx(ErrorBoundary, { children: _jsx(ThemeProvider, { children: _jsx(TimezoneProvider, { children: _jsx(DataChangeProvider, { children: _jsx(HashRouter, { children: needsOnboarding ? (_jsxs(Routes, { children: [_jsx(Route, { path: "/onboarding", element: _jsx(OnboardingRoute, { onFinish: handleOnboardingFinish }) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/onboarding", replace: true }) })] })) : (_jsx(Suspense, { fallback: _jsx(RouteFallback, {}), children: _jsx(Routes, { children: _jsxs(Route, { element: _jsx(Layout, {}), children: [_jsx(Route, { path: "/", element: _jsx(Dashboard, {}) }), _jsx(Route, { path: "/knowledge", element: _jsx(BrainExplorer, {}) }), _jsx(Route, { path: "/timeline", element: _jsx(Timeline, {}) }), _jsx(Route, { path: "/settings", element: _jsx(Settings, {}) }), proFeatures?.routes.map((route, i) => (_jsx(Route, { path: route.path, element: route.element }, i)))] }) }) })) }) }) }) }) }));
}
