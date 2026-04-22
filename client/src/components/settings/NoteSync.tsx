import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, ChevronRight, FolderOpen, Check, Loader2,
  RefreshCw, Archive, RotateCcw, Pencil, X,
  MoreHorizontal, FileText, Zap, BookOpen, AlertCircle, CheckCircle,
  StickyNote, ShieldCheck, ShieldAlert, Play, Trash2,
} from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { Section, NumberField } from './shared'
import { useFormatters } from '../../hooks/useFormatters'

// ============================================================
// 笔记同步: 列表 + 展开详情 + 添加向导
// ============================================================

interface NoteSource {
  id: string
  name: string
  tool_type: string
  path: string
  poll_interval: number
  archived: number
  initialized: number
  created: string
  last_synced: string | null
}

interface NoteSourceStat {
  fileCount: number
  nodeCount: number
  lastSynced: string | null
  syncing?: boolean
  accessible?: boolean
}

// --- 工具类型定义 ---

interface ToolTypeDef {
  id: string
  label: string
  icon: React.ReactNode
  comingSoon?: boolean
}

// 检测当前平台是否为 macOS（Apple Notes 仅在 macOS 可用）
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const TOOL_TYPES: ToolTypeDef[] = [
  { id: 'logseq', label: 'Logseq', icon: <BookOpen size={14} /> },
  { id: 'obsidian', label: 'Obsidian', icon: <FileText size={14} /> },
  { id: 'apple-notes', label: 'Apple Notes', icon: <StickyNote size={14} />, comingSoon: !IS_MAC },
  { id: 'notion', label: 'Notion', icon: <FileText size={14} /> },
]

// Apple Notes 账户类型
interface AppleNotesAccount {
  zpk: number
  name: string
  uuid: string
  userRecordName: string | null
  noteCount: number
}

// 权限检测结果
interface PermissionCheckResult {
  accessible: boolean
  path: string
  error?: string
}

function getToolLabel(toolType: string): string {
  return TOOL_TYPES.find(tt => tt.id === toolType)?.label ?? toolType
}

function getToolIcon(toolType: string): React.ReactNode {
  const def = TOOL_TYPES.find(tt => tt.id === toolType)
  if (def) {
    // Render with gray-500 color for list display
    if (toolType === 'logseq') return <BookOpen size={14} className="text-gray-500 flex-shrink-0" />
    if (toolType === 'obsidian') return <FileText size={14} className="text-gray-500 flex-shrink-0" />
    if (toolType === 'apple-notes') return <StickyNote size={14} className="text-gray-500 flex-shrink-0" />
  }
  return <BookOpen size={14} className="text-gray-500 flex-shrink-0" />
}

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
// 展开详情面板
// ============================================================

