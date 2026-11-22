import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataRevision } from '../../contexts/DataChangeContext'
import { Section } from './shared'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { timeAgo } from '../../lib/format'
import { brand } from '../../lib/tokens'
import type { CloudDeviceListData } from '../../lib/api-contract'
import { deriveDeviceListView } from './device-list-view'

function Tag({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
      style={accent
        ? { background: `${brand.secondary}26`, color: brand.secondary, border: `1px solid ${brand.secondary}4d` }
        : { background: 'rgba(255,255,255,0.05)', color: 'var(--tm-text-muted, #9ca3af)' }}
    >
      {children}
    </span>
  )
}

/** 账号下的设备列表与主设备选择。主设备负责后台记忆整理。 */
export function DeviceList({ syncEnabled }: { syncEnabled: boolean }) {
  const { t } = useTranslation()
  const rev = useDataRevision(['cloud'])
  const [data, setData] = useState<CloudDeviceListData | null>(null)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  const load = useCallback(async () => {
    setError(false)
    try {
      const result = await window.api.cloud.devices()
      if (!result.success || !result.data) throw new Error(result.error ?? 'failed')
      setData(result.data)
    } catch {
      setError(true)
    }
  }, [])

  // 同步事件很频繁：打开时加载一次，之后最多每 30 秒随同步事件刷新一次。
  const lastLoad = useRef(0)
  useEffect(() => {
    if (!syncEnabled) return
    if (Date.now() - lastLoad.current < 30_000) return
    lastLoad.current = Date.now()
    void load()
  }, [syncEnabled, load, rev])

  const confirm = async () => {
    if (!pending) return
    setSaving(true); setSaveError(false)
    try {
      const result = await window.api.cloud.setPrimaryDevice(pending.id)
      if (!result.success) throw new Error(result.error ?? 'failed')
      setPending(null)
      await load()
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  const title = t('settings:account.devices', 'Devices')

  if (!syncEnabled) {
    return (
      <Section title={title}>
        <p className="text-xs text-gray-500">{t('settings:account.deviceList.syncOff')}</p>
      </Section>
    )
  }

  const view = deriveDeviceListView(data, Date.now())
  const { canSwitch, self } = view
  const noticeText = {
    cloudNotUpgraded: t('settings:account.deviceList.cloudNotUpgraded'),
    deviceLimit: view.deviceLimit === null
      ? t('settings:account.deviceList.deviceLimitNoCount')
      : t('settings:account.deviceList.deviceLimit', { limit: view.deviceLimit }),
    noPrimary: t('settings:account.deviceList.noPrimary'),
    primaryStale: t('settings:account.deviceList.primaryStale'),
  }

  return (
    <Section title={title}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">{t('settings:account.deviceList.description')}</p>

        {error && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-xs text-red-400">{t('settings:account.deviceList.loadError')}</p>
            <button onClick={() => { void load() }} className="text-xs text-gray-300 underline">
              {t('settings:account.deviceList.retry')}
            </button>
          </div>
        )}

        {view.notices.map(notice => (
          <div key={notice} className="flex items-start justify-between gap-3">
            {/* text-amber-400 在浅色主题下有覆盖规则(global.css);带透明度后缀的写法没有。 */}
            <p role="status" className="text-xs text-amber-400">{noticeText[notice]}</p>
            {notice === 'deviceLimit' && (
              <button onClick={() => { void load() }} className="shrink-0 text-xs text-gray-300 underline">
                {t('settings:account.deviceList.retry')}
              </button>
            )}
          </div>
        ))}

        {data && data.devices.length > 0 && (
          <ul className="space-y-2">
            {data.devices.map(device => (
              <li key={device.id} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 bg-white/[0.03]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-200 font-medium truncate">{device.name}</span>
                    {device.id === self && <Tag>{t('settings:account.deviceList.thisDevice')}</Tag>}
                    {device.is_primary && <Tag accent>{t('settings:account.deviceList.primary')}</Tag>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {[
                      device.app_version ? `v${device.app_version}` : null,
                      device.online
                        ? t('settings:account.deviceList.online')
                        : device.last_seen
                          ? t('settings:account.deviceList.lastSeen', { time: timeAgo(device.last_seen) })
                          : null,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {canSwitch && !device.is_primary && (
                  <button
                    onClick={() => { setSaveError(false); setPending({ id: device.id, name: device.name }) }}
                    className="shrink-0 px-2.5 py-1 rounded-md text-[11px] text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] transition-colors"
                  >
                    {t('settings:account.deviceList.makePrimary')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onConfirm={() => { void confirm() }}
        onCancel={() => { if (!saving) setPending(null) }}
        title={t('settings:account.deviceList.confirmTitle', { name: pending?.name ?? '' })}
        description={t('settings:account.deviceList.confirmDescription')}
        confirmText={t('settings:account.deviceList.makePrimary')}
        confirmDisabled={saving}
      >
        {saveError && <p role="alert" className="text-xs text-red-400 mt-2">{t('settings:account.deviceList.saveError')}</p>}
      </ConfirmDialog>
    </Section>
  )
}
