import { useState, useEffect, useRef } from 'react';
/**
 * Resolve node IDs to human-readable titles.
 * Only fetches when `enabled` is true (i.e. the detail panel is expanded).
 * Results are cached across re-renders for the same ID set.
 */
export function useResolvedNodes(nodeIds, enabled) {
    const [nodeMap, setNodeMap] = useState(null);
    const [loading, setLoading] = useState(false);
    const prevKey = useRef('');
    const loadedKey = useRef('');
    const latestKeyRef = useRef('');
    // 用 string dep key 避免数组引用比较:caller 不必 useMemo 自己稳定 nodeIds,
    // hook 内部按内容比较。原版 deps [enabled, nodeIds] 按引用比对,父组件每次
    // render 重建数组就重跑 effect,即使 ID 集合不变也会切到 loading 状态。
    const nodeIdsKey = nodeIds.slice().sort().join(',');
    useEffect(() => {
        if (!enabled || nodeIdsKey.length === 0)
            return;
        const key = nodeIdsKey;
        if (key === loadedKey.current)
            return;
        prevKey.current = key;
        loadedKey.current = key;
        latestKeyRef.current = key;
        setLoading(true);
        window.api.timeline
            .resolveNodes(nodeIdsKey.split(','))
            .then((result) => {
            if (key !== latestKeyRef.current)
                return; // stale — a newer call has superseded us
            setNodeMap(result);
        })
            .catch(() => {
            if (key !== latestKeyRef.current)
                return;
            setNodeMap(null);
        })
            .finally(() => {
            if (key !== latestKeyRef.current)
                return;
            setLoading(false);
        });
    }, [enabled, nodeIdsKey]);
    return { nodeMap, loading };
}
