import type { NoteSourceInitSnapshot } from '../../../lib/api-contract';
/**
 * 与主进程 InitSessionManager 对齐的客户端 hook。
 *
 * UI 状态完全由 snapshot.status 派生——不再像旧 hook 那样硬编码 'interrupted'
 * 初值与后端真实状态脱节。
 *
 * 使用方式：
 *   const { snapshot, uiState, start, abort, discard } = useInitSession(source.id)
 *   if (uiState === 'running') { /* 显示进度条 *\/ }
 */
export type InitUiState = 'loading' | 'idle' | 'running' | 'aborting' | 'aborted' | 'error' | 'done';
interface UseInitSessionOptions {
    /** 状态进入终态时回调（用于关掉 modal、refetch 列表等） */
    onTerminal?: (snapshot: NoteSourceInitSnapshot) => void;
    /**
     * 轮询间隔，毫秒。设 0 禁用轮询。
     * 默认 5000——主要靠 onSessionEvent 推送实时更新；轮询只作为兜底，
     * 防止丢失事件（窗口刚 mount 时、推送通道意外断开等场景）。
     */
    pollIntervalMs?: number;
}
export declare function useInitSession(sourceId: string | null, options?: UseInitSessionOptions): {
    snapshot: NoteSourceInitSnapshot | null;
    uiState: InitUiState;
    aborting: boolean;
    discarding: boolean;
    start: () => void;
    abort: () => Promise<void>;
    discard: () => Promise<void>;
    refresh: () => Promise<NoteSourceInitSnapshot | null>;
};
export {};
