import { useIPC } from './useIPC'
import { useDataRevision } from '../contexts/DataChangeContext'

export interface CloudStatus {
  loggedIn: boolean
  email?: string
  plan?: string
  online: boolean
  syncing: boolean
  outboxCount: number
  lastSyncedAt?: string
  cloudNotAvailable?: boolean
}

export function useCloudStatus(): CloudStatus {
  const rev = useDataRevision(['cloud'])
  const { data } = useIPC(() => window.api.cloud.status(), [rev])
  return data ?? { loggedIn: false, online: false, syncing: false, outboxCount: 0 }
}
