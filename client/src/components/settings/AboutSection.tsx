import { useState, useEffect } from 'react'
import { ExternalLink, RefreshCw, CheckCircle, AlertCircle, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Section } from './shared'
import { brand } from '../../lib/tokens'

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
  const [currentVersion, setCurrentVersion] = useState('0.2.63')

  useEffect(() => {
    window.api.app.getVersion().then((v: string) => setCurrentVersion(v)).catch(() => {})
  }, [])

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking')
    setUpdateError(null)
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

  return (
    <div className="max-w-lg space-y-6">
      {/* Version + Update */}
      <Section title="Tide Mind">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400">{t('about.version', 'Version')}</p>
              <p className="text-sm text-gray-200 font-mono mt-0.5">{updateInfo?.currentVersion ?? currentVersion}</p>
            </div>

            {updateStatus === 'idle' && (
              <button
                onClick={handleCheckUpdate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
                style={{ background: 'var(--theme-glass-bg)' }}
              >
                <RefreshCw size={11} />
                {t('about.checkUpdate', 'Check for Updates')}
              </button>
            )}

            {updateStatus === 'checking' && (
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <RefreshCw size={11} className="animate-spin" />
                {t('about.checking', 'Checking...')}
              </span>
            )}
          </div>

          {/* Up to date */}
          {updateStatus === 'up-to-date' && (
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle size={13} />
              <span className="text-xs">{t('about.upToDate', 'You are on the latest version.')}</span>
            </div>
          )}

          {/* Update available */}
          {updateStatus === 'available' && updateInfo && (
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

          {/* Error */}
          {updateStatus === 'error' && (
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

      {/* Links */}
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

      {/* License */}
      <Section title={t('about.license', 'License')}>
        <div className="text-xs text-gray-500 space-y-1">
          <p>MIT License</p>
          <p>&copy; 2024-{new Date().getFullYear()} TideMind Contributors</p>
        </div>
      </Section>
    </div>
  )
}
