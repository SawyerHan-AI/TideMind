import { useState, useCallback } from 'react';
export function useMutation(mutator) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const mutate = useCallback(async (...args) => {
        setLoading(true);
        setError(null);
        try {
            const result = await mutator(...args);
            setData(result);
            return result;
        }
        catch (err) {
            setError(err.message);
            return null;
        }
        finally {
            setLoading(false);
        }
    }, [mutator]);
    const reset = useCallback(() => {
        setData(null);
        setError(null);
        setLoading(false);
    }, []);
    return { mutate, loading, error, data, reset };
}
