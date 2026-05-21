import { useEffect, useState } from 'react'
import { Cloud, Mail, LogOut, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCloudStatus } from '../../hooks/useCloudStatus'
import { useDataRevision } from '../../contexts/DataChangeContext'
import { Section } from './shared'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { brand, btnText } from '../../lib/tokens'

/** 产品决策 #10(2026-05-20):本月 LLM 用量常驻卡片(简洁版,Power user 可点
 *  Settings → Model Usage 看完整明细;这里只一个数字 + 一句话总结)。 */
function LlmCostThisMonthSection() {
  const { t } = useTranslation()
  const [cost, setCost] = useState<number | null>(null)
  const [callCount, setCallCount] = useState<number>(0)
  // F15: 订阅 cloud/operations 变更,让 LLM 调用发生后这块自动刷新。
  // 复用 'cloud' scope —— sync-client emit 此 scope 时也 implies LLM 用量有更新。
  const rev = useDataRevision(['cloud'])

  useEffect(() => {
    let cancelled = false
    const firstOfMonth = new Date()
    firstOfMonth.setDate(1)
    firstOfMonth.setHours(0, 0, 0, 0)
    const after = firstOfMonth.toISOString().slice(0, 10)
    window.api.stats.tokenUsageFiltered({ after, limit: 1, offset: 0 })
      .then((data: { operationStats?: Array<{ estimated_cost: number; cnt: number }> } | null) => {
        if (cancelled || !data?.operationStats) return
        const total = data.operationStats.reduce((s, op) => s + (op.estimated_cost ?? 0), 0)
        const calls = data.operationStats.reduce((s, op) => s + (op.cnt ?? 0), 0)
        setCost(total)
        setCallCount(calls)
      }).catch(() => {})
    return () => { cancelled = true }
  }, [rev])

  if (cost === null) return null

  // 简洁版:不画图表,只一行数字 + 月份范围(用户想看明细自己点 Model Usage tab)
  const monthLabel = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  const formattedCost = cost >= 1 ? `$${cost.toFixed(2)}` : cost > 0 ? `$${cost.toFixed(3)}` : '$0'

  return (
    <Section title={t('settings:account.llmCostThisMonth', 'LLM Usage This Month')}>
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-lg font-semibold text-gray-100">{formattedCost}</span>
          <span className="ml-2 text-[11px] text-gray-500">
            {t('settings:account.llmCostCalls', '{{count}} calls', { count: callCount })}
          </span>
        </div>
        <span className="text-[11px] text-gray-500">{monthLabel}</span>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed mt-1.5">
        {t(
          'settings:account.llmCostHint',
          'Estimated. Tap Model Usage in Settings for full breakdown.',
        )}
      </p>
    </Section>
  )
}

/** 产品决策 #7(2026-05-20):用量进度条 — 显示 active 节点用量 / 计划上限 */
function MemoryUsageSection() {
  const { t } = useTranslation()
  const [usage, setUsage] = useState<{ used: number; limit: number; plan: 'free' | 'pro' | 'pro_plus' } | null>(null)
  // F15: nodes scope 变更(写入 / metabolism)会改变 active 节点数,要重拉。
  // cloud scope 涵盖了订阅 plan / quota 变更。
  const rev = useDataRevision(['nodes', 'cloud'])

  useEffect(() => {
    let cancelled = false
    window.api.cloud.memoryUsage().then((u) => {
      if (!cancelled) setUsage(u)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [rev])

  if (!usage) return null
  const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0
  const isFree = usage.plan === 'free'
  // 颜色档:< 70% 中性绿、70-90% 黄、≥ 90% 红(只有 free plan 才有意义)
  const color = !isFree
    ? '#34d399'
    : pct >= 90 ? '#f87171'
    : pct >= 70 ? '#fbbf24'
    : '#34d399'

  return (
    <Section title={t('settings:account.memoryUsage', 'Memory Usage')}>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">
            {t('settings:account.memoryUsageLine', '{{used}} / {{limit}} memories', {
              used: usage.used.toLocaleString(),
              limit: isFree ? usage.limit.toLocaleString() : t('settings:account.memoryUnlimited', 'unlimited'),
            })}
          </span>
          {isFree && <span className="text-gray-500">{pct}%</span>}
        </div>
        {isFree && (
          <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: color }}
            />
          </div>
        )}
        {isFree && pct >= 90 && (
          <p className="text-[11px] text-red-400/80 leading-relaxed">
            {t(
              'settings:account.memoryNearLimitHint',
              'Approaching the Free plan limit. New memories beyond {{limit}} will become read-only until you upgrade.',
              { limit: usage.limit },
            )}
          </p>
        )}
      </div>
    </Section>
  )
}

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
            <div className="space-y-1.5">
              <button
                onClick={handleManageSubscription}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
              >
                {t('settings:account.manageSubscription', 'Manage Subscription')}
              </button>
              {/* Creem 取消语义 = 立即取消(不同于 Stripe/LSQ 默认周期末取消)。
                  让用户在点按钮前就知道行为差异,避免被 "数据被锁死了 / 钱白付了" 的
                  误判惊到。(2026-05-20 产品决策 #3 P1) */}
              <p className="text-[11px] text-gray-500 leading-relaxed">
                {t(
                  'settings:account.cancellationNote',
                  'Cancellation takes effect immediately. Your existing data stays accessible (read-only after the free-tier limit).',
                )}
              </p>
            </div>
          )}
        </div>
      </Section>

      {/* Memory Usage(产品决策 #7,2026-05-20)— free plan 触顶前提示用户 */}
      <MemoryUsageSection />

      {/* LLM 本月用量(产品决策 #10,2026-05-20)— 设置页常驻,详细见 Model Usage tab */}
      <LlmCostThisMonthSection />

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
