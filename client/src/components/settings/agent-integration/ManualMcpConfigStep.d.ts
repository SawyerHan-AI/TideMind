import type { ToolTypeDef } from './toolTypes';
interface ManualMcpConfigStepProps {
    toolDef?: ToolTypeDef;
    mcpSnippet: string;
    copied: string | null;
    onCopy: (text: string, key: string) => void;
    onPrevious: () => void;
    onNext: () => void;
}
export declare function ManualMcpConfigStep({ toolDef, mcpSnippet, copied, onCopy, onPrevious, onNext, }: ManualMcpConfigStepProps): import("react/jsx-runtime").JSX.Element;
export {};
