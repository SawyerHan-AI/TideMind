import type { AgentData, CloudStatusData, DashboardActivity, DashboardMetrics, DashboardTags, ExplorerFilter, GateStatus, GraphLinkData, GraphNodeData, LinkData, NodeData, OperationData, StructureHole, TimelineEvent, TokenUsageData, TokenUsageFilteredData, UsageData, VersionData } from './api';
export type PluginClientType = 'claude-code' | 'cowork' | 'cursor' | 'codex' | 'windsurf' | 'openclaw' | 'gemini';
export type UpdaterState = {
    status: 'idle';
} | {
    status: 'checking';
} | {
    status: 'up-to-date';
    version: string;
} | {
    status: 'available';
    version: string;
    releaseNotes?: string;
    mandatory: boolean;
} | {
    status: 'downloading';
    version: string;
    percent: number;
    transferred: number;
    total: number;
} | {
    status: 'downloaded';
    version: string;
    releaseNotes?: string;
    mandatory: boolean;
} | {
    status: 'error';
    message: string;
} | {
    status: 'signature-invalid';
    version: string;
    releaseUrl?: string;
} | {
    status: 'staged-out';
    version: string;
};
/**
 * 笔记源初始化会话快照（与主进程 InitSessionSnapshot 对齐）。
 * 不在主进程类型基础上 import，是因为 client/electron 与 client/src 的 tsconfig
 * 边界不同；保持文档一致即可。
 */
