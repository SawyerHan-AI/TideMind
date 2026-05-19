import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { UpdateReadyBanner } from './dashboard/UpdateReadyBanner'
import { MandatoryUpdateModal } from './MandatoryUpdateModal'

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
      <UpdateReadyBanner />
      <MandatoryUpdateModal />
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
