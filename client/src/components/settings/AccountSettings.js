import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Cloud, Mail, LogOut, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCloudStatus } from '../../hooks/useCloudStatus';
import { Section } from './shared';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { brand, btnText } from '../../lib/tokens';
function ComingSoonTag() {
    const { t } = useTranslation();
    return (_jsx("span", { className: "text-[10px] font-medium px-2 py-0.5 rounded-full", style: { background: 'rgba(234,179,8,0.12)', color: '#facc15', border: '1px solid rgba(234,179,8,0.2)' }, children: t('settings:account.comingSoon', 'Coming Soon') }));
}
export function AccountSettings() {
    const { t } = useTranslation();
    const cloud = useCloudStatus();
    if (!cloud.loggedIn) {
        return _jsx(LoggedOutView, {});
    }
    return _jsx(LoggedInView, { cloud: cloud });
}
// ============================================================
// Logged-out: open browser for login
// ============================================================
function LoggedOutView() {
    const { t } = useTranslation();
    const handleLogin = async () => {
        const url = await window.api.cloud.loginUrl();
        window.api.app.openExternal(url);
    };
    const handleRegister = async () => {
        const url = await window.api.cloud.registerUrl();
        window.api.app.openExternal(url);
    };
    return (_jsxs("div", { className: "max-w-md mx-auto mt-8", children: [_jsxs("div", { className: "text-center mb-8", children: [_jsx("div", { className: "inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4", style: { background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.2)' }, children: _jsx(Cloud, { size: 28, style: { color: brand.primary } }) }), _jsx("h2", { className: "text-base font-semibold text-gray-100 mb-1", children: "TideMind Cloud" }), _jsx("p", { className: "text-xs text-gray-500", children: t('settings:account.loginDesc', 'Sync your external brain across devices. Never stop thinking.') })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("button", { onClick: handleLogin, className: "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all", style: {
                            background: brand.gradientAlpha,
                            border: `1px solid ${brand.secondary}4d`,
                            color: btnText.onBrand,
                        }, onMouseEnter: e => (e.currentTarget.style.background = brand.gradientHover), onMouseLeave: e => (e.currentTarget.style.background = brand.gradientAlpha), children: [_jsx(Cloud, { size: 14 }), t('settings:account.loginButton', 'Sign In')] }), _jsx("button", { onClick: handleRegister, className: "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium text-gray-400 border border-white/10 hover:border-white/20 hover:text-white transition-all", children: t('settings:account.registerButton', 'Create Account') }), _jsx("p", { className: "text-[10px] text-gray-600 text-center", children: t('settings:account.browserHint', 'Opens in your browser for secure authentication.') })] })] }));
}
// ============================================================
// Logged-in: profile, subscription, actions
// ============================================================
function LoggedInView({ cloud }) {
    const { t } = useTranslation();
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const handleLogout = async () => {
        try {
            await window.api.cloud.logout();
        }
        catch { /* ignore */ }
        setShowLogoutConfirm(false);
    };
    const handleDeleteAccount = async () => {
        // Account deletion requires contacting support for now
        // Just logout and show the support info
        await handleLogout();
        setShowDeleteConfirm(false);
    };
    const handleOpenPricing = () => {
        window.api.app.openExternal('https://tidemind.ai/pricing');
    };
    const isFree = !cloud.plan || cloud.plan === 'free';
    const planLabel = cloud.plan === 'pro_plus' ? 'Pro+' : cloud.plan === 'pro' ? 'Pro' : 'Free';
    return (_jsxs("div", { className: "space-y-6 max-w-xl", children: [_jsx(Section, { title: t('settings:account.basicInfo', 'Basic Info'), children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Mail, { size: 12, className: "text-gray-500" }), _jsx("span", { className: "text-xs text-gray-300", children: cloud.email })] }), _jsx("div", { className: "flex items-center gap-2", children: _jsx("span", { className: "text-[10px] font-medium px-2 py-0.5 rounded-full", style: {
                                    background: cloud.plan === 'free'
                                        ? 'rgba(107,114,128,0.2)'
                                        : 'rgba(129,140,248,0.15)',
                                    color: cloud.plan === 'free' ? '#9ca3af' : brand.primary,
                                    border: cloud.plan === 'free'
                                        ? '1px solid rgba(107,114,128,0.3)'
                                        : `1px solid rgba(129,140,248,0.2)`,
                                }, children: planLabel }) })] }) }), _jsx(Section, { title: t('settings:account.devices', 'Devices'), action: _jsx(ComingSoonTag, {}), children: _jsx("p", { className: "text-xs text-gray-500", children: t('settings:account.devicesComingSoon', 'Device management coming soon.') }) }), _jsx(Section, { title: t('settings:account.subscription', 'Subscription'), action: isFree ? _jsx(ComingSoonTag, {}) : undefined, children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-xs text-gray-500", children: t('settings:account.currentPlan', 'Current Plan') }), _jsx("span", { className: "text-xs text-gray-200 font-medium", children: planLabel })] }), isFree && (_jsx("p", { className: "text-xs text-gray-500", children: t('settings:account.subscriptionComingSoon', 'Pro and Pro+ plans are coming soon. Stay tuned for cloud sync, 7×24 metabolism, and more.') }))] }) }), _jsx(Section, { title: t('settings:account.billing', 'Billing'), action: _jsx(ComingSoonTag, {}), children: _jsx("p", { className: "text-xs text-gray-500", children: cloud.plan === 'free'
                        ? t('settings:account.noBilling', 'No billing history for Free plan.')
                        : t('settings:account.billingComingSoon', 'Billing history coming soon.') }) }), _jsxs("div", { className: "space-y-3 pt-2", children: [_jsxs("button", { onClick: () => setShowLogoutConfirm(true), className: "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-gray-400 border border-white/10 hover:border-white/20 hover:text-white transition-all", children: [_jsx(LogOut, { size: 12 }), t('settings:account.logout', 'Sign Out')] }), _jsxs("button", { onClick: () => setShowDeleteConfirm(true), className: "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-red-400/60 hover:text-red-400 border border-transparent hover:border-red-400/20 transition-all", children: [_jsx(Trash2, { size: 12 }), t('settings:account.requestAccountDeletion', 'Request Account Deletion')] })] }), _jsx(ConfirmDialog, { open: showLogoutConfirm, onCancel: () => setShowLogoutConfirm(false), onConfirm: handleLogout, title: t('settings:account.logoutTitle', 'Sign Out?'), description: t('settings:account.logoutDesc', 'You will be signed out of TideMind Cloud. Local data is not affected.'), confirmText: t('settings:account.logout', 'Sign Out'), cancelText: t('common:actions.cancel', 'Cancel') }), _jsx(ConfirmDialog, { open: showDeleteConfirm, onCancel: () => setShowDeleteConfirm(false), onConfirm: handleDeleteAccount, title: t('settings:account.requestDeletionTitle', 'Request Account Deletion?'), description: t('settings:account.requestDeletionDesc', 'Clicking confirm will sign you out. To permanently delete your account and all cloud data, please email support@tidemind.ai after signing out. Local data on this device is not affected.'), confirmText: t('settings:account.requestDeletionConfirm', 'Sign Out — I will email support'), cancelText: t('common:actions.cancel', 'Cancel'), danger: true })] }));
}
