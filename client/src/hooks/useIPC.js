import { useState, useEffect, useCallback, useRef } from 'react';
export function useIPC(fetcher, deps = []) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const hasData = useRef(false);
    const fetch = useCallback(async () => {
        // 已有数据时静默刷新（不显示 loading 骨架屏）
        if (!hasData.current)
            setLoading(true);
        setError(null);
        try {
            const result = await fetcher();
            setData(result);
            hasData.current = true;
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setLoading(false);
        }
    }, deps); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        fetch();
    }, [fetch]);
    return { data, loading, error, refetch: fetch };
}
