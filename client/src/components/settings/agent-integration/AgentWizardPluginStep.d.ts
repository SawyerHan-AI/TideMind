interface AgentWizardPluginStepProps {
    pluginGenerating: boolean;
    pluginError: string;
    pluginGenerated: boolean;
    pluginDir: string;
    cliAvailable: boolean;
    installing: boolean;
    installResult: {
        success: boolean;
        message: string;
    } | null;
    installCommand: string;
    codexVersion: string | null;
    geminiVersion: string | null;
    desktopConfigWritten: boolean;
    copied: string | null;
    isCowork: boolean;
    isCursor: boolean;
    isCodex: boolean;
    isWindsurf: boolean;
    isOpenClaw: boolean;
    isGemini: boolean;
    onInstallPlugin: () => void;
    onCopy: (text: string, key: string) => void;
    onPrevious: () => void;
    onNext: () => void;
}
export declare function AgentWizardPluginStep({ pluginGenerating, pluginError, pluginGenerated, pluginDir, cliAvailable, installing, installResult, installCommand, codexVersion, geminiVersion, desktopConfigWritten, copied, isCowork, isCursor, isCodex, isWindsurf, isOpenClaw, isGemini, onInstallPlugin, onCopy, onPrevious, onNext, }: AgentWizardPluginStepProps): import("react/jsx-runtime").JSX.Element;
export {};
