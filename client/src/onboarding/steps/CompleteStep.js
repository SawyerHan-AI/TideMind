import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { CheckCircle, SkipForward, Cpu, Plug, BookOpen, Palette } from 'lucide-react';
import { useOnboarding } from '../OnboardingContext';
export function CompleteStep() {
    const { t } = useTranslation('onboarding');
    const { modelConfigured, agentConfigured, noteSourceConfigured, finish, goBack } = useOnboarding();
    const items = [
        { label: t('complete.preferencesLabel'), done: true, Icon: Palette },
        { label: t('complete.modelLabel'), done: modelConfigured, Icon: Cpu },
        { label: t('complete.agentLabel'), done: agentConfigured, Icon: Plug },
        { label: t('complete.noteSourceLabel'), done: noteSourceConfigured, Icon: BookOpen },
    ];
    return (_jsxs(motion.div, { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4 }, className: "max-w-md mx-auto text-center", children: [_jsx("h1", { className: "text-2xl font-semibold text-white mb-2", children: t('complete.title') }), _jsx("p", { className: "text-sm text-gray-400 mb-8", children: t('complete.subtitle') }), _jsx("div", { className: "glass-card rounded-2xl p-5 mb-8 text-left space-y-3", children: items.map(({ label, done, Icon }) => (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: `w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${done ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-gray-500'}`, children: _jsx(Icon, { size: 14 }) }), _jsx("span", { className: "text-sm text-white flex-1", children: label }), done ? (_jsxs("span", { className: "flex items-center gap-1 text-xs text-emerald-400", children: [_jsx(CheckCircle, { size: 12 }), t('complete.configured')] })) : (_jsxs("span", { className: "flex items-center gap-1 text-xs text-gray-500", children: [_jsx(SkipForward, { size: 12 }), t('complete.skipped')] }))] }, label))) }), _jsxs("div", { className: "flex items-center justify-center gap-3", children: [_jsx("button", { onClick: goBack, className: "px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors", children: t('nav.back') }), _jsx("button", { onClick: finish, className: "px-8 py-3 text-sm font-medium text-white rounded-xl transition-all duration-200 hover:brightness-110 hover:scale-[1.02]", style: {
                            background: 'linear-gradient(135deg, #818cf8, #a78bfa)',
                            boxShadow: '0 4px 20px rgba(129,140,248,0.3)',
                        }, children: t('complete.enter') })] })] }));
}
