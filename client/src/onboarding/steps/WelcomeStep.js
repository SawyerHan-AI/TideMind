import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useOnboarding } from '../OnboardingContext';
import logoSrc from '../../assets/logo@3x.png';
export function WelcomeStep() {
    const { goNext } = useOnboarding();
    const { t } = useTranslation('onboarding');
    return (_jsxs(motion.div, { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4 }, className: "flex flex-col items-center justify-center text-center max-w-lg mx-auto", children: [_jsx("img", { src: logoSrc, alt: "Tide Mind", className: "w-20 h-20 rounded-2xl mb-8", style: {
                    boxShadow: '0 8px 40px rgba(129,140,248,0.2)',
                } }), _jsx("h1", { className: "text-3xl font-bold text-white mb-3", children: t('welcome.title') }), _jsx("p", { className: "text-base text-gray-300 mb-3", children: t('welcome.subtitle') }), t('welcome.description') && (_jsx("p", { className: "text-sm text-gray-500 leading-relaxed mb-3", children: t('welcome.description') })), _jsx("div", { className: "mb-10" }), _jsx("button", { onClick: goNext, className: "px-8 py-3 text-sm font-medium text-white rounded-xl transition-all duration-200 hover:brightness-110 hover:scale-[1.02]", style: {
                    background: 'linear-gradient(135deg, #818cf8, #a78bfa)',
                    boxShadow: '0 4px 20px rgba(129,140,248,0.3)',
                }, children: t('welcome.start') })] }));
}
