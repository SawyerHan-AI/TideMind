export type NodeInfo = {
    title: string | null;
    type: string;
};
export type NodeMap = Record<string, NodeInfo>;
/**
 * Resolve node IDs to human-readable titles.
 * Only fetches when `enabled` is true (i.e. the detail panel is expanded).
 * Results are cached across re-renders for the same ID set.
 */
export declare function useResolvedNodes(nodeIds: string[], enabled: boolean): {
    nodeMap: NodeMap | null;
    loading: boolean;
};
