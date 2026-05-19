import { type ReactNode } from 'react';
export interface OnboardingState {
    currentStep: number;
    modelConfigured: boolean;
    agentConfigured: boolean;
    noteSourceConfigured: boolean;
}
interface OnboardingContextValue extends OnboardingState {
    totalSteps: number;
    goNext: () => void;
    goBack: () => void;
    goTo: (step: number) => void;
    setModelConfigured: (v: boolean) => void;
    setAgentConfigured: (v: boolean) => void;
    setNoteSourceConfigured: (v: boolean) => void;
    finish: () => Promise<void>;
}
export declare const STEP_KEYS: readonly ["welcome", "preferences", "model", "agent", "noteSource", "cloudSync", "complete"];
export type StepKey = (typeof STEP_KEYS)[number];
export declare function OnboardingProvider({ children, onFinish }: {
    children: ReactNode;
    onFinish: () => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function useOnboarding(): OnboardingContextValue;
export {};
