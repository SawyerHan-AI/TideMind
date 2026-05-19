import type { Agent } from './types';
import type { PluginVerifyMcpMeta } from './toolTypes';
interface AgentWizardVerifyStepProps {
    createdAgent: Agent;
    usePlugin: boolean;
    pluginGenerated: boolean;
    desktopConfigWritten: boolean;
    pluginToolLabel: string;
    pluginVerifyMcp?: PluginVerifyMcpMeta;
    isManual: boolean;
    onPrevious: () => void;
    onClose: () => void;
}
export declare function AgentWizardVerifyStep({ createdAgent, usePlugin, pluginGenerated, desktopConfigWritten, pluginToolLabel, pluginVerifyMcp, isManual, onPrevious, onClose, }: AgentWizardVerifyStepProps): import("react/jsx-runtime").JSX.Element;
export {};
