import type { TimelineEvent } from '../../lib/api';
export declare function TimelineItem({ event, isExpanded, onToggle, onNodeClick, }: {
    event: TimelineEvent;
    isExpanded: boolean;
    onToggle: () => void;
    onNodeClick: (id: string) => void;
}): import("react/jsx-runtime").JSX.Element;
