import type { ExplorerFilter } from '../../lib/api';
export declare function FilterBar({ filter, onFilterChange, viewMode, onViewModeChange }: {
    filter: ExplorerFilter;
    onFilterChange: (patch: Partial<ExplorerFilter>) => void;
    viewMode: 'list' | 'graph';
    onViewModeChange: (mode: 'list' | 'graph') => void;
}): import("react/jsx-runtime").JSX.Element;
