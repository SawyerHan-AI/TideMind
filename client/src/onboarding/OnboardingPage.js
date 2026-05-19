import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AnimatePresence } from 'framer-motion';
import { useOnboarding, STEP_KEYS } from './OnboardingContext';
import { StepIndicator } from './components/StepIndicator';
import { WelcomeStep } from './steps/WelcomeStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { ModelStep } from './steps/ModelStep';
import { AgentStep } from './steps/AgentStep';
import { NoteSourceStep } from './steps/NoteSourceStep';
import { CloudSyncStep } from './steps/CloudSyncStep';
import { CompleteStep } from './steps/CompleteStep';
const STEP_COMPONENTS = {
    welcome: WelcomeStep,
    preferences: PreferencesStep,
    model: ModelStep,
    agent: AgentStep,
    noteSource: NoteSourceStep,
    cloudSync: CloudSyncStep,
    complete: CompleteStep,
};
export function OnboardingPage() {
    const { currentStep } = useOnboarding();
    const stepKey = STEP_KEYS[currentStep];
    const StepComponent = STEP_COMPONENTS[stepKey];
    const isEdge = stepKey === 'welcome' || stepKey === 'complete';
    return (_jsxs("div", { className: "h-screen flex flex-col", style: {
            background: [
                'radial-gradient(ellipse at 25% 15%, var(--theme-glow-1), transparent 55%)',
                'radial-gradient(ellipse at 78% 88%, var(--theme-glow-2), transparent 55%)',
                'var(--theme-bg)',
            ].join(', '),
        }, children: [_jsx("div", { className: "drag-region h-8 w-full flex-shrink-0" }), !isEdge && (_jsx("div", { className: "flex-shrink-0 px-6 py-3", children: _jsx(StepIndicator, {}) })), _jsx("div", { className: `flex-1 overflow-auto px-6 pb-8 flex items-center ${isEdge ? 'justify-center' : ''}`, children: _jsx("div", { className: "w-full", children: _jsx(AnimatePresence, { mode: "wait", children: _jsx(StepComponent, {}, stepKey) }) }) })] }));
}
