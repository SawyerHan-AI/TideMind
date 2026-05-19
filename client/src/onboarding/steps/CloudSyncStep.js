import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { Cloud, Monitor, MessageCircle, Zap } from 'lucide-react';
import { StepContainer } from '../components/StepContainer';
export function CloudSyncStep() {
    const { t } = useTranslation('onboarding');
    const benefits = [
        { Icon: Monitor, text: t('cloudSync.benefitDevices', 'Sync across all your devices') },
        { Icon: MessageCircle, text: t('cloudSync.benefitChatGPT', 'ChatGPT integration via browser extension') },
        { Icon: Zap, text: t('cloudSync.benefitMetabolism', 'Never-stop background metabolism') },
    ];
    return (_jsx(StepContainer, { title: t('cloudSync.title'), description: t('cloudSync.description'), skippable: true, children: _jsxs("div", { className: "space-y-6", children: [_jsx("div", { className: "space-y-3", children: benefits.map(({ Icon, text }) => (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", style: { background: 'rgba(129,140,248,0.12)' }, children: _jsx(Icon, { size: 14, className: "text-indigo-400" }) }), _jsx("span", { className: "text-sm text-gray-300", children: text })] }, text))) }), _jsx("div", { className: "flex justify-center py-4", children: _jsx("div", { className: "w-20 h-20 rounded-2xl flex items-center justify-center", style: {
                            background: 'rgba(129,140,248,0.08)',
                            border: '1px solid rgba(129,140,248,0.15)',
                            boxShadow: '0 8px 40px rgba(129,140,248,0.1)',
                        }, children: _jsx(Cloud, { size: 32, className: "text-indigo-400" }) }) }), _jsx("p", { className: "text-xs text-gray-500 text-center leading-relaxed", children: t('cloudSync.info', 'Cloud sync is optional. Your local brain works perfectly on its own. You can connect to the cloud anytime in Settings.') })] }) }));
}
