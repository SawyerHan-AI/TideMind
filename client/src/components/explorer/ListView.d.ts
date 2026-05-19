import type { NodeData } from '../../lib/api';
export declare function ListView({ nodes, total, page, onPageChange, selectedId, onSelect, loading }: {
    nodes: NodeData[];
    total: number;
    page: number;
    onPageChange: (page: number) => void;
    selectedId: string | null;
    onSelect: (id: string) => void;
    loading: boolean;
}): import("react/jsx-runtime").JSX.Element;
