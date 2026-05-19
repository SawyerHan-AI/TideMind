interface ToolSelectionStepProps {
    agentName: string;
    setAgentName: (value: string) => void;
    toolType: string;
    setToolType: (value: string) => void;
    customToolType: string;
    setCustomToolType: (value: string) => void;
    effectiveToolType: string;
    usePlugin: boolean;
    creating: boolean;
    onCreateAndNext: () => void;
}
export declare function ToolSelectionStep({ agentName, setAgentName, toolType, setToolType, customToolType, setCustomToolType, effectiveToolType, usePlugin, creating, onCreateAndNext, }: ToolSelectionStepProps): import("react/jsx-runtime").JSX.Element;
export {};
