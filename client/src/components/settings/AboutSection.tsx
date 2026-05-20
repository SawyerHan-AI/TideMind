import { useState, useEffect } from 'react'
import { ExternalLink, RefreshCw, CheckCircle, AlertCircle, Download, RotateCw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Section } from './shared'
import { brand } from '../../lib/tokens'
import { useUpdaterState } from '../../hooks/useUpdaterState'

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string | null
  releaseNotes: string | null
  publishedAt: string | null
}

export function AboutSection() {
  const { t } = useTranslation('settings')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState('0.2.70')
  const updaterState = useUpdaterState()

  useEffect(() => {
    window.api.app.getVersion().then((v: string) => setCurrentVersion(v)).catch(() => {})
  }, [])

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking')
    setUpdateError(null)
    // 打包模式下走自动更新流程(fire-and-forget),进度由 updaterState 反映
    void window.api.updater.checkNow().catch(() => {})
    // 同时跑传统手动查询,dev 模式下也能给反馈、生产模式作为 release notes 来源
    try {
      const info: UpdateInfo = await window.api.app.checkUpdate()
      setUpdateInfo(info)
      setUpdateStatus(info.hasUpdate ? 'available' : 'up-to-date')
    } catch (err) {
      setUpdateError((err as Error).message)
      setUpdateStatus('error')
    }
  }

  const handleOpenRelease = () => {
    if (updateInfo?.releaseUrl) {
      window.api.app.openExternal(updateInfo.releaseUrl)
    }
  }

  const handleOpenLink = (url: string) => {
    window.api.app.openExternal(url)
  }

  const handleInstall = () => {
    window.api.updater.install().catch(() => {})
  }

  // 自动更新进行中状态优先显示。包括 checking/available,避免 updater 已经在跑但
  // 旧的"打开 GitHub Release 页面"按钮还显示出来被用户点了导致多余弹网页。
  // 只在 idle / up-to-date / error 显示旧的手动检查 UI 作为降级路径。
  const isAutoUpdating =
    updaterState.status === 'checking' ||
    updaterState.status === 'available' ||
    updaterState.status === 'downloading' ||
    updaterState.status === 'downloaded' ||
    updaterState.status === 'signature-invalid' ||
    updaterState.status === 'staged-out'

  return (
    <div className="max-w-lg space-y-6">
      <Section title="Tide Mind">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400">{t('about.version', 'Version')}</p>
              <p className="text-sm text-gray-200 font-mono mt-0.5">{updateInfo?.currentVersion ?? currentVersion}</p>
            </div>

            {!isAutoUpdating && updateStatus === 'idle' && (
              <button
                onClick={handleCheckUpdate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
                style={{ background: 'var(--theme-glass-bg)' }}
              >
                <RefreshCw size={11} />
                {t('about.checkUpdate', 'Check for Updates')}
              </button>
            )}

            {!isAutoUpdating && updateStatus === 'checking' && (
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <RefreshCw size={11} className="animate-spin" />
                {t('about.checking', 'Checking...')}
              </span>
            )}

            {updaterState.status === 'downloaded' && (
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-200 border border-emerald-500/40 hover:border-emerald-500/60 hover:bg-emerald-500/20 transition-all"
                style={{ background: 'rgba(16,185,129,0.12)' }}
              >
                <RotateCw size={11} />
                {t('about.installNow', 'Restart to update')}
              </button>
            )}
          </div>

          {updaterState.status === 'downloading' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-300">
                <span className="flex items-center gap-1.5">
                  <Download size={11} className="text-indigo-400" />
                  {t('about.downloading', 'Downloading {{percent}}%', { percent: updaterState.percent })}
                </span>
                <span className="text-gray-500 font-mono text-[10px]">{updaterState.version}</span>
              </div>
              <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                <div
                  className="bg-indigo-400 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(2, updaterState.percent)}%` }}
                />
              </div>
            </div>
          )}

          {updaterState.status === 'signature-invalid' && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10">
              <ShieldAlert size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-red-300">
                {t('about.signatureInvalid', 'Update rejected (signature invalid)')}
              </div>
            </div>
          )}

          {updaterState.status === 'staged-out' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <CheckCircle size={13} className="text-gray-400" />
              <span>{t('about.stagedOut', "New version rolling out gradually, you'll get it soon")}</span>
            </div>
          )}

          {!isAutoUpdating && updateStatus === 'up-to-date' && (
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle size={13} />
              <span className="text-xs">{t('about.upToDate', 'You are on the latest version.')}</span>
            </div>
          )}

          {!isAutoUpdating && updateStatus === 'available' && updateInfo && (
            <div className="p-3 rounded-lg border border-indigo-400/20" style={{ background: 'rgba(129,140,248,0.06)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-indigo-300">
                  {t('about.newVersion', 'New version available')}: {updateInfo.latestVersion}
                </span>
                <button
                  onClick={handleOpenRelease}
                  className="flex items-center gap-1 text-[10px] font-medium transition-colors"
                  style={{ color: brand.primary }}
                >
                  <Download size={10} />
                  {t('about.downloadUpdate', 'Download')}
                </button>
              </div>
              {updateInfo.releaseNotes && (
                <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-3">
                  {updateInfo.releaseNotes}
                </p>
              )}
            </div>
          )}

          {!isAutoUpdating && updateStatus === 'error' && (
            <div className="flex items-center gap-2">
              <AlertCircle size={13} className="text-red-400" />
              <span className="text-xs text-red-400">
                {t('about.checkFailed', 'Check failed. Please try again later.')}
              </span>
              <button
                onClick={handleCheckUpdate}
                className="text-[10px] text-gray-500 hover:text-gray-300 underline transition-colors"
              >
                {t('about.retry', 'Retry')}
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section title={t('about.links', 'Links')}>
        <div className="space-y-2.5">
          {[
            { label: 'GitHub', url: 'https://github.com/SawyerHan-AI/TideMind' },
            { label: t('about.website', 'Website'), url: 'https://tidemind.ai' },
            { label: t('about.feedback', 'Feedback'), url: 'https://github.com/SawyerHan-AI/TideMind/issues' },
            { label: t('about.docs', 'Documentation'), url: 'https://tidemind.ai/docs' },
          ].map(link => (
            <button
              key={link.url}
              onClick={() => handleOpenLink(link.url)}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors group w-full text-left"
            >
              <span className="flex-1">{link.label}</span>
              <ExternalLink size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('about.license', 'License')}>
        <div className="text-xs text-gray-500 space-y-1">
          <p>MIT License</p>
          <p>&copy; 2024-{new Date().getFullYear()} TideMind Contributors</p>
        </div>
      </Section>

      {updateError && (
        <p className="text-[10px] text-red-400/60">{updateError}</p>
      )}
    </div>
  )
}
