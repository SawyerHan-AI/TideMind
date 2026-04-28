import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { NoteSource } from './types'
import { useInitializingSource } from './useInitializingSource'

const PHASE_KEYS = ['scan', 'preprocess', 'digest', 'explicitLinks', 'annotate', 'landing', 'linkEval', 'keystone', 'emergence'] as const

export function InitializingSourceCard({
  source,
  onRefetch,
}: {
  source: NoteSource
  onRefetch: () => void
}) {
  const { t } = useTranslation('settings')
  const {
    state,
    totalFiles,
    syncedFiles,
    processedPct,
    initProgress,
    initReport,
    initError,
    aborting,
    discarding,
    handleContinue,
    handleAbort,
    handleDiscard,
    resetToInterrupted,
  } = useInitializingSource({ source, onRefetch })

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 space-y-3">
      {/* 中断态 */}
      {state === 'interrupted' && (
        <>
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-amber-400 flex-shrink-0" />
            <span className="text-xs text-white font-medium">{source.name}</span>
            <span className="text-[10px] text-amber-400">{t('noteSync.init.interrupted')}</span>
          </div>
          {totalFiles !== null && (
            <>
              <div className="text-[11px] text-gray-400">
                {t('noteSync.init.processedFiles', { current: syncedFiles, total: totalFiles })}
              </div>
              <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                <div
                  className="bg-amber-400 h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.max(2, processedPct)}%` }}
                />
              </div>
            </>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleContinue}
              className="flex items-center gap-2 px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors"
            >
              <Play size={12} />
              {t('noteSync.init.continueInit')}
            </button>
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              <Trash2 size={12} />
              {t('noteSync.init.discard')}
            </button>
          </div>
        </>
      )}

      {/* 进行中 */}
      {state === 'running' && initProgress && (
        <>
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="text-indigo-400 animate-spin flex-shrink-0" />
            <span className="text-xs text-white font-medium">{source.name}</span>
            <span className="text-[10px] text-indigo-400">{t('noteSync.init.inProgress')}</span>
          </div>
          <div className="text-xs text-gray-400">
            Phase {initProgress.phase}/8: {initProgress.phaseName}
          </div>
          <div className="w-full bg-white/[0.06] rounded-full h-2">
            <div
              className="bg-indigo-400 h-2 rounded-full transition-all duration-500"
              style={{ width: `${initProgress.total > 0 ? Math.max(5, Math.round((initProgress.current / initProgress.total) * 100)) : 5}%` }}
            />
          </div>
          <div className="text-xs text-gray-500 text-center">
            {initProgress.current} / {initProgress.total}
          </div>
          <div className="flex gap-0.5">
            {PHASE_KEYS.map((key, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i < initProgress.phase ? 'bg-green-500'
                  : i === initProgress.phase ? 'bg-indigo-400'
                  : 'bg-white/[0.06]'
                }`}
                title={`Phase ${i}: ${t(`noteSync.init.phase.${key}`)}`}
              />
            ))}
          </div>
          <button
            onClick={handleAbort}
            disabled={aborting}
            className="w-full py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            {aborting ? t('noteSync.wizard.aborting') : t('noteSync.wizard.abort')}
          </button>
        </>
      )}

      {/* 完成 */}
      {state === 'complete' && (
        <>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-emerald-400 flex-shrink-0" />
            <span className="text-xs text-white font-medium">{source.name}</span>
            <span className="text-[10px] text-emerald-400">{t('noteSync.init.complete')}</span>
          </div>
          {initReport && (
            <div className="grid grid-cols-4 gap-2 text-xs">
              {[
                [t('noteSync.wizard.reportNodes'), initReport.nodesCreated],
                [t('noteSync.wizard.reportLinks'), initReport.linksCreated],
                [t('noteSync.wizard.reportCrystals'), initReport.crystalsCreated],
                [t('noteSync.wizard.reportDuration'), `${Math.round((initReport.durationMs ?? 0) / 1000)}s`],
              ].map(([label, value]) => (
                <div key={label as string} className="bg-white/[0.04] rounded-lg p-2 text-center">
                  <div className="text-gray-500 text-[10px]">{label}</div>
                  <div className="text-white font-medium">{value}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 错误 */}
      {state === 'error' && (
        <>
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
            <span className="text-xs text-white font-medium">{source.name}</span>
            <span className="text-[10px] text-red-400">{t('noteSync.wizard.initFailed')}</span>
          </div>
          {initError && <div className="text-xs text-red-300">{initError}</div>}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={resetToInterrupted}
              className="flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors"
            >
              <RefreshCw size={12} />
              {t('noteSync.init.continueInit')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
