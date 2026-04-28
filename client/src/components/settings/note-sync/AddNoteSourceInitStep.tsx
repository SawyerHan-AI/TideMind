import { AlertCircle, CheckCircle, FileText, Loader2, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InitPreview, InitProgress, InitReport } from './types'

const PHASE_NAMES = [
  'scan',
  'preprocess',
  'import',
  'links',
  'annotate',
  'landing',
  'evaluate',
  'keystone',
  'emerge',
] as const

export function AddNoteSourceInitStep({
  initPreview,
  initStarted,
  initProgress,
  initError,
  aborting,
  onStart,
  onAbort,
}: {
  initPreview: InitPreview | null
  initStarted: boolean
  initProgress: InitProgress | null
  initError: string | null
  aborting: boolean
  onStart: () => void
  onAbort: () => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-4">
      {/* 预览 */}
      {initPreview && !initStarted && (
        <>
          <h3 className="text-xs font-medium text-white flex items-center gap-2">
            <FileText size={14} />
            {t('noteSync.wizard.initPreview')}
          </h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-white/[0.04] rounded-lg p-3">
              <div className="text-gray-500 mb-1">{t('noteSync.wizard.totalFiles')}</div>
              <div className="text-lg text-white font-medium">{initPreview.totalFiles ?? 0}</div>
              {initPreview.breakdown && initPreview.breakdown.length > 1 && (
                <div className="mt-2 space-y-1 text-[11px] text-gray-500 border-t border-white/5 pt-2">
                  {initPreview.breakdown.map(item => (
                    <div key={item.label} className="flex justify-between">
                      <span>{t(`noteSync.wizard.breakdown.${item.label}`, item.label)}</span>
                      <span className="text-gray-400 tabular-nums">{item.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="bg-white/[0.04] rounded-lg p-3">
              <div className="text-gray-500 mb-1">{t('noteSync.wizard.estimatedNodes')}</div>
              <div className="text-lg text-white font-medium">~{initPreview.estimatedNodes}</div>
            </div>
          </div>
          <div className="bg-white/[0.04] rounded-lg p-3 text-xs">
            <div className="text-gray-500 mb-2">{t('noteSync.wizard.estimatedCost')}</div>
            <div className="flex justify-between text-white font-medium">
              <span>{t('noteSync.wizard.total')}</span><span>${initPreview.estimatedCost?.total ?? 0}</span>
            </div>
          </div>
          <button
            onClick={onStart}
            className="w-full py-2 bg-indigo-500 hover:bg-indigo-400 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <Zap size={14} />
            {t('noteSync.wizard.startInit')}
          </button>
        </>
      )}

      {/* 进度 */}
      {initStarted && initProgress && !initError && (
        <>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {t('noteSync.wizard.initInProgress')}
          </h3>
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
            {PHASE_NAMES.map((pname, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i < initProgress.phase ? 'bg-green-500'
                  : i === initProgress.phase ? 'bg-indigo-400'
                  : 'bg-white/[0.06]'
                }`}
                title={`Phase ${i}: ${pname}`}
              />
            ))}
          </div>
          <button
            onClick={onAbort}
            disabled={aborting}
            className="w-full py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            {aborting ? t('noteSync.wizard.aborting') : t('noteSync.wizard.abort')}
          </button>
        </>
      )}

      {/* 错误 */}
      {initError && (
        <div className="space-y-3 p-4 bg-white/[0.03] rounded-xl border border-red-500/20">
          <h3 className="text-sm font-medium text-red-400 flex items-center gap-2">
            <AlertCircle size={14} />
            {t('noteSync.wizard.initFailed')}
          </h3>
          <div className="text-xs text-red-300">{initError}</div>
        </div>
      )}

      {/* Loading preview */}
      {!initPreview && !initError && !initStarted && (
        <div className="flex items-center gap-2 text-gray-400 py-8 justify-center">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">{t('noteSync.wizard.scanning')}</span>
        </div>
      )}
    </div>
  )
}

export function AddNoteSourceCompleteStep({
  initReport,
}: {
  initReport: InitReport | null
}) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-green-400 flex items-center gap-2">
        <CheckCircle size={14} />
        {t('noteSync.wizard.complete')}
      </h3>
      {initReport && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            [t('noteSync.wizard.reportNodes'), initReport.nodesCreated],
            [t('noteSync.wizard.reportLinks'), initReport.linksCreated],
            [t('noteSync.wizard.reportCrystals'), initReport.crystalsCreated],
            [t('noteSync.wizard.reportFiles'), initReport.totalFiles],
            [t('noteSync.wizard.reportDuration'), `${Math.round((initReport.durationMs ?? 0) / 1000)}s`],
            [t('noteSync.wizard.reportCost'), `$${initReport.totalCost ?? 0}`],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-white/[0.04] rounded-lg p-2">
              <div className="text-gray-500">{label}</div>
              <div className="text-white font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