export type NoteSourceInitStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'error' | 'done';
export type NoteSourceInitAbortReason = 'user' | 'stuck' | 'navigation' | 'shutdown';
export interface NoteSourceInitSnapshot {
    sourceId: string;
    toolType: 'logseq' | 'obsidian' | 'apple-notes' | 'notion';
    status: NoteSourceInitStatus;
    progress: {
        phase: number;
        phaseName: string;
        current: number;
        total: number;
        startedAt: string | null;
    };
    error: string | null;
    abortReason: NoteSourceInitAbortReason | null;
    report: Record<string, unknown> | null;
    canStart: boolean;
    canAbort: boolean;
    canDiscard: boolean;
}
export interface LLMHealthSnapshot {
    /** 'closed' = LLM 工作正常; 'open' = 熔断中（冷却到期前跳过 LLM 任务）; 'half-open' = 冷却到期，准备放探测任务 */
    circuitState: 'closed' | 'open' | 'half-open';
    /** 当前累计连续失败次数（成功后清零） */
    failures: number;
    /** 熔断器打开时间戳（ms）；未打开时为 0 */
    openedAt: number;
    /** 当前熔断器冷却时长（ms） */
    cooldownMs: number;
    /** 上次 LLM 调用成功的时间戳（ms）；从未成功过为 0 */
    lastSuccessAt: number;
    /** 上次失败错误消息（截断 500 字符）；从未失败为 null */
    lastError: string | null;
    /** 上次失败时间戳（ms）；从未失败为 0 */
    lastErrorAt: number;
}
export interface PluginStatusResult {
    exists: boolean;
    clientType?: PluginClientType;
    pluginDir?: string;
    tools?: string[];
    skillFile?: string;
    generatedAt?: string;
    skillOutdated?: boolean;
    skillOutputPath?: string;
    skillOutputExists?: boolean;
    desktopConfigWritten?: boolean;
    cursorConfigWritten?: boolean;
    codexConfigWritten?: boolean;
    windsurfConfigWritten?: boolean;
    openclawConfigWritten?: boolean;
    hooksConfigured?: boolean;
    skillDirWritten?: boolean;
    stagingExists?: boolean;
    installedExists?: boolean;
    registered?: boolean | null;
}
export interface AppApi {
    onDataChanged: (callback: (payload: {
        scopes: string[];
    }) => void) => () => void;
    nodes: {
        list: (filter: ExplorerFilter) => Promise<{
            nodes: NodeData[];
            total: number;
        }>;
        get: (id: string) => Promise<{
            node: NodeData;
            links: LinkData[];
            versions: VersionData[];
        } | null>;
        search: (query: string, limit?: number) => Promise<{
            nodes: NodeData[];
            total: number;
        }>;
        tags: () => Promise<Array<{
            tag: string;
            count: number;
            isCore: boolean;
        }>>;
        promoteTag: (tag: string) => Promise<void>;
        demoteTag: (tag: string) => Promise<void>;
        graph: (filter: ExplorerFilter) => Promise<{
            nodes: GraphNodeData[];
            links: GraphLinkData[];
        }>;
        path: (fromId: string, toId: string) => Promise<{
            path: string[];
        }>;
        structureHoles: (limit?: number) => Promise<StructureHole[]>;
    };
    links: {
        rejectTag: (linkId: string) => Promise<{
            success: boolean;
            tagName: string;
        }>;
        undoRejectTag: (linkId: string) => Promise<{
            success: boolean;
        }>;
    };
    stats: {
        overview: () => Promise<{
            totalNodes: number;
            byType: Array<{
                type: string;
                cnt: number;
            }>;
            byTag: Array<{
                tag: string;
                cnt: number;
            }>;
            linkCount: number;
            recallCount: number;
            recentCounts: Array<{
                date: string;
                count: number;
            }>;
            linksByRelation: Array<{
                relation: string;
                cnt: number;
            }>;
            linksByStatus: {
                confirmed: number;
                pending: number;
            };
            reconsolidateCount: number;
            avgVersion: number;
        }>;
        gates: () => Promise<GateStatus>;
        maintenance: () => Promise<{
            lastDaily: string | null;
            lastWeekly: string | null;
            lastLearning2: string | null;
            lastLearning3: string | null;
            lastL3ReportId: string | null;
        }>;
        evolution: () => Promise<{
            learning2_ready: boolean;
            learning3_ready: boolean;
            nodeCount: number;
            recallCount: number;
            feedbackCount: number;
            feedbackByStrategy: Array<{
                strategy: string;
                avg_signal: number;
                cnt: number;
            }>;
            activeTests: Array<{
                strategy: string;
                status: string;
                variant_id: string;
                testing_operations: number;
            }>;
        }>;
        dashboardMetrics: () => Promise<DashboardMetrics>;
        dashboardActivity: () => Promise<DashboardActivity>;
        dashboardTags: () => Promise<DashboardTags>;
        usage: () => Promise<UsageData>;
        tokenUsage: () => Promise<TokenUsageData>;
        tokenUsageFiltered: (filter: {
            after?: string;
            before?: string;
            limit?: number;
            offset?: number;
        }) => Promise<TokenUsageFilteredData>;
    };
    operations: {
        list: (filter: {
            limit?: number;
            offset?: number;
            operation?: string;
        }) => Promise<{
            operations: OperationData[];
            total: number;
        }>;
        get: (id: number) => Promise<{
            operation: OperationData;
            nodes: NodeData[];
        } | null>;
    };
    stream: {
        dates: () => Promise<string[]>;
        get: (date: string) => Promise<string>;
    };
    config: {
        get: () => Promise<Record<string, unknown>>;
        update: (patch: Record<string, unknown>) => Promise<void>;
        strategies: () => Promise<Array<{
            name: string;
            path: string;
        }>>;
        strategyContent: (name: string) => Promise<string>;
        strategyUpdate: (name: string, content: string, reason?: string) => Promise<void>;
        strategyParams: (name: string) => Promise<Record<string, number | string | boolean>>;
        strategyParamUpdate: (name: string, key: string, value: string) => Promise<void>;
        strategyVersions: (name: string) => Promise<Array<{
            version: number;
            content: string;
            change_reason: string | null;
            changed_by: string;
            created: string;
        }>>;
        strategyRollback: (name: string, version: number) => Promise<void>;
        userPromptContent: (name: string) => Promise<string>;
        userPromptUpdate: (name: string, content: string, reason?: string) => Promise<void>;
        userPromptVersions: (name: string) => Promise<Array<{
            version: number;
            content: string;
            change_reason: string | null;
            changed_by: string;
            created: string;
        }>>;
        userPromptRollback: (name: string, version: number) => Promise<void>;
        mcpCommand: () => Promise<string>;
        mcpDescriptions: () => Promise<Record<string, string>>;
        mcpDescriptionsUpdate: (descriptions: Record<string, string>, changedTool?: string) => Promise<void>;
        mcpDescriptionVersions: (toolName: string) => Promise<Array<{
            version: number;
            content: string;
            change_reason: string | null;
            changed_by: string;
            created: string;
        }>>;
        mcpDescriptionRollback: (toolName: string, version: number) => Promise<void>;
        skills: () => Promise<Array<{
            name: string;
            path: string;
        }>>;
        skillContent: (name: string) => Promise<string>;
        skillUpdate: (name: string, content: string, reason?: string) => Promise<void>;
        skillVersions: (name: string) => Promise<Array<{
            version: number;
            content: string;
            change_reason: string | null;
            changed_by: string;
            created: string;
        }>>;
        skillRollback: (name: string, version: number) => Promise<void>;
        selectFolder: () => Promise<string | null>;
    };
    health: {
        ollama: () => Promise<{
            online: boolean;
            models?: string[];
        }>;
        anthropic: () => Promise<{
            configured: boolean;
        }>;
        anthropicModels: () => Promise<{
            models: string[];
            error?: string;
        }>;
        vertex: () => Promise<{
            configured: boolean;
            projectId: string;
            region: string;
            hasCredentials: boolean;
        }>;
        vertexModels: () => Promise<{
            models: string[];
            error?: string;
        }>;
        logseq: () => Promise<{
            accessible: boolean;
            fileCount: number;
            path: string;
        }>;
        obsidian: () => Promise<{
            accessible: boolean;
            fileCount: number;
            path: string;
        }>;
        geminiEmbedding: () => Promise<{
            online: boolean;
            error?: string;
        }>;
        geminiModels: () => Promise<{
            models: string[];
            error?: string;
        }>;
        storage: () => Promise<{
            path: string;
            dbSize: number;
            streamFiles: number;
        }>;
    };
    credentials: {
        pickVertexFile: () => Promise<{
            success: boolean;
            projectId?: string;
            error?: string;
        }>;
        vertexStatus: () => Promise<{
            configured: boolean;
            projectId?: string;
        }>;
    };
    embedding: {
        reembedStatus: () => Promise<{
            needed: boolean;
            running: boolean;
            done: number;
            total: number;
        }>;
        triggerReembed: () => Promise<{
            success: boolean;
            error?: string;
        }>;
    };
    write: {
        editNode: (nodeId: string, newContent: string, newTitle: string | null, reason: string) => Promise<{
            success: boolean;
            newVersion?: number;
            newNodeId?: string;
            error?: string;
        }>;
        archiveNode: (nodeId: string) => Promise<{
            success: boolean;
        }>;
        deleteLink: (linkId: string) => Promise<{
            success: boolean;
        }>;
        submitFeedback: (strategyName: string, signal: number) => Promise<{
            success: boolean;
        }>;
        listArchived: (opts?: {
            limit?: number;
            offset?: number;
        }) => Promise<{
            nodes: NodeData[];
            total: number;
        }>;
        unarchiveNode: (nodeId: string) => Promise<{
            success: boolean;
        }>;
        reArchiveNode: (nodeId: string) => Promise<{
            success: boolean;
        }>;
    };
    timeline: {
        list: (filter: {
            types?: string[];
            actors?: string[];
            limit?: number;
            offset?: number;
            after?: string;
            before?: string;
        }) => Promise<{
            events: TimelineEvent[];
            total: number;
        }>;
        get: (id: number, source: string) => Promise<unknown>;
        resolveNodes: (nodeIds: string[]) => Promise<Record<string, NodeData>>;
    };
    export: {
        markdown: (scope: {
            tag?: string;
            after?: string;
            before?: string;
        }) => Promise<string>;
        json: (scope: {
            tag?: string;
            after?: string;
            before?: string;
        }) => Promise<unknown>;
        saveFile: (content: string, defaultName: string) => Promise<{
            saved: boolean;
            path?: string;
        }>;
    };
    connections: {
        list: (includeArchived?: boolean) => Promise<Array<{
            id: string;
            name: string;
            provider_type: string;
            credentials: string;
            status: string;
            available_models: string | null;
            last_checked: string | null;
            archived: number;
            created: string;
        }>>;
        get: (id: string) => Promise<{
            id: string;
            name: string;
            provider_type: string;
            credentials: string;
            status: string;
            available_models: string | null;
            last_checked: string | null;
            archived: number;
            created: string;
        } | null>;
        getCredentials: (id: string) => Promise<Record<string, string>>;
        create: (params: {
            name: string;
            provider_type: string;
            credentials?: Record<string, unknown>;
        }) => Promise<{
            id: string;
            name: string;
            provider_type: string;
            credentials: string;
            status: string;
            available_models: string | null;
            last_checked: string | null;
            archived: number;
            created: string;
        }>;
        update: (id: string, params: {
            name?: string;
            credentials?: Record<string, unknown>;
        }) => Promise<void>;
        archive: (id: string) => Promise<void>;
        unarchive: (id: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
        test: (connectionId: string) => Promise<{
            online: boolean;
            models: string[];
            error?: string;
            region?: string;
        }>;
        pickVertexFile: (connectionId: string) => Promise<{
            success: boolean;
            projectId?: string;
            error?: string;
        }>;
        vertexCredStatus: (connectionId: string) => Promise<{
            configured: boolean;
            projectId?: string;
        }>;
    };
    noteSources: {
        list: (includeArchived?: boolean) => Promise<Array<{
            id: string;
            name: string;
            tool_type: string;
            path: string;
            poll_interval: number;
            archived: number;
            initialized: number;
            created: string;
            last_synced: string | null;
        }>>;
        create: (params: {
            name: string;
            toolType: string;
            path: string;
            pollInterval?: number;
        }) => Promise<{
            id: string;
        }>;
        update: (id: string, updates: {
            name?: string;
            path?: string;
            pollInterval?: number;
        }) => Promise<void>;
        archive: (id: string) => Promise<void>;
        unarchive: (id: string) => Promise<void>;
        test: (toolType: string, path: string) => Promise<{
            accessible: boolean;
            fileCount: number;
        }>;
        stats: (id: string) => Promise<{
            fileCount: number;
            nodeCount: number;
            lastSynced: string | null;
            syncing?: boolean;
            accessible?: boolean;
        }>;
        initPreview: (id: string) => Promise<{
            success: boolean;
            data?: {
                totalFiles?: number;
                breakdown?: Array<{
                    label: string;
                    count: number;
                }>;
                estimatedNodes?: number;
                estimatedCost?: {
                    total: number;
                };
            };
            error?: string;
        }>;
        initStart: (id: string) => Promise<{
            success: boolean;
            data?: {
                nodesCreated?: number;
                linksCreated?: number;
                crystalsCreated?: number;
                totalFiles?: number;
                durationMs?: number;
                totalCost?: number;
            };
            error?: string;
        }>;
        /** 完整初始化会话快照。logseq 走 SessionManager 真实快照；其他 tool 由旧 progress 转换。 */
        initSnapshot: (id: string) => Promise<NoteSourceInitSnapshot | null>;
        initAbort: (id: string) => Promise<{
            success: boolean;
            snapshot?: NoteSourceInitSnapshot;
        }>;
        /**
         * 订阅会话状态变化（每次 transition / progress 都会推送）。
         * snapshot 参数类型为 unknown，调用方需断言为 NoteSourceInitSnapshot。
         * 这是 IPC 边界的常见模式：preload 接收来自主进程的任意 payload，
         * 编译期无法保证形状一致。
         */
        onSessionEvent: (cb: (snapshot: unknown) => void) => () => void;
        rollback: (id: string) => Promise<void>;
        importStatus: (id: string) => Promise<unknown>;
        triggerImport: (id: string) => Promise<{
            success: boolean;
            error?: string;
        }>;
        appleNotesCheckPermission: () => Promise<{
            accessible: boolean;
            path: string;
            error?: string;
        }>;
        appleNotesListAccounts: () => Promise<Array<{
            zpk: number;
            name: string;
            uuid: string;
            userRecordName: string | null;
            noteCount: number;
        }>>;
    };
    cloud: {
        login: (email: string, password: string) => Promise<{
            success: boolean;
            error?: string;
        }>;
        logout: () => Promise<void>;
        status: () => Promise<CloudStatusData>;
        setSyncEnabled: (enabled: boolean) => Promise<{
            success: boolean;
            error?: string;
            errorDetail?: string;
        }>;
        setMetabolismEnabled: (enabled: boolean) => Promise<{
            success: boolean;
            error?: string;
            errorDetail?: string;
        }>;
        forceReconcile: () => Promise<{
            success: boolean;
            error?: string;
        }>;
        abortReconcile: () => Promise<{
            success: boolean;
            error?: string;
        }>;
        triggerSync: () => Promise<{
            success: boolean;
            error?: string;
            errorDetail?: string;
        }>;
        onReconcileProgress: (cb: (progress: unknown) => void) => () => void;
        outboxCount: () => Promise<number>;
        loginUrl: () => Promise<string>;
        registerUrl: () => Promise<string>;
    };
    app: {
        getVersion: () => Promise<string>;
        openExternal: (url: string) => Promise<void>;
        checkUpdate: () => Promise<{
            hasUpdate: boolean;
            currentVersion: string;
            latestVersion: string;
            releaseUrl: string | null;
            releaseNotes: string | null;
            publishedAt: string | null;
        }>;
    };
    updater: {
        getState: () => Promise<UpdaterState>;
        checkNow: () => Promise<void>;
        install: () => Promise<void>;
        getChannel: () => Promise<'stable' | 'beta'>;
        setChannel: (channel: 'stable' | 'beta') => Promise<void>;
        onStateChanged: (cb: (state: UpdaterState) => void) => () => void;
    };
    llm: {
        getHealth: () => Promise<LLMHealthSnapshot>;
        onHealthChanged: (cb: (h: LLMHealthSnapshot) => void) => () => void;
    };
    agents: {
        list: (includeArchived?: boolean) => Promise<AgentData[]>;
        create: (params: {
            name: string;
            tool_type: string;
        }) => Promise<AgentData>;
        update: (id: string, params: {
            name?: string;
            tool_type?: string;
        }) => Promise<void>;
        archive: (id: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
        unarchive: (id: string) => Promise<void>;
        stats: () => Promise<Array<{
            id: string;
            digest_count: number;
            recall_count: number;
            prepare_count: number;
        }>>;
        mcpSnippet: (agentId: string) => Promise<string>;
        generatePlugin: (params: {
            agentId: string;
            agentName: string;
            clientType?: string;
        }) => Promise<{
            success: boolean;
            pluginDir: string;
            pluginName: string;
            marketplaceRegistered: boolean;
            pluginsDir?: string;
            error?: string;
        }>;
        checkCli: (cli: string) => Promise<{
            available: boolean;
            path?: string;
            version?: string;
        }>;
        installPlugin: (pluginName: string) => Promise<{
            success: boolean;
            error?: string;
        }>;
        pluginPath: (agentId: string, toolType?: string) => Promise<string | null>;
        uninstallPlugin: (agentId: string, toolType?: string) => Promise<{
            success: boolean;
            error?: string;
        }>;
        pluginStatus: (agentId: string, toolType?: string) => Promise<PluginStatusResult>;
    };
}
