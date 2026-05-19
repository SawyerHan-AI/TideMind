export declare function useMutation<TResult, TArgs extends unknown[] = []>(mutator: (...args: TArgs) => Promise<TResult>): {
    mutate: (...args: TArgs) => Promise<TResult | null>;
    loading: boolean;
    error: string | null;
    data: TResult | null;
    reset: () => void;
};
