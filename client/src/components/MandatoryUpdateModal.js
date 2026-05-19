import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCw } from 'lucide-react';
/**
 * Mandatory(强制)更新模态:全屏阻塞,只能"立即重启"。
 *
 * 显示条件:updater.state.status === 'downloaded' && mandatory === true。
 * 用于安全修复 / 云端 API 协议变更等老版本无法继续工作的场景,普通版本升级不该触发。
 */
export function MandatoryUpdateModal() {
    const { t } = useTranslation('common');
    const [state, setState] = useState({ status: 'idle' });
    useEffect(() => {
        let cancelled = false;
        window.api.updater.getState().then((s) => {
            if (!cancelled)
                setState(s);
        }).catch(() => { });
        const off = window.api.updater.onStateChanged((s) => setState(s));
        return () => {
            cancelled = true;
            off();
        };
    }, []);
    if (state.status !== 'downloaded')
        return null;
    if (!state.mandatory)
        return null;
    return (_jsx("div", { className: "fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md", children: _jsxs("div", { className: "max-w-md w-[90%] rounded-2xl border border-red-500/30 bg-zinc-900/95 p-6 shadow-2xl", role: "dialog", "aria-modal": "true", children: [_jsxs("div", { className: "flex items-center gap-3 mb-4", children: [_jsx("div", { className: "rounded-full bg-red-500/20 p-2", children: _jsx(AlertTriangle, { size: 20, className: "text-red-400" }) }), _jsx("h2", { className: "text-lg font-semibold text-white", children: t('updater.mandatoryTitle') })] }), _jsx("p", { className: "text-sm text-gray-300 leading-relaxed mb-4", children: t('updater.mandatoryDesc', { version: state.version }) }), state.releaseNotes && (_jsx("div", { className: "text-xs text-gray-400 bg-white/[0.04] rounded-lg p-3 mb-5 max-h-32 overflow-y-auto whitespace-pre-line", children: state.releaseNotes })), _jsxs("button", { type: "button", onClick: () => window.api.updater.install(), className: "w-full flex items-center justify-center gap-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 px-4 py-3 text-sm font-medium text-red-100 transition-colors", children: [_jsx(RotateCw, { size: 14 }), t('updater.mandatoryRestart')] })] }) }));
}
