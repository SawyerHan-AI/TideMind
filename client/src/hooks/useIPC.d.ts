export declare function useIPC<T>(fetcher: () => Promise<T>, deps?: unknown[]): {
    data: T | null;
    loading: boolean;
    error: string | null;
    refetch: () => void;
};
