import { FolderOpen, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AppleNotesAccount,
  NoteSourceTestResult,
  PermissionCheckResult,
} from './types'
import { getToolLabel, TOOL_TYPES } from './toolTypes'

export function AddNoteSourceToolStep({
  toolType,
  name,
  onToolTypeChange,
  onNameChange,
}: {
  toolType: string
  name: string
  onToolTypeChange: (toolType: string) => void
  onNameChange: (name: string) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-5">
      <div>
        <label className="text-xs text-gray-400 mb-2 block">{t('noteSync.wizard.noteTool')}</label>
        <div className="grid grid-cols-4 gap-2">
          {TOOL_TYPES.map(tool => (
            <button
              key={tool.id}
              disabled={tool.comingSoon}
              onClick={() => onToolTypeChange(tool.id)}
              className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                tool.comingSoon
                  ? 'bg-white/[0.01] border-white/5 text-gray-600 cursor-not-allowed'
                  : toolType === tool.id
                    ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                    : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {tool.icon}
                {tool.label}
                {tool.comingSoon && <span className="text-[9px] text-gray-600">{t('noteSync.wizard.comingSoon')}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-400 mb-1 block">{t('noteSync.wizard.name')}</label>
        <input
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder={t('noteSync.wizard.namePlaceholder')}
          className="w-full px-3 py-2 text-xs bg-white/[0.06] border border-white/[0.08] rounded-lg text-gray-200 focus:outline-none focus:border-blue-500/50"
        />
      </div>
    </div>
  )
}

export function AddNoteSourceConnectionStep({
  toolType,
  selectedPath,
  testResult,
  testing,
  permissionResult,
  checkingPermission,
  appleAccounts,
  selectedAccountZpks,
  loadingAccounts,
  onNotionTokenChange,
  onTestNotion,
  onSelectFolder,
  onCheckAppleNotesPermission,
  onToggleAccount,
}: {
  toolType: string
  selectedPath: string
  testResult: NoteSourceTestResult | null
  testing: boolean
  permissionResult: PermissionCheckResult | null
  checkingPermission: boolean
  appleAccounts: AppleNotesAccount[]
  selectedAccountZpks: Set<number>
  loadingAccounts: boolean
  onNotionTokenChange: (token: string) => void
  onTestNotion: () => void
  onSelectFolder: () => void
  onCheckAppleNotesPermission: () => void
  onToggleAccount: (zpk: number) => void
}) {
  const { t } = useTranslation('settings')

  if (toolType === 'notion') {
    return (
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
            onChange={e => onNotionTokenChange(e.target.value)}
            placeholder={t('noteSync.wizard.notionTokenPlaceholder')}
            className="w-full px-3 py-2 rounded-lg text-xs text-gray-200 bg-white/[0.06] border border-white/[0.08] placeholder:text-gray-600 focus:outline-none focus:border-white/[0.15]"
          />
        </div>

        {selectedPath && (
          <button
            onClick={onTestNotion}
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
    )
  }

  if (toolType !== 'apple-notes') {
    return (
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
              onClick={onSelectFolder}
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
    )
  }

  return (
    <div className="space-y-4">
      {checkingPermission && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 size={12} className="animate-spin" />
          {t('noteSync.wizard.appleNotesCheckingPermission')}
        </div>
      )}

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
            onClick={onCheckAppleNotesPermission}
            disabled={checkingPermission}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] rounded-lg text-gray-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} />
            {t('noteSync.wizard.appleNotesRecheckPermission')}
          </button>
        </div>
      )}

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
                {appleAccounts.map(account => (
                  <label
                    key={account.zpk}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.06] border border-white/[0.06] cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAccountZpks.has(account.zpk)}
                      onChange={() => onToggleAccount(account.zpk)}
                      className="w-3.5 h-3.5 rounded accent-indigo-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-200 truncate">{account.name}</div>
                      {account.userRecordName && (
                        <div className="text-[10px] text-gray-500 truncate">iCloud</div>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-400 tabular-nums">
                      {t('noteSync.wizard.appleNotesNoteCount', { count: account.noteCount })}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
