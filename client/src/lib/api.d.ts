export interface NodeData {
    id: string;
    /** @deprecated 双写期间保留，改用维度派生分类 */
    type: string;
    title: string | null;
    content: string;
    heat: number;
    refinement: number;
    connectivity: number;
    independence: number;
    specificity: number;
    subjectivity: number;
    actuality: number;
    source_tool: string | null;
    source_session: string | null;
    source_stream: string | null;
    source_timestamp: string | null;
    tags: string | null;
    created: string;
    last_reconsolidated: string | null;
    version: number;
    archived: number;
    is_keystone: number;
    is_crystal: number;
    is_tag: number;
    is_meta: number;
    maturity_score: number;
}
export interface LinkRelation {
    type: string;
    confidence: number;
}
export interface LinkData {
    id: string;
    from_id: string;
    to_id: string;
    relation: LinkRelation[];
    strength: number;
    note: string | null;
    auto: number;
    status: string;
    created: string;
    target_content_preview: string;
    target_title: string | null;
    target_type: string;
    direction: 'outgoing' | 'incoming';
}
export interface VersionData {
    id: number;
    node_id: string;
    version: number;
    content: string;
    change_reason: string | null;
    changed_at: string;
}
export interface OperationData {
    id: number;
    operation: string;
    input_summary: string | null;
    context: string | null;
    output_node_ids: string | null;
    tool: string | null;
    session: string | null;
    created: string;
}
export interface GateStatus {
    node_count: number;
    link_count: number;
    recall_count: number;
    features: Record<string, boolean>;
}
export interface TimelineEvent {
    id: number;
    type: 'memory' | 'think_associate' | 'think_emerge' | 'output' | 'evolution' | 'config';
    subtype: string;
    title: string;
    detail: string | null;
    node_ids: string | null;
    important: number;
    actor: 'user' | 'agent' | 'brain';
    created: string;
    source: 'timeline' | 'operation' | 'version';
}
export interface DashboardMetrics {
    totalMemories: number;
    todayDigests: number;
    todayNewLinks: number;
    todayRecalls: number;
    memoryTrend: Array<{
        date: string;
        count: number;
    }>;
    digestTrend: Array<{
        date: string;
        count: number;
    }>;
    linkTrend: Array<{
        date: string;
        count: number;
    }>;
    recallTrend: Array<{
        date: string;
        count: number;
    }>;
}
export type DashboardActivity = Array<{
    id: number;
    type: string;
    subtype: string;
    title: string;
    node_ids: string | null;
    created: string;
}>;
export type DashboardTags = Array<{
    tag: string;
    count: number;
    lastActivity: string;
    isCore: boolean;
}>;
export interface UsageData {
    operationsByType: Array<{
        operation: string;
        cnt: number;
    }>;
    dailyCounts: Array<{
        date: string;
        operation: string;
        cnt: number;
    }>;
}
export interface TokenUsageData {
    totals: {
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        estimated_cost: number;
        call_count: number;
    };
    countByOperation: Array<{
        operation: string;
        cnt: number;
        cost: number;
    }>;
    dailyByModel: Array<{
        date: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        estimated_cost: number;
    }>;
    dailyByOperation: Array<{
        date: string;
        operation: string;
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        estimated_cost: number;
    }>;
}
export interface TokenUsageFilteredData {
    operationStats: Array<{
        operation: string;
        cnt: number;
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        estimated_cost: number;
    }>;
    recentLogs: Array<{
        id: number;
        model: string;
        operation: string;
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        estimated_cost: number;
        created: string;
    }>;
    totalLogs: number;
}
export interface GraphNodeData {
    id: string;
    type: string;
    content: string;
    heat: number;
    refinement: number;
    connectivity: number;
    independence: number;
    specificity: number;
    subjectivity: number;
    actuality: number;
    is_keystone: number;
    is_crystal: number;
    is_tag: number;
    is_meta: number;
}
export interface GraphLinkData {
    id: string;
    from_id: string;
    to_id: string;
    relation: LinkRelation[];
    strength: number;
    status: string;
}
export interface StructureHole {
    nodeA: string;
    nodeB: string;
    sharedCount: number;
    nodeAPreview: string;
    nodeBPreview: string;
}
export interface AgentData {
    id: string;
    name: string;
    tool_type: string;
    archived: number;
    created: string;
    last_active: string | null;
}
export interface CloudStatusData {
    loggedIn: boolean;
    syncEnabled: boolean;
    metabolismEnabled?: boolean;
    online: boolean;
    syncing: boolean;
    outboxCount: number;
    email?: string;
    plan?: string;
    cloudNotAvailable?: boolean;
    syncNotReady?: boolean;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
    lastSyncedAt?: string | null;
    lastReconcileAt?: string | null;
    lastReconcileStatus?: string | null;
    lastReconcileError?: string | null;
    outboxDiagnostics?: CloudOutboxDiagnostics | null;
}
export interface CloudOutboxDiagnostics {
    pendingCount: number;
    deadLetterCount: number;
    oldestPendingAt: string | null;
    newestPendingAt: string | null;
    maxRetryCount: number;
    lastPendingError: string | null;
    lastDeadLetterError: string | null;
    lastDeadLetterAt: string | null;
    pendingByOperation: Array<{
        operation: string;
        count: number;
    }>;
    deadLetterByOperation: Array<{
        operation: string;
        count: number;
    }>;
}
export interface ExplorerFilter {
    search?: string;
    type?: string | null;
    heatMin?: number;
    heatMax?: number;
    createdAfter?: string;
    createdBefore?: string;
    tags?: string;
    sortBy?: string;
    sortDir?: string;
    archived?: boolean;
    limit?: number;
    offset?: number;
    /** GraphView 节点上限(按 heat DESC 取 Top-N),万节点 vault 防 d3 force O(n²) 锁死 */
    graphLimit?: number;
}
