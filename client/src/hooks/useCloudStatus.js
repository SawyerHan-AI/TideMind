import { useIPC } from './useIPC';
import { useDataRevision } from '../contexts/DataChangeContext';
// 模块级稳定 fallback(2026-05-09 轻微):避免每次 hook 调用都新建对象,
// 让 useMemo / 子组件浅比较稳定。Object.freeze 防意外修改。
const CLOUD_STATUS_FALLBACK = Object.freeze({
    loggedIn: false,
    syncEnabled: false,
    online: false,
    syncing: false,
    outboxCount: 0,
});
export function useCloudStatus() {
    const rev = useDataRevision(['cloud']);
    const { data } = useIPC(() => window.api.cloud.status(), [rev]);
    return data ?? CLOUD_STATUS_FALLBACK;
}
