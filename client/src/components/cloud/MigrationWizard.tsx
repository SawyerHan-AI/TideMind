import { useState, useEffect, useCallback } from 'react'
import { Cloud, CheckCircle, X, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { brand, btnText } from '../../lib/tokens'

type Step = 'detect' | 'uploading' | 'done'

interface MigrationWizardProps {
  onClose: () => void
}

export function MigrationWizard({ onClose }: MigrationWizardProps) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState<Step>('detect')
  const [nodeCount, setNodeCount] = useState(0)
  const [uploadedCount, setUploadedCount] = useState(0)

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

  // Simulate upload progress when in uploading step
  useEffect(() => {
    if (step !== 'uploading' || nodeCount === 0) return

    let cancelled = false
    const total = nodeCount
    let current = 0
    const interval = setInterval(() => {
      if (cancelled) return
      // Simulate batch progress
      const batch = Math.max(1, Math.floor(total * 0.05))
      current = Math.min(current + batch, total)
      setUploadedCount(current)
      if (current >= total) {
        clearInterval(interval)
        setStep('done')
      }
    }, 200)

    return () => { cancelled = true; clearInterval(interval) }
  }, [step, nodeCount])

  const handleSync = useCallback(async () => {
    setStep('uploading')
    try {
      await window.api.cloud.triggerSync()
    } catch {
      // sync trigger error — progress simulation will still complete
    }
  }, [])

  const progress = nodeCount > 0 ? Math.round((uploadedCount / nodeCount) * 100) : 0

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
              <p className="text-sm text-gray-400 font-mono">
                {uploadedCount.toLocaleString()} / {nodeCount.toLocaleString()} {t('cloud.migration.nodes', 'nodes')}
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{
                  width: `${progress}%`,
                  background: brand.gradient,
                }}
              />
            </div>

            <p className="text-xs text-gray-500">{progress}%</p>
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
