import { useIPC } from './useIPC'
import { useDataRevision } from '../contexts/DataChangeContext'

export interface CloudStatus {
  loggedIn: boolean
  email?: string
  plan?: string
  syncEnabled: boolean
  online: boolean
  syncing: boolean
  outboxCount: number
  lastSyncedAt?: string
  cloudNotAvailable?: boolean
  syncNotReady?: boolean
  /** 持久化的错误码(从 syncClient 状态派生),页面切换后仍可见。 */
  lastErrorCode?: string | null
  /** 错误的原始 message(如 `HTTP 500` / `fetch failed` 等),用于辅助诊断。 */
  lastErrorMessage?: string | null
  /** 云代谢开关(和本地代谢互斥)。开启后本地 scheduler 停跑。 */
  metabolismEnabled?: boolean
}

export function useCloudStatus(): CloudStatus {
  const rev = useDataRevision(['cloud'])
  const { data } = useIPC(() => window.api.cloud.status(), [rev])
  return data ?? { loggedIn: false, syncEnabled: false, online: false, syncing: false, outboxCount: 0 }
}
