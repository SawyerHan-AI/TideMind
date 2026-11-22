/**
 * 账号页设备区块的状态推导（设计 primary-device-acceptance-fixes §5、§10.7）。
 */
import { describe, expect, it } from 'vitest'
import type { CloudDeviceListData } from '../../client/src/lib/api-contract'
import { deriveDeviceListView, STALE_PRIMARY_MS } from '../../client/src/components/settings/device-list-view'

const NOW = Date.parse('2026-11-20T00:00:00Z')
const device = (id: string, over: Partial<CloudDeviceListData['devices'][number]> = {}) => ({
  id, name: `starsea-${id}`, device_type: 'desktop-darwin', app_version: '0.2.102',
  last_seen: new Date(NOW - 60_000).toISOString(), is_primary: false, online: true, ...over,
})
const list = (over: Partial<CloudDeviceListData> = {}): CloudDeviceListData => ({
  devices: [device('a', { is_primary: true }), device('b')],
  thisDeviceId: 'b', primaryDeviceId: 'a', cloudNotUpgraded: false, registration: 'registered', deviceLimit: null, ...over,
})

describe('deriveDeviceListView', () => {
  it('nothing loaded yet', () => {
    expect(deriveDeviceListView(null, NOW)).toEqual({ notices: [], deviceLimit: null, canSwitch: false, self: null })
  })

  it('a healthy account shows no notice and marks this device', () => {
    expect(deriveDeviceListView(list(), NOW)).toEqual({ notices: [], deviceLimit: null, canSwitch: true, self: 'b' })
  })

  it('no primary device', () => {
    const view = deriveDeviceListView(list({ devices: [device('a'), device('b')], primaryDeviceId: null }), NOW)
    expect(view.notices).toEqual(['noPrimary'])
  })

  it('a primary that is offline for more than 7 days is stale; an online one never is', () => {
    const old = new Date(NOW - STALE_PRIMARY_MS - 60_000).toISOString()
    const offline = list({ devices: [device('a', { is_primary: true, online: false, last_seen: old }), device('b')] })
    expect(deriveDeviceListView(offline, NOW).notices).toEqual(['primaryStale'])
    const online = list({ devices: [device('a', { is_primary: true, online: true, last_seen: old }), device('b')] })
    expect(deriveDeviceListView(online, NOW).notices).toEqual([])
    const recent = list({ devices: [device('a', { is_primary: true, online: false }), device('b')] })
    expect(deriveDeviceListView(recent, NOW).notices).toEqual([])
  })

  it('device limit reached: explains it, has no row for this device, and switching stays available', () => {
    const view = deriveDeviceListView(list({ thisDeviceId: null, registration: 'device_limit', deviceLimit: 2 }), NOW)
    expect(view).toEqual({ notices: ['deviceLimit'], deviceLimit: 2, canSwitch: true, self: null })
    expect(deriveDeviceListView(list({ thisDeviceId: null, registration: 'device_limit', deviceLimit: null }), NOW).deviceLimit).toBeNull()
  })

  it('device limit together with no primary shows both, the limit first', () => {
    const view = deriveDeviceListView(list({
      devices: [device('a'), device('c')], primaryDeviceId: null, thisDeviceId: null, registration: 'device_limit', deviceLimit: 2,
    }), NOW)
    expect(view.notices).toEqual(['deviceLimit', 'noPrimary'])
  })

  it('a cloud that was not upgraded is read-only and shows only that notice', () => {
    const view = deriveDeviceListView(list({ cloudNotUpgraded: true, devices: [device('b')], primaryDeviceId: null }), NOW)
    expect(view).toMatchObject({ notices: ['cloudNotUpgraded'], canSwitch: false })
  })

  it('a registration that could not be checked is not reported as a device limit', () => {
    expect(deriveDeviceListView(list({ registration: 'unavailable', thisDeviceId: null }), NOW).notices).toEqual([])
  })
})
