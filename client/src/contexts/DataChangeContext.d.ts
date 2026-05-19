/**
 * 数据变更 Context
 *
 * 监听主进程推送的 'data-changed' 事件，
 * 提供 useDataRevision() hook 让页面组件自动感知后端数据变更。
 */
export declare function DataChangeProvider({ children }: {
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/**
 * 返回一个 revision 数字，每次后端数据变更时递增。
 * 将其加入 useIPC 的 deps 数组即可实现自动刷新。
 *
 * @param scopes 可选，只在指定范围变化时才递增（如 ['nodes', 'links']）
 */
export declare function useDataRevision(scopes?: string[]): number;
