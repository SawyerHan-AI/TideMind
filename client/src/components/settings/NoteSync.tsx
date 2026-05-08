import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, ChevronRight, RotateCcw, X,
  MoreHorizontal, BookOpen,
} from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { Section } from './shared'
import { useFormatters } from '../../hooks/useFormatters'
import type { NoteSource, NoteSourceStat } from './note-sync/types'
import { InitializingSourceCard } from './note-sync/InitializingSourceCard'
import { NoteSourceDetailPanel } from './note-sync/NoteSourceDetailPanel'
import { useAddNoteSourceInitialization } from './note-sync/useAddNoteSourceInitialization'
import {
  AddNoteSourceCompleteStep,
  AddNoteSourceInitStep,
} from './note-sync/AddNoteSourceInitStep'
import {
  AddNoteSourceConnectionStep,
  AddNoteSourceToolStep,
} from './note-sync/AddNoteSourceConnectionSteps'
import { getToolIcon, getToolLabel } from './note-sync/toolTypes'
import { useAddNoteSourceConnection } from './note-sync/useAddNoteSourceConnection'

// ============================================================
// 笔记同步: 列表 + 展开详情 + 添加向导
// ============================================================

// --- 状态指示 ---

function StatusDot({ status }: { status: 'online' | 'syncing' | 'offline' | 'paused' }) {
  const { t } = useTranslation('settings')
  const cfg = {
    online: { cls: 'bg-emerald-400 shadow-emerald-400/40 shadow-sm', label: t('noteSync.status.online') },
    syncing: { cls: 'bg-blue-400 shadow-blue-400/40 shadow-sm animate-pulse', label: t('noteSync.status.syncing') },
    offline: { cls: 'bg-red-400 shadow-red-400/40 shadow-sm', label: t('noteSync.status.offline') },
    paused: { cls: 'bg-gray-500', label: t('noteSync.status.paused') },
  }
  const { cls, label } = cfg[status]
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full inline-block ${cls}`} />
      <span className="text-[10px] text-gray-500">{label}</span>
    </span>
  )
}

// ============================================================
// 添加向导（Modal）
// ============================================================

function AddNoteSourceWizard({
  onClose,
}: {
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState(0)
  const {
    toolType,
    name,
    selectedPath,
    testResult,
    testing,
    permissionResult,
    checkingPermission,
    appleAccounts,
    selectedAccountZpks,
    loadingAccounts,
    canProceed,
    setName,
    selectToolType,
    setNotionToken,
    testNotionToken,
    selectFolderAndTest,
    checkAppleNotesPermission,
    toggleAccount,
    buildFinalPath,
  } = useAddNoteSourceConnection(step)

  const {
    createdSourceId,
    initPreview,
    initReport,
    createAndPreview,
    markInitStarted,
    onSessionTerminal,
    cleanupBeforeClose,
  } = useAddNoteSourceInitialization({
    onInitStep: () => setStep(2),
  })

  // Handle close with abort confirmation
  const handleClose = async () => {
    const shouldClose = await cleanupBeforeClose()
    if (shouldClose) onClose()
  }

  // Step 2 → Step 3: Create source + load preview
  const goToStep3 = async () => {
    await createAndPreview({
      name,
      toolType,
      path: buildFinalPath(),
    })
  }

  return (
    <Section
      title={t('noteSync.wizard.title')}
      action={<button onClick={handleClose} className="text-gray-500 hover:text-gray-300 transition-colors"><X size={16} /></button>}
    >
        <div>
          {/* Step 1: 选类型 + 命名 */}
          {step === 0 && (
            <AddNoteSourceToolStep
              toolType={toolType}
              name={name}
              onToolTypeChange={selectToolType}
              onNameChange={setName}
            />
          )}

          {step === 1 && (
            <AddNoteSourceConnectionStep
              toolType={toolType}
              selectedPath={selectedPath}
              testResult={testResult}
              testing={testing}
              permissionResult={permissionResult}
              checkingPermission={checkingPermission}
              appleAccounts={appleAccounts}
              selectedAccountZpks={selectedAccountZpks}
              loadingAccounts={loadingAccounts}
              onNotionTokenChange={setNotionToken}
              onTestNotion={testNotionToken}
              onSelectFolder={selectFolderAndTest}
              onCheckAppleNotesPermission={checkAppleNotesPermission}
              onToggleAccount={toggleAccount}
            />
          )}

          {/* Step 3: 初始化 */}
          {step === 2 && (
            <AddNoteSourceInitStep
              sourceId={createdSourceId}
              initPreview={initPreview}
              onSessionStarted={markInitStarted}
              onTerminal={(snap) => {
                onSessionTerminal(snap.status as 'done' | 'aborted' | 'error', snap.report)
                if (snap.status === 'done') setStep(3)
              }}
            />
          )}

          {/* Step 4: 完成 */}
          {step === 3 && (
            <AddNoteSourceCompleteStep initReport={initReport} />
          )}
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-white/5 flex justify-between">
          {step > 0 && step < 2 && (
            <button
              onClick={() => setStep(step - 1)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              {t('noteSync.wizard.prevStep')}
            </button>
          )}
          {step === 0 && <div />}
          {step >= 2 && <div />}

          {step === 0 && (
            <button
              onClick={() => setStep(1)}
              disabled={!name.trim()}
              className="px-4 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {t('noteSync.wizard.nextStep')}
            </button>
          )}
          {step === 1 && (
            <button
              onClick={goToStep3}
              disabled={!canProceed}
              className="px-4 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {t('noteSync.wizard.nextStep')}
            </button>
          )}
          {step === 3 && (
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
            >
              {t('noteSync.wizard.finish')}
            </button>
          )}
        </div>
    </Section>
  )
}

// ============================================================
// 主组件
// ============================================================

export function NoteSync() {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const { data: sources, refetch } = useIPC(() => window.api.noteSources.list(true))
  const [statsMap, setStatsMap] = useState<Record<string, NoteSourceStat>>({})
  const [wizardOpen, setWizardOpen] = useState(false)
  const [expandedSource, setExpandedSource] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const allSources = (sources ?? []) as NoteSource[]
  const activeSources = allSources.filter(s => !s.archived)
  const initializedSources = activeSources.filter(s => s.initialized)
  const uninitializedSources = activeSources.filter(s => !s.initialized)
  const archivedSources = allSources.filter(s => s.archived)

  // Load stats for active sources (poll every 3s while any source is syncing)
  useEffect(() => {
    if (activeSources.length === 0) return
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const loadStats = async () => {
      const map: Record<string, NoteSourceStat> = {}
      for (const s of activeSources) {
        try {
          map[s.id] = await window.api.noteSources.stats(s.id)
        } catch (err) {
          console.error(`加载笔记源统计失败 (${s.id}):`, err)
        }
      }
      if (!cancelled) {
        setStatsMap(map)
        // 有正在同步的源时持续轮询
        const anySyncing = Object.values(map).some(s => s.syncing)
        if (anySyncing && !timer) {
          timer = setInterval(loadStats, 3000)
        } else if (!anySyncing && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    }
    loadStats()

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [sources])

  const getStatus = (source: NoteSource): 'online' | 'syncing' | 'offline' | 'paused' => {
    if (source.archived) return 'paused'
    const stats = statsMap[source.id]
    if (stats?.syncing) return 'syncing'
    if (stats && stats.accessible === false) return 'offline'
    return 'online'
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <Section title={t('noteSync.title')}>
        <p className="text-xs text-gray-500 mb-4">
          {t('noteSync.description')}
        </p>

        {initializedSources.length === 0 && uninitializedSources.length === 0 && !wizardOpen && (
          <div className="py-8 text-center text-xs text-gray-500">
            {t('noteSync.empty')}
          </div>
        )}

        {initializedSources.length > 0 && (
          <div className="space-y-0.5">
            {/* Table header */}
            <div className="flex items-center gap-4 px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5">
              <span className="w-36">{t('noteSync.table.name')}</span>
              <span className="w-20">{t('noteSync.table.type')}</span>
              <span className="w-16">{t('noteSync.table.status')}</span>
              <span className="w-20 text-right">{t('noteSync.table.fileCount')}</span>
              <span className="w-28">{t('noteSync.table.lastSync')}</span>
              <span className="w-8"></span>
            </div>

            {initializedSources.map(source => {
              const status = getStatus(source)
              const stats = statsMap[source.id]
              const isExpanded = expandedSource === source.id

              return (
                <div key={source.id}>
                  <button
                    onClick={() => setExpandedSource(isExpanded ? null : source.id)}
                    className="w-full flex items-center gap-4 px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left"
                  >
                    <div className="w-36 flex items-center gap-2">
                      {getToolIcon(source.tool_type)}
                      <span className="text-xs text-gray-200 font-medium truncate">{source.name}</span>
                    </div>
                    <span className="w-20 text-xs text-gray-400">{getToolLabel(source.tool_type)}</span>
                    <div className="w-16">
                      <StatusDot status={status} />
                    </div>
                    <span className="w-20 text-xs text-gray-400 text-right tabular-nums">
                      {stats?.fileCount ? `${stats.fileCount}` : '-'}
                    </span>
                    <span className="w-28 text-xs text-gray-400 tabular-nums">
                      {source.last_synced ? timeAgo(source.last_synced) : '-'}
                    </span>
                    <span className="w-8 flex justify-end">
                      <MoreHorizontal size={14} className="text-gray-500" />
                    </span>
                  </button>

                  {isExpanded && (
                    <NoteSourceDetailPanel source={source} onRefetch={refetch} />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 已归档 */}
        {archivedSources.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              {t('noteSync.archived')} ({archivedSources.length})
            </button>
            {showArchived && (
              <div className="mt-2 space-y-0.5 pl-2 border-l border-white/5">
                {archivedSources.map(source => (
                  <div key={source.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                      <BookOpen size={14} className="text-gray-600" />
                      <span className="text-xs text-gray-500">{source.name}</span>
                      <span className="text-[10px] text-gray-600">{getToolLabel(source.tool_type)}</span>
                    </div>
                    <button
                      onClick={async () => {
                        await window.api.noteSources.unarchive(source.id)
                        refetch()
                      }}
                      className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      <RotateCcw size={10} />
                      {t('noteSync.restore')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* 初始化中/中断的笔记源 */}
      {uninitializedSources.map(source => (
        <InitializingSourceCard
          key={source.id}
          source={source}
          onRefetch={refetch}
        />
      ))}

      {/* 对接新笔记 — 有未完成初始化时隐藏（同一时刻只能初始化一个） */}
      {uninitializedSources.length === 0 && (
        !wizardOpen ? (
          <button
            onClick={() => setWizardOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5"
          >
            <Plus size={14} />
            {t('noteSync.wizard.title')}
          </button>
        ) : (
          <AddNoteSourceWizard
            onClose={() => {
              setWizardOpen(false)
              refetch()
            }}
          />
        )
      )}
    </div>
  )
}
