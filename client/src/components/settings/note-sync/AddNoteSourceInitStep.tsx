import { AlertCircle, CheckCircle, FileText, Loader2, Zap } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { InitPreview, InitReport } from './types'
import type { NoteSourceInitSnapshot } from '../../../lib/api-contract'
import { useInitSession } from './useInitSession'

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

/**
 * Onboarding 第 3 步：展示预览 → 启动 → 显示进度。
 *
 * 状态完全由 useInitSession 驱动，不再由父组件传 initStarted/initProgress/initError。
 * 父组件只需提供 sourceId（createAndPreview 后从 useAddNoteSourceInitialization 拿）。
 *
 * 当会话进入终态（done / aborted / error）时，调用 onTerminal——父组件据此切到下一步。
 */
export function AddNoteSourceInitStep({
  sourceId,
  initPreview,
  onSessionStarted,
  onTerminal,
}: {
  sourceId: string | null
  initPreview: InitPreview | null
  /** 会话首次进入 running 时调用一次。父组件用于标记 cleanupBeforeClose 行为分支。 */
  onSessionStarted?: () => void
  /** 会话进入终态（done / aborted / error）时回调。 */
  onTerminal?: (snapshot: NoteSourceInitSnapshot) => void
}) {
  const { t } = useTranslation('settings')

  const { snapshot, uiState, aborting, start, abort } = useInitSession(sourceId, {
    onTerminal: (snap) => onTerminal?.(snap),
  })

  // 第一次看到 running 时通知父组件
  const startedNotifiedRef = useRef(false)
  useEffect(() => {
    if (uiState === 'running' && !startedNotifiedRef.current) {
      startedNotifiedRef.current = true
      onSessionStarted?.()
    }
  }, [uiState, onSessionStarted])

  const showPreview = uiState === 'idle' || uiState === 'loading'
  const showProgress = uiState === 'running' || uiState === 'aborting'
  const showError = uiState === 'error'

  return (
    <div className="space-y-4">
      {/* 预览 */}
      {showPreview && initPreview && (
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
            onClick={start}
            disabled={!sourceId}
            className="w-full py-2 bg-indigo-500 hover:bg-indigo-400 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Zap size={14} />
            {t('noteSync.wizard.startInit')}
          </button>
        </>
      )}

      {/* 进度 */}
      {showProgress && snapshot && (
        <>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {t('noteSync.wizard.initInProgress')}
          </h3>
          <div className="text-xs text-gray-400">
            Phase {snapshot.progress.phase}/8: {snapshot.progress.phaseName}
          </div>
          <div className="w-full bg-white/[0.06] rounded-full h-2">
            <div
              className="bg-indigo-400 h-2 rounded-full transition-all duration-500"
              style={{ width: `${snapshot.progress.total > 0 ? Math.max(5, Math.round((snapshot.progress.current / snapshot.progress.total) * 100)) : 5}%` }}
            />
          </div>
          <div className="text-xs text-gray-500 text-center">
            {snapshot.progress.current} / {snapshot.progress.total}
          </div>
          <div className="flex gap-0.5">
            {PHASE_NAMES.map((pname, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i < snapshot.progress.phase ? 'bg-green-500'
                  : i === snapshot.progress.phase ? 'bg-indigo-400'
                  : 'bg-white/[0.06]'
                }`}
                title={`Phase ${i}: ${pname}`}
              />
            ))}
          </div>
          <button
            onClick={abort}
            disabled={aborting || uiState === 'aborting'}
            className="w-full py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            {aborting || uiState === 'aborting'
              ? t('noteSync.wizard.aborting')
              : t('noteSync.wizard.abort')}
          </button>
        </>
      )}

      {/* 错误 */}
      {showError && snapshot && (
        <div className="space-y-3 p-4 bg-white/[0.03] rounded-xl border border-red-500/20">
          <h3 className="text-sm font-medium text-red-400 flex items-center gap-2">
            <AlertCircle size={14} />
            {t('noteSync.wizard.initFailed')}
          </h3>
          {snapshot.error && <div className="text-xs text-red-300">{snapshot.error}</div>}
        </div>
      )}

      {/* Loading preview */}
      {!initPreview && !showProgress && !showError && uiState !== 'done' && uiState !== 'aborted' && (
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
