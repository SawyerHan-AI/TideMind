import { useState, useEffect, useCallback } from 'react'
import { Cloud, CheckCircle, AlertCircle, X, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { brand, btnText } from '../../lib/tokens'

type Step = 'detect' | 'uploading' | 'done' | 'error'

interface MigrationWizardProps {
  onClose: () => void
}

export function MigrationWizard({ onClose }: MigrationWizardProps) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState<Step>('detect')
  const [nodeCount, setNodeCount] = useState(0)
  const [syncError, setSyncError] = useState<string | null>(null)

  // Detect local node count on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stats = await window.api.stats.overview()
        if (!cancelled) setNodeCount(stats?.totalNodes ?? 0)
      } catch {
        // fallback — could not get count
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSync = useCallback(async () => {
    setStep('uploading')
    setSyncError(null)
    try {
      await window.api.cloud.triggerSync()
      setStep('done')
    } catch (err) {
      setSyncError((err as Error).message ?? 'Sync failed')
      setStep('error')
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl p-6"
        style={{
          background: 'rgba(20, 20, 22, 0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X size={16} />
        </button>

        {/* Step: Detect */}
        {step === 'detect' && (
          <div className="text-center space-y-5">
            <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(129,140,248,0.12)' }}
            >
              <Cloud size={24} className="text-indigo-400" />
            </div>

            <div>
              <h2 className="text-lg font-semibold text-white mb-2">
                {t('cloud.migration.detectTitle', 'Sync to Cloud?')}
              </h2>
              <p className="text-sm text-gray-400 leading-relaxed">
                {t('cloud.migration.detectDesc', 'We detected {{count}} nodes in your local brain. Would you like to sync them to the cloud?', { count: nodeCount.toLocaleString() })}
              </p>
            </div>

            <div className="flex items-center gap-3 justify-center pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('cloud.migration.later', 'Later')}
              </button>
              <button
                onClick={handleSync}
                disabled={nodeCount === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:brightness-110 disabled:opacity-40"
                style={{
                  background: brand.gradientAlpha,
                  border: `1px solid ${brand.secondary}4d`,
                  color: btnText.onBrand,
                }}
              >
                <ArrowRight size={14} />
                {t('cloud.migration.sync', 'Sync Now')}
              </button>
            </div>
          </div>
        )}

        {/* Step: Uploading */}
        {step === 'uploading' && (
          <div className="text-center space-y-5">
            <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(129,140,248,0.12)' }}
            >
              <Cloud size={24} className="text-indigo-400 animate-pulse" />
            </div>

            <div>
              <h2 className="text-lg font-semibold text-white mb-2">
                {t('cloud.migration.uploadingTitle', 'Uploading...')}
              </h2>
              <p className="text-sm text-gray-400">
                {t('cloud.migration.uploadingDesc', 'Syncing {{count}} nodes to the cloud…', { count: nodeCount.toLocaleString() })}
              </p>
            </div>

            {/* Indeterminate progress bar */}
            <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full animate-pulse"
                style={{ background: brand.gradient, width: '100%' }}
              />
            </div>
          </div>
        )}

        {/* Step: Error */}
        {step === 'error' && (
          <div className="text-center space-y-5">
            <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center bg-red-500/15">
              <AlertCircle size={24} className="text-red-400" />
            </div>

            <div>
              <h2 className="text-lg font-semibold text-white mb-2">
                {t('cloud.migration.errorTitle', 'Sync Failed')}
              </h2>
              {syncError && (
                <p className="text-sm text-red-300 leading-relaxed">{syncError}</p>
              )}
            </div>

            <div className="flex items-center gap-3 justify-center pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('cloud.migration.later', 'Later')}
              </button>
              <button
                onClick={handleSync}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:brightness-110"
                style={{
                  background: brand.gradientAlpha,
                  border: `1px solid ${brand.secondary}4d`,
                  color: btnText.onBrand,
                }}
              >
                {t('cloud.migration.retry', 'Retry')}
              </button>
            </div>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div className="text-center space-y-5">
            <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center bg-emerald-500/15">
              <CheckCircle size={24} className="text-emerald-400" />
            </div>

            <div>
              <h2 className="text-lg font-semibold text-white mb-2">
                {t('cloud.migration.doneTitle', 'Migration Complete')}
              </h2>
              <p className="text-sm text-gray-400 leading-relaxed">
                {t('cloud.migration.doneDesc', 'Your brain is now in the cloud. Changes will sync automatically across devices.')}
              </p>
            </div>

            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all hover:brightness-110"
              style={{
                background: brand.gradientAlpha,
                border: `1px solid ${brand.secondary}4d`,
                color: btnText.onBrand,
              }}
            >
              {t('cloud.migration.done', 'Done')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
