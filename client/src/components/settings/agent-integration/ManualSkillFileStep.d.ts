import type { ToolTypeDef } from './toolTypes';
interface ManualSkillFileStepProps {
    toolDef?: ToolTypeDef;
    skillContent: string;
    skillLoaded: boolean;
    usingBaseFallback: boolean;
    copied: string | null;
    onCopy: (text: string, key: string) => void;
    onPrevious: () => void;
    onNext: () => void;
}
export declare function ManualSkillFileStep({ toolDef, skillContent, skillLoaded, usingBaseFallback, copied, onCopy, onPrevious, onNext, }: ManualSkillFileStepProps): import("react/jsx-runtime").JSX.Element;
export {};
