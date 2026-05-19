import { useCallback, useEffect, useRef, useState } from 'react';
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
export function useAddNoteSourceInitialization({ onInitStep, }) {
    const [createdSourceId, setCreatedSourceId] = useState(null);
    const [initPreview, setInitPreview] = useState(null);
    const [initStarted, setInitStarted] = useState(false);
    const [initReport, setInitReport] = useState(null);
    const cancelledRef = useRef(false);
    useEffect(() => {
        return () => {
            cancelledRef.current = true;
        };
    }, []);
    const createAndPreview = useCallback(async ({ name, toolType, path, }) => {
        cancelledRef.current = false;
        setInitPreview(null);
        setInitStarted(false);
        setInitReport(null);
        const source = await window.api.noteSources.create({
            name: name.trim(),
            toolType,
            path,
        });
        if (cancelledRef.current)
            return;
        setCreatedSourceId(source.id);
        onInitStep();
        try {
            const res = await window.api.noteSources.initPreview(source.id);
            if (cancelledRef.current)
                return;
            if (res.success) {
                setInitPreview(res.data ?? null);
            }
        }
        catch { /* ignore — UI will show "scanning" 然后再次 retry */ }
    }, [onInitStep]);
    /**
     * 标记 init 已启动（由 AddNoteSourceInitStep 在 useInitSession 切到 running 时回调）。
     * 用于 cleanupBeforeClose 判断是否要保留会话。
     */
    const markInitStarted = useCallback(() => {
        setInitStarted(true);
    }, []);
    /**
     * 接住会话终态：若是 done，写入 report 让 step 3 能展示。
     */
    const onSessionTerminal = useCallback((status, report) => {
        if (status === 'done' && report) {
            setInitReport(report);
        }
    }, []);
    const cleanupBeforeClose = useCallback(async () => {
        cancelledRef.current = true;
        // 若 init 已启动 → 留给设置页接管，不弹 confirm 不 abort
        if (initStarted) {
            return true;
        }
        // 若笔记源已创建但 init 未启动 → rollback 删空壳
        if (createdSourceId && !initReport) {
            try {
                await window.api.noteSources.rollback(createdSourceId);
            }
            catch { /* ignore */ }
        }
        return true;
    }, [createdSourceId, initReport, initStarted]);
    return {
        createdSourceId,
        initPreview,
        initStarted,
        initReport,
        createAndPreview,
        markInitStarted,
        onSessionTerminal,
        cleanupBeforeClose,
    };
}
