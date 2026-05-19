export interface CloudStatus {
    loggedIn: boolean;
    email?: string | null;
    plan?: string | null;
    syncEnabled: boolean;
    online: boolean;
    syncing: boolean;
    outboxCount: number;
    lastSyncedAt?: string | null;
    cloudNotAvailable?: boolean;
    syncNotReady?: boolean;
    /** 持久化的错误码(从 syncClient 状态派生),页面切换后仍可见。 */
    lastErrorCode?: string | null;
    /** 错误的原始 message(如 `HTTP 500` / `fetch failed` 等),用于辅助诊断。 */
    lastErrorMessage?: string | null;
    /** 云代谢开关(和本地代谢互斥)。开启后本地 scheduler 停跑。 */
    metabolismEnabled?: boolean;
    /** 最近完整对齐时间(nodes 和 links 都跑完了才记)。null 表示从未对齐过。 */
    lastReconcileAt?: string | null;
    /** 'ok' | 'partial' | 'failed' | null */
    lastReconcileStatus?: string | null;
    /** 上一次对齐失败的原因 */
    lastReconcileError?: string | null;
    /** 本地 outbox/dead-letter 诊断快照。 */
    outboxDiagnostics?: {
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
    } | null;
}
export declare function useCloudStatus(): CloudStatus;
