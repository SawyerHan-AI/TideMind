import type { AppleNotesAccount, NoteSourceTestResult, PermissionCheckResult } from './types';
export declare function AddNoteSourceToolStep({ toolType, name, onToolTypeChange, onNameChange, }: {
    toolType: string;
    name: string;
    onToolTypeChange: (toolType: string) => void;
    onNameChange: (name: string) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function AddNoteSourceConnectionStep({ toolType, selectedPath, testResult, testing, permissionResult, checkingPermission, appleAccounts, selectedAccountZpks, loadingAccounts, onNotionTokenChange, onTestNotion, onSelectFolder, onCheckAppleNotesPermission, onToggleAccount, }: {
    toolType: string;
    selectedPath: string;
    testResult: NoteSourceTestResult | null;
    testing: boolean;
    permissionResult: PermissionCheckResult | null;
    checkingPermission: boolean;
    appleAccounts: AppleNotesAccount[];
    selectedAccountZpks: Set<number>;
    loadingAccounts: boolean;
    onNotionTokenChange: (token: string) => void;
    onTestNotion: () => void;
    onSelectFolder: () => void;
    onCheckAppleNotesPermission: () => void;
    onToggleAccount: (zpk: number) => void;
}): import("react/jsx-runtime").JSX.Element;
