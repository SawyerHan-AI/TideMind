import type { CloudDeviceListData } from '../../lib/api-contract'

export const STALE_PRIMARY_MS = 7 * 24 * 60 * 60 * 1000

export type DeviceListNotice = 'cloudNotUpgraded' | 'deviceLimit' | 'noPrimary' | 'primaryStale'

export interface DeviceListView {
  /** 按显示顺序排列的提示。 */
  notices: DeviceListNotice[]
  /** 设备数上限（deviceLimit 提示用）；云端没给数值时为 null。 */
  deviceLimit: number | null
  /** 是否可以切换主设备（云端已支持）。 */
  canSwitch: boolean
  /** 本机的设备 ID；本机没有在云端注册时为 null，列表里也就没有“本机”这一行。 */
  self: string | null
}

/**
 * 账号页设备区块的状态推导。只做判断，不渲染，便于测试。
 *
 * 设备数超限时“设为主设备”保持可用：云端不要求调用方已注册，这台设备替其他设备
 * 切换主设备是合法操作。
 */
export function deriveDeviceListView(data: CloudDeviceListData | null, now: number): DeviceListView {
  if (!data) return { notices: [], deviceLimit: null, canSwitch: false, self: null }
  const notices: DeviceListNotice[] = []
  const canSwitch = !data.cloudNotUpgraded
  const primary = data.devices.find(d => d.is_primary) ?? null
  if (data.cloudNotUpgraded) notices.push('cloudNotUpgraded')
  if (data.registration === 'device_limit') notices.push('deviceLimit')
  if (canSwitch && !primary) notices.push('noPrimary')
  if (canSwitch && primary && !primary.online && primary.last_seen
    && now - new Date(primary.last_seen).getTime() > STALE_PRIMARY_MS) notices.push('primaryStale')
  return {
    notices,
    deviceLimit: data.registration === 'device_limit' ? data.deviceLimit : null,
    canSwitch,
    self: data.thisDeviceId,
  }
}
