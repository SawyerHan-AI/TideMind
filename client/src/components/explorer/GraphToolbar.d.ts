interface GraphToolbarProps {
    neighborhoodDepth: number;
    onNeighborhoodDepthChange: (depth: number) => void;
    pathMode: boolean;
    pathFrom: string | null;
    onPathModeToggle: () => void;
    showStructureHoles: boolean;
    onStructureHolesToggle: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFitAll: () => void;
    connectivityThreshold: number;
    onConnectivityThresholdChange: (v: number) => void;
    maxConnectivity: number;
    /** P2-2 节点上限控件 */
    graphLimit?: number;
    onGraphLimitChange?: (n: number) => void;
    /** 实际渲染节点数(用作信息显示) */
    renderedNodeCount?: number;
}
export declare function GraphToolbar({ neighborhoodDepth, onNeighborhoodDepthChange, pathMode, pathFrom, onPathModeToggle, showStructureHoles, onStructureHolesToggle, onZoomIn, onZoomOut, onFitAll, connectivityThreshold, onConnectivityThresholdChange, maxConnectivity, graphLimit, onGraphLimitChange, renderedNodeCount, }: GraphToolbarProps): import("react/jsx-runtime").JSX.Element;
export {};
