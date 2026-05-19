import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { UpdateReadyBanner } from './dashboard/UpdateReadyBanner';
import { MandatoryUpdateModal } from './MandatoryUpdateModal';
export function Layout() {
    const { pathname } = useLocation();
    // 需要全高度布局的页面（底部常驻栏等）
    const isFullHeight = pathname === '/knowledge' || pathname === '/timeline';
    return (_jsxs("div", { className: "flex h-screen", style: {
            background: [
                'radial-gradient(ellipse at 25% 15%, var(--theme-glow-1), transparent 55%)',
                'radial-gradient(ellipse at 78% 88%, var(--theme-glow-2), transparent 55%)',
                'var(--theme-bg)',
            ].join(', '),
        }, children: [_jsx(Sidebar, {}), _jsx(UpdateReadyBanner, {}), _jsx(MandatoryUpdateModal, {}), _jsx("main", { className: `flex-1 relative ${isFullHeight ? 'overflow-hidden flex flex-col' : 'overflow-auto'}`, children: isFullHeight ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "drag-region absolute top-0 left-0 right-0 h-8 z-10" }), _jsx("div", { className: "flex-1 overflow-hidden", children: _jsx(Outlet, {}) })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "drag-region h-8 w-full flex-shrink-0" }), _jsx("div", { className: "px-6 pb-6", children: _jsx(Outlet, {}) })] })) })] }));
}
