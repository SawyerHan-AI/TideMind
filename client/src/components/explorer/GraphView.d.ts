import 'd3-transition';
import type { ExplorerFilter } from '../../lib/api';
interface GraphViewProps {
    filter: ExplorerFilter;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    /** P2-2 节点上限(由父组件控制以便 BrainExplorer 在 list/graph 切换时持久化) */
    graphLimit?: number;
    onGraphLimitChange?: (n: number) => void;
}
export declare function GraphView({ filter, selectedId, onSelect, graphLimit, onGraphLimitChange }: GraphViewProps): import("react/jsx-runtime").JSX.Element;
export {};
