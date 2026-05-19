import type { InitPreview, InitReport } from './types';
import type { NoteSourceInitSnapshot } from '../../../lib/api-contract';
/**
 * Onboarding 第 3 步：展示预览 → 启动 → 显示进度。
 *
 * 状态完全由 useInitSession 驱动，不再由父组件传 initStarted/initProgress/initError。
 * 父组件只需提供 sourceId（createAndPreview 后从 useAddNoteSourceInitialization 拿）。
 *
 * 当会话进入终态（done / aborted / error）时，调用 onTerminal——父组件据此切到下一步。
 */
export declare function AddNoteSourceInitStep({ sourceId, initPreview, onSessionStarted, onTerminal, }: {
    sourceId: string | null;
    initPreview: InitPreview | null;
    /** 会话首次进入 running 时调用一次。父组件用于标记 cleanupBeforeClose 行为分支。 */
    onSessionStarted?: () => void;
    /** 会话进入终态（done / aborted / error）时回调。 */
    onTerminal?: (snapshot: NoteSourceInitSnapshot) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function AddNoteSourceCompleteStep({ initReport, }: {
    initReport: InitReport | null;
}): import("react/jsx-runtime").JSX.Element;