function NoteSourceDetailPanel({
  source,
  onRefetch,
}: {
  source: NoteSource
  onRefetch: () => void
}) {
  const { t } = useTranslation('settings')
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState(source.name)
  const [pollInterval, setPollInterval] = useState(source.poll_interval)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ accessible: boolean; fileCount: number } | null>(null)
  const [importing, setImporting] = useState(false)
  // P2-NEW-J: pollInterval 初始值直接来自 source.poll_interval（props），
  // 之前用 setTimeout(200) 只是为了绕开 mount 时那次 setState → effect 触发
  // 的"初始相等写回"，硬编码延迟既不稳也不对。改成：比较当前 pollInterval
  // 和 source 的原始值，值未变则跳过写回（避免把自己写成自己）。
  const intervalInitialized = useRef(false)

  useEffect(() => {
    // 切换 source 时重置 ref（下一次 pollInterval effect 才能跳过首次写回）
    intervalInitialized.current = false
  }, [source.id])

  // debounce 自动保存 interval 变化
  useEffect(() => {
    // 第一次触发跳过：这一次是 mount 或 source 切换导致的初始化，
    // pollInterval 等于 source.poll_interval，不需要写回
    if (!intervalInitialized.current) {
      intervalInitialized.current = true
      return
    }
    const timer = setTimeout(async () => {
      await (window as any).api.noteSources.update(source.id, { pollInterval })
    }, 500)
    return () => clearTimeout(timer)
  }, [pollInterval, source.id])

  const handleRename = async () => {
    if (newName.trim() && newName !== source.name) {
      await (window as any).api.noteSources.update(source.id, { name: newName.trim() })
      onRefetch()
    }
    setEditing(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await (window as any).api.noteSources.test(source.tool_type, source.path)
      setTestResult(result)
    } catch {
      setTestResult({ accessible: false, fileCount: 0 })
    }
    setTesting(false)
  }

  const handleRescan = async () => {
    setImporting(true)
    try {
      await (window as any).api.noteSources.triggerImport(source.id)
    } catch (err) {
      console.error('重新扫描失败:', err)
    }
    setImporting(false)
  }

  const handleArchive = async () => {
    await (window as any).api.noteSources.archive(source.id)
    onRefetch()
  }

  return (
    <div className="ml-6 mr-3 mb-3 p-3 bg-white/[0.02] rounded-lg border border-white/5 space-y-3">
      {/* 名称编辑 */}
      <div className="flex items-center gap-2">
        {editing ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }}
              autoFocus
              className="flex-1 px-2 py-1 text-xs bg-white/[0.06] border border-white/[0.1] rounded text-gray-200 focus:outline-none focus:border-blue-500/50"
            />
            <button onClick={handleRename} className="text-emerald-400 hover:text-emerald-300"><Check size={12} /></button>
            <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-gray-300"><X size={12} /></button>
          </div>
        ) : (
          <button onClick={() => { setNewName(source.name); setEditing(true) }} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors">
            <Pencil size={10} />
            {t('noteSync.detail.rename')}
          </button>
        )}
      </div>

      {/* 路径 */}
      <div>
        <label className="text-[10px] text-gray-500 mb-1 block">{t('noteSync.detail.watchPath')}</label>
        <div className="flex gap-2">
          <div className="flex-1 px-3 py-2 rounded-lg text-xs text-gray-300 bg-white/[0.04] border border-white/[0.06] truncate">
            {source.tool_type === 'apple-notes'
              ? source.path.split('?')[0]
              : source.tool_type === 'notion'
                ? `ntn_${'*'.repeat(8)}`
                : source.path}
          </div>
          {source.tool_type !== 'apple-notes' && source.tool_type !== 'notion' && (
            <button
              onClick={async () => {
                const folder = await (window as any).api.config.selectFolder()
                if (folder) {
                  await (window as any).api.noteSources.update(source.id, { path: folder })
                  onRefetch()
                }
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors whitespace-nowrap"
            >
              <FolderOpen size={12} />
              {t('noteSync.detail.changePath')}
            </button>
          )}
        </div>
      </div>

      {/* 轮询间隔 */}
      <NumberField
        label={t('noteSync.detail.pollInterval')}
        tip={t('noteSync.detail.pollIntervalTip')}
        value={pollInterval}
        onChange={setPollInterval}
        unit={t('noteSync.detail.seconds')}
        step={10}
      />

      {/* 操作按钮 */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50"
        >
          {testing && <Loader2 size={12} className="animate-spin" />}
          {t('noteSync.detail.testConnection')}
        </button>

        <button
          onClick={handleRescan}
          disabled={importing}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50"
        >
          {importing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('noteSync.detail.rescan')}
        </button>

        {testResult && (
          <span className={`text-[11px] ${testResult.accessible ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.accessible
              ? t('noteSync.detail.testAccessible', { count: testResult.fileCount })
              : t('noteSync.detail.testInaccessible')}
          </span>
        )}
      </div>

      {/* 归档 */}
      <div className="pt-2 border-t border-white/5">
        <button
          onClick={handleArchive}
          className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-yellow-400 transition-colors"
        >
          <Archive size={10} />
          {t('noteSync.detail.archive')}
        </button>
      </div>
    </div>
  )
}

// ============================================================
// 初始化中/中断 卡片
// ============================================================

const PHASE_KEYS = ['scan', 'preprocess', 'digest', 'explicitLinks', 'annotate', 'landing', 'linkEval', 'keystone', 'emergence'] as const

type InitCardState = 'interrupted' | 'running' | 'complete' | 'error'

function InitializingSourceCard({
  source,
  onRefetch,
}: {
  source: NoteSource
  onRefetch: () => void
}) {
  const { t } = useTranslation('settings')
  const [state, setState] = useState<InitCardState>('interrupted')
  const [totalFiles, setTotalFiles] = useState<number | null>(null)
  const [syncedFiles, setSyncedFiles] = useState<number>(0)
  const [initProgress, setInitProgress] = useState<{
    phase: number; phaseName: string; current: number; total: number; status: string
  } | null>(null)
  const [initReport, setInitReport] = useState<any>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // mount 时获取总文件数、已同步数，并检查是否有正在进行的初始化
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const testResult = await (window as any).api.noteSources.test(source.tool_type, source.path)
        if (!cancelled) setTotalFiles(testResult?.fileCount ?? null)
      } catch { /* ignore */ }
      try {
        const stats = await (window as any).api.noteSources.stats(source.id)
        if (!cancelled) setSyncedFiles(stats?.fileCount ?? 0)
      } catch { /* ignore */ }
      // 检查是否有正在进行的初始化（如从概览页跳转过来）
      try {
        const prog = await (window as any).api.noteSources.initProgress(source.id)
        if (cancelled) return
        if (prog && prog.status === 'running') {
          setState('running')
          setInitProgress(prog)
          // 启动轮询（与 handleContinue 中的轮询共享完成/错误检测逻辑）
          // 注意：await 之后再检查 cancelled，避免卸载后赋值泄漏
          const timer = setInterval(async () => {
            try {
              const p = await (window as any).api.noteSources.initProgress(source.id)
              if (p && p.status !== 'idle') {
                setInitProgress(p)
                if (p.status === 'done') {
                  clearInterval(timer)
                  pollRef.current = null
                  // 初始化已完成，刷新列表
                  onRefetch()
                }
                if (p.status === 'error') {
                  clearInterval(timer)
                  pollRef.current = null
                  setState('error')
                  setInitError(p.error ?? '')
                }
              } else if (p && p.status === 'idle') {
                // 进度已 reset 为 idle，说明初始化结束了，刷新
                clearInterval(timer)
                pollRef.current = null
                onRefetch()
              }
            } catch { /* ignore */ }
          }, 2000)
          // P2-NEW-I: 覆盖之前的 timer 前先清理，避免 mount 轮询和 handleContinue
          // 轮询同时存活导致泄漏
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = timer
        }
      } catch { /* ignore */ }
    }
    load()
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [source.id])

  // 清理轮询
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handleContinue = async () => {
    setState('running')
    setInitError(null)
    setInitProgress({ phase: 0, phaseName: t('noteSync.wizard.starting'), current: 0, total: 0, status: 'running' })

    // P2-NEW-I: 覆盖之前 mount 轮询的 timer 前先清理
    if (pollRef.current) clearInterval(pollRef.current)
    // 开始轮询进度
    pollRef.current = setInterval(async () => {
      try {
        const prog = await (window as any).api.noteSources.initProgress(source.id)
        if (prog && prog.status !== 'idle') {
          setInitProgress(prog)
          if (prog.status === 'error') {
            if (pollRef.current) clearInterval(pollRef.current)
          }
          if (prog.status === 'done') {
            if (pollRef.current) clearInterval(pollRef.current)
          }
        }
      } catch { /* ignore */ }
    }, 2000)

    try {
      const res = await (window as any).api.noteSources.initStart(source.id)
      if (pollRef.current) clearInterval(pollRef.current)
      if (res?.success) {
        setState('complete')
        setInitReport(res.data)
        setTimeout(() => onRefetch(), 3000)
      } else {
        setState('error')
        setInitError(res?.error ?? t('noteSync.wizard.unknownError'))
      }
    } catch (err) {
      if (pollRef.current) clearInterval(pollRef.current)
      setState('error')
      setInitError((err as Error).message)
    }
  }

  const handleAbort = async () => {
    setAborting(true)
    await (window as any).api.noteSources.initAbort(source.id)
  }

  const handleDiscard = async () => {
    if (!confirm(t('noteSync.init.discardConfirm'))) return
    setDiscarding(true)
    try {
      await (window as any).api.noteSources.rollback(source.id)
    } catch { /* ignore */ }
    onRefetch()
  }

  const pct = totalFiles && totalFiles > 0
    ? Math.round((syncedFiles / totalFiles) * 100)
    : 0

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
                  style={{ width: `${Math.max(2, pct)}%` }}
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
              onClick={() => { setState('interrupted'); setInitError(null) }}
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

  // Step 1 state
  const [toolType, setToolType] = useState('logseq')
  const [name, setName] = useState('')

  // Step 2 state
  const [selectedPath, setSelectedPath] = useState('')
  const [testResult, setTestResult] = useState<{ accessible: boolean; fileCount: number } | null>(null)
  const [testing, setTesting] = useState(false)

  // Apple Notes 专用 state
  const [permissionResult, setPermissionResult] = useState<PermissionCheckResult | null>(null)
  const [checkingPermission, setCheckingPermission] = useState(false)
  const [appleAccounts, setAppleAccounts] = useState<AppleNotesAccount[]>([])
  const [selectedAccountZpks, setSelectedAccountZpks] = useState<Set<number>>(new Set())
  const [loadingAccounts, setLoadingAccounts] = useState(false)

  // Step 3 state (init)
  const [createdSourceId, setCreatedSourceId] = useState<string | null>(null)
  const [initPreview, setInitPreview] = useState<any>(null)
  const [initStarted, setInitStarted] = useState(false)
  const [initProgress, setInitProgress] = useState<any>(null)
  const [initReport, setInitReport] = useState<any>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const step3CancelledRef = useRef(false)

  // Auto-generate name based on tool type
  useEffect(() => {
    if (!name) {
      setName(getToolLabel(toolType))
    }
  }, [toolType])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Handle close with abort confirmation
  const handleClose = async () => {
    step3CancelledRef.current = true
    if (initStarted && !initReport && !initError) {
      if (!confirm(t('noteSync.wizard.confirmAbort'))) return
      // Abort + rollback
      if (createdSourceId) {
        await (window as any).api.noteSources.initAbort(createdSourceId)
        // Give a moment for abort to take effect
        await new Promise(r => setTimeout(r, 1000))
        await (window as any).api.noteSources.rollback(createdSourceId)
      }
    } else if (createdSourceId && !initReport) {
      // Created source but didn't finish init — clean up
      await (window as any).api.noteSources.rollback(createdSourceId)
    }
    if (pollRef.current) clearInterval(pollRef.current)
    onClose()
  }

  // Apple Notes: 权限检测
  const checkAppleNotesPermission = useCallback(async () => {
    setCheckingPermission(true)
    setPermissionResult(null)
    try {
      const result = await (window as any).api.noteSources.appleNotesCheckPermission()
      setPermissionResult(result)
      if (result.accessible) {
        // 权限通过后自动加载账户
        setLoadingAccounts(true)
        try {
          const accounts = await (window as any).api.noteSources.appleNotesListAccounts()
          setAppleAccounts(accounts)
          // 默认全选所有账户
          setSelectedAccountZpks(new Set(accounts.map((a: AppleNotesAccount) => a.zpk)))
        } finally {
          setLoadingAccounts(false)
        }
      }
    } catch (err) {
      setPermissionResult({ accessible: false, path: '', error: (err as Error).message })
    } finally {
      setCheckingPermission(false)
    }
  }, [])

  // Apple Notes: 进入 Step 1 时自动检测权限
  useEffect(() => {
    if (step === 1 && toolType === 'apple-notes' && !permissionResult && !checkingPermission) {
      checkAppleNotesPermission()
    }
  }, [step, toolType, permissionResult, checkingPermission, checkAppleNotesPermission])

  // Apple Notes: 切换账户选择
  const toggleAccount = (zpk: number) => {
    const newSet = new Set(selectedAccountZpks)
    if (newSet.has(zpk)) {
      newSet.delete(zpk)
    } else {
      newSet.add(zpk)
    }
    setSelectedAccountZpks(newSet)
  }

  // Step 2: Select folder and auto-test
  const handleSelectFolder = async () => {
    const folder = await (window as any).api.config.selectFolder()
    if (!folder) return
    setSelectedPath(folder)
    setTestResult(null)
    setTesting(true)
    try {
      const result = await (window as any).api.noteSources.test(toolType, folder)
      setTestResult(result)
    } catch {
      setTestResult({ accessible: false, fileCount: 0 })
    }
    setTesting(false)
  }

  // Step 2 → Step 3: Create source + load preview
  const goToStep3 = async () => {
    step3CancelledRef.current = false

    // 为 Apple Notes 构建带 accounts 参数的 path
    let finalPath = selectedPath
    if (toolType === 'apple-notes' && permissionResult?.accessible) {
      const accountsParam = Array.from(selectedAccountZpks).join(',')
      finalPath = `${permissionResult.path}?accounts=${accountsParam}`
    }

    // Create the note source
    const source = await (window as any).api.noteSources.create({
      name: name.trim(),
      toolType,
      path: finalPath,
    })
    if (step3CancelledRef.current) return
    setCreatedSourceId(source.id)
    setStep(2)

    // Load preview
    try {
      const res = await (window as any).api.noteSources.initPreview(source.id)
      if (step3CancelledRef.current) return
      if (res.success) {
        setInitPreview(res.data)
      } else {
        setInitError(res.error)
      }
    } catch (err: any) {
      if (!step3CancelledRef.current) setInitError(err.message)
    }
  }

  // Step 3: Start initialization
  const startInit = async () => {
    if (!createdSourceId) return
    setInitStarted(true)
    setInitProgress({ phase: 0, phaseName: t('noteSync.wizard.starting'), current: 0, total: 0, status: 'running' })

    // Start polling progress
    pollRef.current = setInterval(async () => {
      try {
        const prog = await (window as any).api.noteSources.initProgress(createdSourceId)
        if (prog) {
          setInitProgress(prog)
          if (prog.status === 'error') {
            clearInterval(pollRef.current!)
            pollRef.current = null
            setInitError(prog.error ?? t('noteSync.wizard.unknownError'))
          }
        }
      } catch (err) {
        console.error('轮询初始化进度失败:', err)
      }
    }, 2000)

    // initStart 会阻塞到初始化完成
    const res = await (window as any).api.noteSources.initStart(createdSourceId)
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    // P3-NEW-F: await 可能跨越 unmount / handleClose；回来后若已取消就不要
    // setInitReport / setStep / setInitError，避免"已卸载组件 setState"警告
    // 和无谓的 step 切换。复用 step3CancelledRef（handleClose 中会置 true）。
    if (step3CancelledRef.current) return
    if (res.success) {
      setInitReport(res.data)
      setStep(3)
    } else {
      setInitError(res.error)
    }
  }

  // Step 3: Abort
  const handleAbort = async () => {
    if (!createdSourceId) return
    setAborting(true)
    await (window as any).api.noteSources.initAbort(createdSourceId)
    // 停止轮询并显示已中断状态
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setInitError(t('noteSync.wizard.aborted'))
    setAborting(false)
  }

  return (
    <Section
      title={t('noteSync.wizard.title')}
      action={<button onClick={handleClose} className="text-gray-500 hover:text-gray-300 transition-colors"><X size={16} /></button>}
    >
        <div>
          {/* Step 1: 选类型 + 命名 */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <label className="text-xs text-gray-400 mb-2 block">{t('noteSync.wizard.noteTool')}</label>
                <div className="grid grid-cols-4 gap-2">
                  {TOOL_TYPES.map(tt => (
                    <button
                      key={tt.id}
                      disabled={tt.comingSoon}
                      onClick={() => {
                        setToolType(tt.id)
                        if (!name || TOOL_TYPES.some(item => item.label === name)) {
                          setName(tt.label)
                        }
                      }}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                        tt.comingSoon
                          ? 'bg-white/[0.01] border-white/5 text-gray-600 cursor-not-allowed'
                          : toolType === tt.id
                            ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                            : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {tt.icon}
                        {tt.label}
                        {tt.comingSoon && <span className="text-[9px] text-gray-600">{t('noteSync.wizard.comingSoon')}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 mb-1 block">{t('noteSync.wizard.name')}</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('noteSync.wizard.namePlaceholder')}
                  className="w-full px-3 py-2 text-xs bg-white/[0.06] border border-white/[0.08] rounded-lg text-gray-200 focus:outline-none focus:border-blue-500/50"
                />
              </div>
            </div>
          )}

          {/* Step 2 for Notion: Token 输入 */}
          {step === 1 && toolType === 'notion' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-2 block">
                  {t('noteSync.wizard.notionTokenLabel')}
                </label>
                <div className="text-[11px] text-gray-500 mb-3 leading-relaxed">
                  {t('noteSync.wizard.notionTokenHint')}
                </div>
                <input
                  type="password"
                  value={selectedPath}
                  onChange={(e) => {
                    const val = e.target.value.trim()
                    setSelectedPath(val.startsWith('notion://') ? val : `notion://${val}`)
                    setTestResult(null)
                  }}
                  placeholder={t('noteSync.wizard.notionTokenPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg text-xs text-gray-200 bg-white/[0.06] border border-white/[0.08] placeholder:text-gray-600 focus:outline-none focus:border-white/[0.15]"
                />
              </div>

              {selectedPath && (
                <button
                  onClick={async () => {
                    setTesting(true)
                    setTestResult(null)
                    try {
                      const result = await (window as any).api.noteSources.test('notion', selectedPath)
                      setTestResult(result)
                    } finally {
                      setTesting(false)
                    }
                  }}
                  disabled={testing}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors"
                >
                  {testing ? <Loader2 size={12} className="animate-spin" /> : null}
                  {t('noteSync.detail.testConnection')}
                </button>
              )}

              {testResult && (
                <div className={`text-xs ${testResult.accessible ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult.accessible
                    ? t('noteSync.wizard.notionConnected')
                    : t('noteSync.wizard.notionFailed')}
                </div>
              )}

              <div className="text-[11px] text-gray-600 leading-relaxed">
                {t('noteSync.wizard.notionScopeHint')}
              </div>
            </div>
          )}

          {/* Step 2: 选路径 + 验证（Logseq/Obsidian） */}
          {step === 1 && toolType !== 'apple-notes' && toolType !== 'notion' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-2 block">
                  {t('noteSync.wizard.selectDataDir', { tool: getToolLabel(toolType) })}
                </label>
                <div className="flex gap-2">
                  <div className={`flex-1 px-3 py-2 rounded-lg text-xs truncate ${
                    selectedPath
                      ? 'text-gray-200 bg-white/[0.06] border border-white/[0.08]'
                      : 'text-gray-500 bg-white/[0.03] border border-white/[0.05]'
                  }`}>
                    {selectedPath || t('noteSync.wizard.noFolderSelected')}
                  </div>
                  <button
                    onClick={handleSelectFolder}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors whitespace-nowrap"
                  >
                    <FolderOpen size={12} />
                    {t('noteSync.wizard.selectFolder')}
                  </button>
                </div>
              </div>

              {testing && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader2 size={12} className="animate-spin" />
                  {t('noteSync.wizard.detecting')}
                </div>
              )}

              {testResult && (
                <div className={`text-xs ${testResult.accessible ? 'text-emerald-400' : 'text-red-400'}`}>
                  {testResult.accessible
                    ? t('noteSync.wizard.testAccessible', { count: testResult.fileCount })
                    : t('noteSync.wizard.testInaccessible')}
                </div>
              )}
            </div>
          )}

          {/* Step 2 for Apple Notes: 权限检测 + 账户选择 */}
          {step === 1 && toolType === 'apple-notes' && (
            <div className="space-y-4">
              {/* 权限检测中 */}
              {checkingPermission && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader2 size={12} className="animate-spin" />
                  {t('noteSync.wizard.appleNotesCheckingPermission')}
                </div>
              )}

              {/* 无权限：显示引导 */}
              {permissionResult && !permissionResult.accessible && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                    <ShieldAlert size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-xs text-red-400 font-medium mb-1">
                        {t('noteSync.wizard.appleNotesNoPermission')}
                      </div>
                      <div className="text-[11px] text-gray-400 leading-relaxed">
                        {t('noteSync.wizard.appleNotesPermissionGuide')}
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px] text-gray-500 space-y-1 pl-2">
                    <div>1. {t('noteSync.wizard.appleNotesStep1')}</div>
                    <div>2. {t('noteSync.wizard.appleNotesStep2')}</div>
                    <div>3. {t('noteSync.wizard.appleNotesStep3')}</div>
                    <div>4. {t('noteSync.wizard.appleNotesStep4')}</div>
                  </div>
                  <button
                    onClick={checkAppleNotesPermission}
                    disabled={checkingPermission}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    {t('noteSync.wizard.appleNotesRecheckPermission')}
                  </button>
                </div>
              )}

              {/* 有权限：账户选择 */}
              {permissionResult && permissionResult.accessible && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <ShieldCheck size={14} className="text-emerald-400" />
                    <div className="text-xs text-emerald-400">
                      {t('noteSync.wizard.appleNotesPermissionGranted')}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-2 block">
                      {t('noteSync.wizard.appleNotesSelectAccounts')}
                    </label>
                    {loadingAccounts && (
                      <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                        <Loader2 size={12} className="animate-spin" />
                        {t('noteSync.wizard.appleNotesLoadingAccounts')}
                      </div>
                    )}
                    {!loadingAccounts && appleAccounts.length === 0 && (
                      <div className="text-xs text-gray-500 py-2">
                        {t('noteSync.wizard.appleNotesNoAccounts')}
                      </div>
                    )}
                    {!loadingAccounts && appleAccounts.length > 0 && (
                      <div className="space-y-1.5">
                        {appleAccounts.map(acc => (
                          <label
                            key={acc.zpk}
                            className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.06] border border-white/[0.06] cursor-pointer transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedAccountZpks.has(acc.zpk)}
                              onChange={() => toggleAccount(acc.zpk)}
                              className="w-3.5 h-3.5 rounded accent-indigo-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-gray-200 truncate">{acc.name}</div>
                              {acc.userRecordName && (
                                <div className="text-[10px] text-gray-500 truncate">iCloud</div>
                              )}
                            </div>
                            <div className="text-[11px] text-gray-400 tabular-nums">
                              {t('noteSync.wizard.appleNotesNoteCount', { count: acc.noteCount })}
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: 初始化 */}
          {step === 2 && (
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
                          {initPreview.breakdown.map((item: { label: string; count: number }) => (
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
                      <span>{t('noteSync.wizard.total')}</span><span>${initPreview.estimatedCost.total}</span>
                    </div>
                  </div>
                  <button
                    onClick={startInit}
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
                    onClick={handleAbort}
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
          )}

          {/* Step 4: 完成 */}
          {step === 3 && (
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
              disabled={
                toolType === 'apple-notes'
                  ? !permissionResult?.accessible || selectedAccountZpks.size === 0
                  : !testResult?.accessible
              }
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
  const { data: sources, refetch } = useIPC(() => (window as any).api.noteSources.list(true))
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
          map[s.id] = await (window as any).api.noteSources.stats(s.id)
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
                        await (window as any).api.noteSources.unarchive(source.id)
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
