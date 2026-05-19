import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { useOnboarding, STEP_KEYS } from '../OnboardingContext';
export function StepIndicator() {
    const { currentStep } = useOnboarding();
    const { t } = useTranslation('onboarding');
    return (_jsx("div", { className: "flex items-center justify-center gap-1", children: STEP_KEYS.map((key, i) => {
            const isActive = i === currentStep;
            const isDone = i < currentStep;
            return (_jsxs("div", { className: "flex items-center gap-1", children: [i > 0 && (_jsx("div", { className: `w-6 h-px transition-colors duration-300 ${isDone ? 'bg-indigo-400/60' : 'bg-white/10'}` })), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("div", { className: `w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium transition-all duration-300 ${isActive
                                    ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/30'
                                    : isDone
                                        ? 'bg-indigo-400/20 text-indigo-400'
                                        : 'bg-white/[0.06] text-gray-500'}`, children: isDone ? _jsx(Check, { size: 10 }) : i + 1 }), _jsx("span", { className: `text-[11px] transition-colors duration-300 hidden sm:inline ${isActive ? 'text-white font-medium' : isDone ? 'text-gray-400' : 'text-gray-600'}`, children: t(`steps.${key}`) })] })] }, key));
        }) }));
}
