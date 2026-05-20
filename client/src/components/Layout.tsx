import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
// MandatoryUpdateModal 提到 App 根挂载(2026-05-20 产品决策 #1):
// 原本挂在 Layout 内,route 切换 / Outlet 重渲染 / OnboardingPage 路径会让模态
// 在某些场景下 unmount,等价于"绕开必须升级"。提到 App.tsx HashRouter 之外 +
// 路由切换不影响。
// 普通(非 mandatory)的 downloaded 提示从 2026-05-20 起改为左下角 Sidebar
// UpdaterBadge chip,删除原 UpdateReadyBanner 浮窗(避免双重提示)。

export function Layout() {
  const { pathname } = useLocation()
  // 需要全高度布局的页面（底部常驻栏等）
  const isFullHeight = pathname === '/knowledge' || pathname === '/timeline'

  return (
    <div
      className="flex h-screen"
      style={{
        background: [
          'radial-gradient(ellipse at 25% 15%, var(--theme-glow-1), transparent 55%)',
          'radial-gradient(ellipse at 78% 88%, var(--theme-glow-2), transparent 55%)',
          'var(--theme-bg)',
        ].join(', '),
      }}
    >
      <Sidebar />
      <main className={`flex-1 relative ${isFullHeight ? 'overflow-hidden flex flex-col' : 'overflow-auto'}`}>
        {isFullHeight ? (
          <>
            <div className="drag-region absolute top-0 left-0 right-0 h-8 z-10" />
            <div className="flex-1 overflow-hidden">
              <Outlet />
            </div>
          </>
        ) : (
          <>
            <div className="drag-region h-8 w-full flex-shrink-0" />
            <div className="px-6 pb-6">
              <Outlet />
            </div>
          </>
        )}
      </main>
    </div>
  )
}
