/**
 * Pro 功能注册表
 *
 * 动态加载闭源客户端功能（路由、侧边栏、i18n 等）。
 * pro/client-features 不存在时返回 null——开源版正常运行。
 */
import type { RouteObject } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
export interface SidebarItem {
    to: string;
    icon: LucideIcon;
    label: string;
}
export interface ProFeatures {
    routes: RouteObject[];
    sidebarItems: SidebarItem[];
}
export declare function loadProFeatures(): Promise<ProFeatures | null>;
export declare function getProFeatures(): ProFeatures | null;
