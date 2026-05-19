import type { InitPreview, InitReport } from './types';
interface CreateAndPreviewArgs {
    name: string;
    toolType: string;
    path: string;
}
interface UseAddNoteSourceInitializationArgs {
    onInitStep: () => void;
}
/**
 * Onboarding 创建笔记源 + 拉取初始化预览。
 *
 * **不**再管理 init 进度状态——init 进度由 useInitSession 接管。
 * 本 hook 只负责：
 *   1. 调 noteSources.create 创建笔记源行（拿到 sourceId）
 *   2. 调 noteSources.initPreview 拿预览数据
 *   3. 切到 step 2（init step）
 *
 * onboarding 关闭时（cleanupBeforeClose）：
 *   - 若 init 已启动 → **不**自动 abort（D1：会话不绑死 onboarding 生命周期）
 *   - 若 init 未启动且笔记源已创建 → rollback 删除空壳
 */
export declare function useAddNoteSourceInitialization({ onInitStep, }: UseAddNoteSourceInitializationArgs): {
    createdSourceId: string | null;
    initPreview: InitPreview | null;
    initStarted: boolean;
    initReport: InitReport | null;
    createAndPreview: ({ name, toolType, path, }: CreateAndPreviewArgs) => Promise<void>;
    markInitStarted: () => void;
    onSessionTerminal: (status: "done" | "aborted" | "error", report: Record<string, unknown> | null | undefined) => void;
    cleanupBeforeClose: () => Promise<boolean>;
};
export {};
