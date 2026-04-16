import { useState, useCallback } from 'react'
import { RefreshCw, Wifi, WifiOff, AlertTriangle, ArrowRight, Sparkles, Cloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCloudStatus } from '../../hooks/useCloudStatus'
import { Section } from './shared'
import { Toggle } from '../shared/Toggle'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { brand } from '../../lib/tokens'

// Toggle and ConfirmDialog are still used by MetabolismSection

export function CloudSyncSettings() {
  const { t } = useTranslation()
  const cloud = useCloudStatus()

  // Not logged in: show all sections greyed out with login prompt
  if (!cloud.loggedIn) {
    return (
      <div className="space-y-6 max-w-xl">
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/20" style={{ background: 'rgba(245,158,11,0.06)' }}>
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
          <p className="text-xs text-amber-300 flex-1">
            {t('settings:cloud.loginRequired', 'Sign in to TideMind Cloud to use cloud features.')}
          </p>
          <button
            onClick={() => {
              // Navigate to account tab
              const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
              params.set('tab', 'account')
              window.location.hash = `#/settings?${params.toString()}`
            }}
            className="text-xs font-medium flex-shrink-0 flex items-center gap-1 transition-colors"
            style={{ color: brand.primary }}
          >
            {t('settings:cloud.goLogin', 'Sign In')}
            <ArrowRight size={11} />
          </button>
        </div>

        {/* Greyed-out sections */}
        <div className="opacity-40 pointer-events-none space-y-6">
          <DataSyncSection cloud={cloud} />
          <MetabolismSection cloud={cloud} />
          <ManagedLlmSection />
        </div>
      </div>
    )
  }

  // Cloud not available (user not on whitelist)
  if (cloud.cloudNotAvailable) {
    return (
      <div className="space-y-6 max-w-xl">
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-indigo-500/20" style={{ background: 'rgba(129,140,248,0.06)' }}>
          <Cloud size={14} className="text-indigo-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-xs text-indigo-300 font-medium mb-0.5">
              {t('settings:cloud.betaNotice', 'Cloud features are in private beta')}
            </p>
            <p className="text-[10px] text-gray-500">
              {t('settings:cloud.betaDesc', 'Your account is registered. You\'ll be notified when cloud features are available for your account.')}
            </p>
          </div>
        </div>

        <div className="opacity-40 pointer-events-none space-y-6">
          <DataSyncSection cloud={cloud} />
          <MetabolismSection cloud={cloud} />
          <ManagedLlmSection />
        </div>
      </div>
    )
  }

  // Offline: show all sections disabled
  if (!cloud.online) {
    return (
      <div className="space-y-6 max-w-xl">
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-white/[0.06]" style={{ background: 'rgba(107,114,128,0.08)' }}>
          <WifiOff size={14} className="text-gray-500 flex-shrink-0" />
          <p className="text-xs text-gray-400">
            {t('settings:cloud.offlineNotice', 'Offline — cloud settings are not available.')}
          </p>
        </div>

        <div className="opacity-60 pointer-events-none space-y-6">
          <DataSyncSection cloud={cloud} />
          <MetabolismSection cloud={cloud} />
          <ManagedLlmSection />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-xl">
      <DataSyncSection cloud={cloud} />
      <MetabolismSection cloud={cloud} />
      <ManagedLlmSection />
    </div>
  )
}

// ============================================================
// Section 1: Data Cloud Sync
// ============================================================

function DataSyncSection({ cloud }: { cloud: ReturnType<typeof useCloudStatus> }) {
  const { t } = useTranslation()
  const [syncing, setSyncing] = useState(false)

  const handleSync = async () => {
    setSyncing(true)
    try {
      await window.api.cloud.triggerSync()
    } catch { /* ignore */ }
    finally { setSyncing(false) }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return t('settings:cloud.never', 'Never')
    try { return new Date(iso).toLocaleString() } catch { return iso }
  }

  return (
    <Section
      title={t('settings:cloud.dataSync.title', 'Data Cloud Sync')}
    >
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          {t('settings:cloud.dataSync.desc', 'Sync your memories to TideMind Cloud for multi-device access. Local data becomes a read-only cache of the cloud.')}
        </p>

        {/* Sync Status */}
        <div className="pt-2 border-t border-white/[0.06]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] uppercase tracking-wider text-gray-600">
              {t('settings:cloud.dataSync.syncStatus', 'Sync Status')}
            </span>
            <button
              onClick={handleSync}
              disabled={syncing || cloud.syncing || !cloud.online}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium text-gray-400 border border-white/10 hover:border-white/20 hover:text-white transition-all disabled:opacity-40"
            >
              <RefreshCw size={10} className={(syncing || cloud.syncing) ? 'animate-spin' : ''} />
              {t('settings:cloud.dataSync.syncNow', 'Sync Now')}
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${cloud.online ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-gray-500'}`} />
              <span className="text-xs text-gray-300">
                {cloud.online
                  ? t('settings:cloud.dataSync.connected', 'Connected')
                  : t('settings:cloud.dataSync.offline', 'Offline')}
              </span>
              {cloud.online
                ? <Wifi size={11} className="text-emerald-400" />
                : <WifiOff size={11} className="text-gray-500" />}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">{t('settings:cloud.dataSync.lastSynced', 'Last synced')}</span>
              <span className="text-xs text-gray-400 font-mono">{formatTime(cloud.lastSyncedAt)}</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">{t('settings:cloud.dataSync.pending', 'Pending changes')}</span>
              <span className={`text-xs font-mono ${cloud.outboxCount > 0 ? 'text-amber-400' : 'text-gray-500'}`}>
                {cloud.outboxCount}
              </span>
            </div>

            {cloud.syncing && (
              <div className="flex items-center gap-2 pt-1">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                <span className="text-[10px] text-blue-400">{t('settings:cloud.dataSync.syncing', 'Syncing...')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Section>
  )
}

// ============================================================
// Section 2: Cloud Metabolism
// ============================================================

function MetabolismSection({ cloud }: { cloud: ReturnType<typeof useCloudStatus> }) {
  const { t } = useTranslation()
  const [metabolismEnabled, setMetabolismEnabled] = useState(false)
  const [showEnableConfirm, setShowEnableConfirm] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)

  const isFree = !cloud.plan || cloud.plan === 'free'
  const isProPlus = cloud.plan === 'pro_plus'
  // Cloud metabolism requires data sync to be enabled (for now, always disabled since sync toggle is local state)
  const dataSyncOff = !cloud.loggedIn || !cloud.online

  const handleToggle = useCallback((enabled: boolean) => {
    if (enabled) setShowEnableConfirm(true)
    else setShowDisableConfirm(true)
  }, [])

  // Free users: locked section
  if (isFree) {
    return (
      <Section title={t('settings:cloud.metabolism.title', 'Cloud Metabolism')}>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {t('settings:cloud.metabolism.freeDesc', 'Cloud metabolism is available on Pro and above. Your memories will be annotated, linked, and crystallized 24/7 in the cloud.')}
          </p>
          <button
            onClick={() => window.api.app.openExternal('https://tidemind.ai/pricing')}
            className="flex items-center gap-1.5 text-xs font-medium transition-colors"
            style={{ color: brand.primary }}
          >
            {t('settings:cloud.metabolism.upgrade', 'Upgrade to Pro')}
            <ArrowRight size={11} />
          </button>
        </div>
      </Section>
    )
  }

  return (
    <>
      <Section
        title={t('settings:cloud.metabolism.title', 'Cloud Metabolism')}
        action={
          <Toggle
            enabled={metabolismEnabled}
            onChange={handleToggle}
            disabled={dataSyncOff}
            label={t('settings:cloud.metabolism.title', 'Cloud Metabolism')}
          />
        }
      >
        <div className="space-y-3">
          {isProPlus ? (
            <p className="text-xs text-gray-500">
              {t('settings:cloud.metabolism.proPlusDesc', 'Powered by TideMind managed LLM. No API key needed. Metabolism runs 24/7 in the cloud.')}
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-500">
                {t('settings:cloud.metabolism.proDesc', 'Metabolism tasks run 24/7 in the cloud, independent of your device.')}
              </p>
              {metabolismEnabled && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/15" style={{ background: 'rgba(245,158,11,0.04)' }}>
                  <AlertTriangle size={12} className="text-amber-400 mt-0.5 flex-shrink-0" />
                  <p className="text-[10px] text-amber-300/80 leading-relaxed">
                    {t('settings:cloud.metabolism.keyWarning', 'Cloud metabolism requires uploading your LLM API key (AES-256-GCM encrypted). If you have security concerns, keep this off and use local metabolism.')}
                  </p>
                </div>
              )}
            </>
          )}

          {dataSyncOff && (
            <p className="text-[10px] text-gray-600 italic">
              {t('settings:cloud.metabolism.requiresSync', 'Requires Data Cloud Sync to be enabled.')}
            </p>
          )}

          {/* Pro+ token usage — placeholder */}
          {isProPlus && metabolismEnabled && (
            <div className="pt-2 border-t border-white/[0.06]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">{t('settings:cloud.metabolism.tokenUsage', 'Token Usage')}</span>
                <span className="text-[10px] text-gray-500">— / 3M</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full" style={{ width: '0%', background: brand.primary }} />
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Enable confirm — Pro (BYOK) */}
      {!isProPlus && (
        <ConfirmDialog
          open={showEnableConfirm}
          onCancel={() => setShowEnableConfirm(false)}
          onConfirm={() => { setMetabolismEnabled(true); setShowEnableConfirm(false) }}
          title={t('settings:cloud.metabolism.enableTitle', 'Enable Cloud Metabolism?')}
          description={t('settings:cloud.metabolism.enableDescByok', 'Your LLM API key will be encrypted and uploaded to TideMind Cloud. It will only be used to run your metabolism tasks. The key will be deleted when you disable cloud metabolism.')}
          confirmText={t('settings:cloud.metabolism.enableConfirm', 'Enable')}
          cancelText={t('common:cancel', 'Cancel')}
        />
      )}

      {/* Enable confirm — Pro+ (managed) */}
      {isProPlus && (
        <ConfirmDialog
          open={showEnableConfirm}
          onCancel={() => setShowEnableConfirm(false)}
          onConfirm={() => { setMetabolismEnabled(true); setShowEnableConfirm(false) }}
          title={t('settings:cloud.metabolism.enableTitle', 'Enable Cloud Metabolism?')}
          description={t('settings:cloud.metabolism.enableDescManaged', 'TideMind managed LLM will power your metabolism. 3M tokens/month included. You can also configure your own key in Model Settings for higher quality.')}
          confirmText={t('settings:cloud.metabolism.enableConfirm', 'Enable')}
          cancelText={t('common:cancel', 'Cancel')}
        />
      )}

      {/* Disable confirm */}
      <ConfirmDialog
        open={showDisableConfirm}
        onCancel={() => setShowDisableConfirm(false)}
        onConfirm={() => { setMetabolismEnabled(false); setShowDisableConfirm(false) }}
        title={t('settings:cloud.metabolism.disableTitle', 'Disable Cloud Metabolism?')}
        description={isProPlus
          ? t('settings:cloud.metabolism.disableDescManaged', 'Managed LLM usage will be paused. Metabolism will switch back to local. It will pause when your device is off.')
          : t('settings:cloud.metabolism.disableDescByok', 'Your cloud API key will be deleted. Metabolism will switch back to local. It will pause when your device is off.')}
        confirmText={t('settings:cloud.metabolism.disableConfirm', 'Disable')}
        cancelText={t('common:cancel', 'Cancel')}
        danger
      />
    </>
  )
}

// ============================================================
// Section 3: TideMind Managed LLM
// ============================================================

function ManagedLlmSection() {
  const { t } = useTranslation()

  return (
    <Section
      title={t('settings:cloud.managedLlm.title', 'TideMind LLM Service')}
      action={
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
          style={{ background: 'rgba(234,179,8,0.12)', color: '#facc15', border: '1px solid rgba(234,179,8,0.2)' }}
        >
          {t('settings:cloud.managedLlm.comingSoon', 'Coming Soon')}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          {t('settings:cloud.managedLlm.desc', 'Use TideMind-provided LLM service without registering your own API keys. Included in Pro+ subscription.')}
        </p>
        <button
          onClick={() => window.api.app.openExternal('https://tidemind.ai/pricing')}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Sparkles size={11} />
          {t('settings:cloud.managedLlm.learnMore', 'Learn more')}
        </button>
      </div>
    </Section>
  )
}
