import type { DashboardActivity } from '../../lib/api';
interface RecentActivityProps {
    activity: DashboardActivity;
    onNodeClick: (id: string) => void;
}
export declare function RecentActivity({ activity, onNodeClick }: RecentActivityProps): import("react/jsx-runtime").JSX.Element;
export {};
