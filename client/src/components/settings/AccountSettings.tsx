import { useState } from 'react'
import { Cloud, Mail, LogOut, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCloudStatus } from '../../hooks/useCloudStatus'
import { Section } from './shared'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { brand, btnText } from '../../lib/tokens'

function ComingSoonTag() {
  const { t } = useTranslation()
  return (
    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
      style={{ background: 'rgba(234,179,8,0.12)', color: '#facc15', border: '1px solid rgba(234,179,8,0.2)' }}
    >
      {t('settings:account.comingSoon', 'Coming Soon')}
    </span>
  )
}

export function AccountSettings() {
  const { t } = useTranslation()
  const cloud = useCloudStatus()

  if (!cloud.loggedIn) {
    return <LoggedOutView />
  }

  return <LoggedInView cloud={cloud} />
}

// ============================================================
// Logged-out: open browser for login
// ============================================================

function LoggedOutView() {
  const { t } = useTranslation()

  const handleLogin = async () => {
    const url = await window.api.cloud.loginUrl()
    window.api.app.openExternal(url)
  }

  const handleRegister = async () => {
    const url = await window.api.cloud.registerUrl()
    window.api.app.openExternal(url)
  }

  return (
    <div className="max-w-md mx-auto mt-8">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
          style={{ background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.2)' }}>
          <Cloud size={28} style={{ color: brand.primary }} />
        </div>
        <h2 className="text-base font-semibold text-gray-100 mb-1">TideMind Cloud</h2>
        <p className="text-xs text-gray-500">
          {t('settings:account.loginDesc', 'Sync your external brain across devices. Never stop thinking.')}
        </p>
      </div>

      <div className="space-y-3">
        <button
          onClick={handleLogin}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all"
          style={{
            background: brand.gradientAlpha,
            border: `1px solid ${brand.secondary}4d`,
            color: btnText.onBrand,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = brand.gradientHover)}
          onMouseLeave={e => (e.currentTarget.style.background = brand.gradientAlpha)}
        >
          <Cloud size={14} />
          {t('settings:account.loginButton', 'Sign In')}
        </button>

        <button
          onClick={handleRegister}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium text-gray-400 border border-white/10 hover:border-white/20 hover:text-white transition-all"
        >
          {t('settings:account.registerButton', 'Create Account')}
        </button>

        <p className="text-[10px] text-gray-600 text-center">
          {t('settings:account.browserHint', 'Opens in your browser for secure authentication.')}
        </p>
      </div>
    </div>
  )
}

// ============================================================
// Logged-in: profile, subscription, actions
// ============================================================

function LoggedInView({ cloud }: { cloud: ReturnType<typeof useCloudStatus> }) {
  const { t } = useTranslation()
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleLogout = async () => {
    try {
      await window.api.cloud.logout()
    } catch { /* ignore */ }
    setShowLogoutConfirm(false)
  }

  const handleDeleteAccount = async () => {
    // Account deletion requires contacting support for now
    // Just logout and show the support info
    await handleLogout()
    setShowDeleteConfirm(false)
  }

  const handleOpenPricing = () => {
    window.api.app.openExternal('https://tidemind.ai/pricing')
  }

  const handleManageSubscription = async () => {
    // 跳云服务端 portal,服务端用浏览器 session cookie 鉴权后调 Creem API
    // 拿到 Creem 托管 portal URL,302 跳过去。
    // 注意:用户在浏览器需要先登录(客户端 OAuth token 不共享到浏览器),
    // 未登录时 cloud-server 的 requireAuth 会引导到 /auth/login。
    try {
      const url = await window.api.cloud.billingPortalUrl()
      window.api.app.openExternal(url)
    } catch {
      // IPC 失败极少见;退回到官网,用户可从那里登录后再找入口
      window.api.app.openExternal('https://tidemind.ai/pricing')
    }
  }

  const isFree = !cloud.plan || cloud.plan === 'free'
  const planLabel = cloud.plan === 'pro_plus' ? 'Pro+' : cloud.plan === 'pro' ? 'Pro' : 'Free'

  return (
    <div className="space-y-6 max-w-xl">
      {/* Basic Info */}
      <Section title={t('settings:account.basicInfo', 'Basic Info')}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Mail size={12} className="text-gray-500" />
            <span className="text-xs text-gray-300">{cloud.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
              style={{
                background: cloud.plan === 'free'
                  ? 'rgba(107,114,128,0.2)'
                  : 'rgba(129,140,248,0.15)',
                color: cloud.plan === 'free' ? '#9ca3af' : brand.primary,
                border: cloud.plan === 'free'
                  ? '1px solid rgba(107,114,128,0.3)'
                  : `1px solid rgba(129,140,248,0.2)`,
              }}
            >
              {planLabel}
            </span>
          </div>
        </div>
      </Section>

      {/* Devices — placeholder */}
      <Section
        title={t('settings:account.devices', 'Devices')}
        action={<ComingSoonTag />}
      >
        <p className="text-xs text-gray-500">
          {t('settings:account.devicesComingSoon', 'Device management coming soon.')}
        </p>
      </Section>

      {/* Subscription */}
      <Section
        title={t('settings:account.subscription', 'Subscription')}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">{t('settings:account.currentPlan', 'Current Plan')}</span>
            <span className="text-xs text-gray-200 font-medium">{planLabel}</span>
          </div>

          {isFree ? (
            <>
              <p className="text-xs text-gray-500">
                {t('settings:account.upgradeHint', 'Upgrade to Pro for unlimited cloud memories, 5 devices, 7×24 cloud metabolism, and more.')}
              </p>
              <button
                onClick={handleOpenPricing}
                className="mt-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                style={{
                  background: brand.gradientAlpha,
                  border: `1px solid ${brand.secondary}4d`,
                  color: btnText.onBrand,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = brand.gradientHover)}
                onMouseLeave={e => (e.currentTarget.style.background = brand.gradientAlpha)}
              >
                {t('settings:account.viewPricing', 'View Plans & Pricing')}
              </button>
            </>
          ) : (
            <button
              onClick={handleManageSubscription}
              className="mt-1 px-3 py-1.5 rounded-md text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
            >
              {t('settings:account.manageSubscription', 'Manage Subscription')}
            </button>
          )}
        </div>
      </Section>

      {/* Billing — placeholder */}
      <Section
        title={t('settings:account.billing', 'Billing')}
        action={<ComingSoonTag />}
      >
        <p className="text-xs text-gray-500">
          {cloud.plan === 'free'
            ? t('settings:account.noBilling', 'No billing history for Free plan.')
            : t('settings:account.billingComingSoon', 'Billing history coming soon.')}
        </p>
      </Section>

      {/* Danger Zone */}
      <div className="space-y-3 pt-2">
        <button
          onClick={() => setShowLogoutConfirm(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-gray-400 border border-white/10 hover:border-white/20 hover:text-white transition-all"
        >
          <LogOut size={12} />
          {t('settings:account.logout', 'Sign Out')}
        </button>

        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-red-400/60 hover:text-red-400 border border-transparent hover:border-red-400/20 transition-all"
        >
          <Trash2 size={12} />
          {t('settings:account.requestAccountDeletion', 'Request Account Deletion')}
        </button>
      </div>

      <ConfirmDialog
        open={showLogoutConfirm}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={handleLogout}
        title={t('settings:account.logoutTitle', 'Sign Out?')}
        description={t('settings:account.logoutDesc', 'You will be signed out of TideMind Cloud. Local data is not affected.')}
        confirmText={t('settings:account.logout', 'Sign Out')}
        cancelText={t('common:actions.cancel', 'Cancel')}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteAccount}
        title={t('settings:account.requestDeletionTitle', 'Request Account Deletion?')}
        description={t('settings:account.requestDeletionDesc', 'Clicking confirm will sign you out. To permanently delete your account and all cloud data, please email support@tidemind.ai after signing out. Local data on this device is not affected.')}
        confirmText={t('settings:account.requestDeletionConfirm', 'Sign Out — I will email support')}
        cancelText={t('common:actions.cancel', 'Cancel')}
        danger
      />
    </div>
  )
}
