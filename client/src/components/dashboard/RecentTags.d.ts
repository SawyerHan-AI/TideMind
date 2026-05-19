import type { DashboardTags } from '../../lib/api';
interface RecentTagsProps {
    tags: DashboardTags;
    onTagClick: (tag: string) => void;
}
export declare function RecentTags({ tags, onTagClick }: RecentTagsProps): import("react/jsx-runtime").JSX.Element | null;
export {};
