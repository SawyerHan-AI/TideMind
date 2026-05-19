import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { ExternalLink, RefreshCw, CheckCircle, AlertCircle, Download, RotateCw, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from './shared';
import { brand } from '../../lib/tokens';
export function AboutSection() {
    const { t } = useTranslation('settings');
    const [updateStatus, setUpdateStatus] = useState('idle');
    const [updateInfo, setUpdateInfo] = useState(null);
    const [updateError, setUpdateError] = useState(null);
    const [currentVersion, setCurrentVersion] = useState('0.2.66');
    const [updaterState, setUpdaterState] = useState({ status: 'idle' });
    useEffect(() => {
        window.api.app.getVersion().then((v) => setCurrentVersion(v)).catch(() => { });
    }, []);
    useEffect(() => {
        let cancelled = false;
        window.api.updater.getState().then((s) => {
            if (!cancelled)
                setUpdaterState(s);
        }).catch(() => { });
        const off = window.api.updater.onStateChanged((s) => setUpdaterState(s));
        return () => {
            cancelled = true;
            off();
        };
    }, []);
    const handleCheckUpdate = async () => {
        setUpdateStatus('checking');
        setUpdateError(null);
        // 打包模式下走自动更新流程(fire-and-forget),进度由 updaterState 反映
        void window.api.updater.checkNow().catch(() => { });
        // 同时跑传统手动查询,dev 模式下也能给反馈、生产模式作为 release notes 来源
        try {
            const info = await window.api.app.checkUpdate();
            setUpdateInfo(info);
            setUpdateStatus(info.hasUpdate ? 'available' : 'up-to-date');
        }
        catch (err) {
            setUpdateError(err.message);
            setUpdateStatus('error');
        }
    };
    const handleOpenRelease = () => {
        if (updateInfo?.releaseUrl) {
            window.api.app.openExternal(updateInfo.releaseUrl);
        }
    };
    const handleOpenLink = (url) => {
        window.api.app.openExternal(url);
    };
    const handleInstall = () => {
        window.api.updater.install().catch(() => { });
    };
    // 自动更新进行中状态优先显示
    const isAutoUpdating = updaterState.status === 'downloading' ||
        updaterState.status === 'downloaded' ||
        updaterState.status === 'signature-invalid' ||
        updaterState.status === 'staged-out';
    return (_jsxs("div", { className: "max-w-lg space-y-6", children: [_jsx(Section, { title: "Tide Mind", children: _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-400", children: t('about.version', 'Version') }), _jsx("p", { className: "text-sm text-gray-200 font-mono mt-0.5", children: updateInfo?.currentVersion ?? currentVersion })] }), !isAutoUpdating && updateStatus === 'idle' && (_jsxs("button", { onClick: handleCheckUpdate, className: "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all", style: { background: 'var(--theme-glass-bg)' }, children: [_jsx(RefreshCw, { size: 11 }), t('about.checkUpdate', 'Check for Updates')] })), !isAutoUpdating && updateStatus === 'checking' && (_jsxs("span", { className: "flex items-center gap-1.5 text-xs text-gray-400", children: [_jsx(RefreshCw, { size: 11, className: "animate-spin" }), t('about.checking', 'Checking...')] })), updaterState.status === 'downloaded' && (_jsxs("button", { onClick: handleInstall, className: "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-200 border border-emerald-500/40 hover:border-emerald-500/60 hover:bg-emerald-500/20 transition-all", style: { background: 'rgba(16,185,129,0.12)' }, children: [_jsx(RotateCw, { size: 11 }), t('about.installNow', 'Restart to update')] }))] }), updaterState.status === 'downloading' && (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between text-xs text-gray-300", children: [_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx(Download, { size: 11, className: "text-indigo-400" }), t('about.downloading', 'Downloading {{percent}}%', { percent: updaterState.percent })] }), _jsx("span", { className: "text-gray-500 font-mono text-[10px]", children: updaterState.version })] }), _jsx("div", { className: "w-full bg-white/[0.06] rounded-full h-1.5", children: _jsx("div", { className: "bg-indigo-400 h-1.5 rounded-full transition-all duration-300", style: { width: `${Math.max(2, updaterState.percent)}%` } }) })] })), updaterState.status === 'signature-invalid' && (_jsxs("div", { className: "flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10", children: [_jsx(ShieldAlert, { size: 14, className: "text-red-400 flex-shrink-0 mt-0.5" }), _jsx("div", { className: "text-xs text-red-300", children: t('about.signatureInvalid', 'Update rejected (signature invalid)') })] })), updaterState.status === 'staged-out' && (_jsxs("div", { className: "flex items-center gap-2 text-xs text-gray-400", children: [_jsx(CheckCircle, { size: 13, className: "text-gray-400" }), _jsx("span", { children: t('about.stagedOut', "New version rolling out gradually, you'll get it soon") })] })), !isAutoUpdating && updateStatus === 'up-to-date' && (_jsxs("div", { className: "flex items-center gap-2 text-emerald-400", children: [_jsx(CheckCircle, { size: 13 }), _jsx("span", { className: "text-xs", children: t('about.upToDate', 'You are on the latest version.') })] })), !isAutoUpdating && updateStatus === 'available' && updateInfo && (_jsxs("div", { className: "p-3 rounded-lg border border-indigo-400/20", style: { background: 'rgba(129,140,248,0.06)' }, children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("span", { className: "text-xs font-medium text-indigo-300", children: [t('about.newVersion', 'New version available'), ": ", updateInfo.latestVersion] }), _jsxs("button", { onClick: handleOpenRelease, className: "flex items-center gap-1 text-[10px] font-medium transition-colors", style: { color: brand.primary }, children: [_jsx(Download, { size: 10 }), t('about.downloadUpdate', 'Download')] })] }), updateInfo.releaseNotes && (_jsx("p", { className: "text-[10px] text-gray-500 leading-relaxed line-clamp-3", children: updateInfo.releaseNotes }))] })), !isAutoUpdating && updateStatus === 'error' && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(AlertCircle, { size: 13, className: "text-red-400" }), _jsx("span", { className: "text-xs text-red-400", children: t('about.checkFailed', 'Check failed. Please try again later.') }), _jsx("button", { onClick: handleCheckUpdate, className: "text-[10px] text-gray-500 hover:text-gray-300 underline transition-colors", children: t('about.retry', 'Retry') })] }))] }) }), _jsx(Section, { title: t('about.links', 'Links'), children: _jsx("div", { className: "space-y-2.5", children: [
                        { label: 'GitHub', url: 'https://github.com/SawyerHan-AI/TideMind' },
                        { label: t('about.website', 'Website'), url: 'https://tidemind.ai' },
                        { label: t('about.feedback', 'Feedback'), url: 'https://github.com/SawyerHan-AI/TideMind/issues' },
                        { label: t('about.docs', 'Documentation'), url: 'https://tidemind.ai/docs' },
                    ].map(link => (_jsxs("button", { onClick: () => handleOpenLink(link.url), className: "flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors group w-full text-left", children: [_jsx("span", { className: "flex-1", children: link.label }), _jsx(ExternalLink, { size: 10, className: "opacity-0 group-hover:opacity-100 transition-opacity" })] }, link.url))) }) }), _jsx(Section, { title: t('about.license', 'License'), children: _jsxs("div", { className: "text-xs text-gray-500 space-y-1", children: [_jsx("p", { children: "MIT License" }), _jsxs("p", { children: ["\u00A9 2024-", new Date().getFullYear(), " TideMind Contributors"] })] }) }), updateError && (_jsx("p", { className: "text-[10px] text-red-400/60", children: updateError }))] }));
}
