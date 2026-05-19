export interface NoteSource {
    id: string;
    name: string;
    tool_type: string;
    path: string;
    poll_interval: number;
    archived: number;
    initialized: number;
    created: string;
    last_synced: string | null;
}
export interface NoteSourceStat {
    fileCount: number;
    nodeCount: number;
    lastSynced: string | null;
    syncing?: boolean;
    accessible?: boolean;
}
export interface ToolTypeDef {
    id: string;
    label: string;
    icon: React.ReactNode;
    comingSoon?: boolean;
}
export interface NoteSourceTestResult {
    accessible: boolean;
    fileCount: number;
}
export interface AppleNotesAccount {
    zpk: number;
    name: string;
    uuid: string;
    userRecordName: string | null;
    noteCount: number;
}
export interface PermissionCheckResult {
    accessible: boolean;
    path: string;
    error?: string;
}
export interface InitProgress {
    phase: number;
    phaseName: string;
    current: number;
    total: number;
    status: string;
    error?: string;
}
export interface InitPreview {
    totalFiles?: number;
    breakdown?: Array<{
        label: string;
        count: number;
    }>;
    estimatedNodes?: number;
    estimatedCost?: {
        total: number;
    };
}
export interface InitReport {
    nodesCreated?: number;
    linksCreated?: number;
    crystalsCreated?: number;
    totalFiles?: number;
    durationMs?: number;
    totalCost?: number;
}
