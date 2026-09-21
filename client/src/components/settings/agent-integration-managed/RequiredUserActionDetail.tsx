import { useState } from 'react'
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentIntegrationRequiredUserActionDto } from '../../../lib/api-contract'
import { componentLabelKey, safeDisplayTarget } from './presentation'

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 min-[520px]:grid-cols-[116px_minmax(0,1fr)]">
      <dt className="text-gray-400">{label}</dt>
      <dd className={`min-w-0 break-all text-gray-300 ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </div>
  )
}

export function RequiredUserActionDetail({ action }: { action: AgentIntegrationRequiredUserActionDto }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState<'configuration' | 'instruction' | null>(null)
  const [copyError, setCopyError] = useState<'configuration' | 'instruction' | null>(null)

  const copy = async (kind: 'configuration' | 'instruction', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setCopyError(null)
    } catch {
      setCopied(null)
      setCopyError(kind)
    }
  }

  const instruction = action.kind === 'custom_mcp_import'
    ? t(`agent.managed.custom.${action.operation === 'connect' ? 'guidedConnect' : 'guidedDisconnect'}`, { connector: action.connectorName }) : action.kind === 'codex_hook_trust'
    ? t('agent.managed.userAction.codexHookTrust')
    : action.kind === 'claude_cowork_plugin_upload'
      ? t(`agent.managed.userAction.${action.operation === 'connect' ? 'claudeCoworkUpload' : 'claudeCoworkRemove'}`)
      : action.kind === 'qwenwork_mcp_gui'
        ? t(`agent.managed.userAction.${action.operation === 'connect' ? 'qwenWorkConnect' : 'qwenWorkDisconnect'}`)
        : action.kind === 'mcp_activation'
          ? t('agent.managed.actionDetail.instruction.mcpActivation', { server: action.serverName, config: safeDisplayTarget(action.configLabel) })
          : action.kind === 'manual_file_removal'
            ? t('agent.managed.actionDetail.instruction.manualFileRemoval', { target: safeDisplayTarget(action.physicalTargetLabel) })
            : t('agent.managed.actionDetail.instruction.kimiConflict')

  const steps = action.kind === 'custom_mcp_import'
    ? (action.operation === 'connect' ? ['guidedImportStep', 'guidedVerifyStep'] : ['guidedRemoveStep'])
      .map(key => t(`agent.managed.custom.${key}`, { connector: action.connectorName })) : action.kind === 'claude_cowork_plugin_upload'
    ? (action.operation === 'connect'
        ? [1, 2, 3, 4].map(index => t(`agent.managed.actionDetail.guidance.claudeCowork.connect.step${index}`))
        : [1, 2, 3].map(index => t(`agent.managed.actionDetail.guidance.claudeCowork.disconnect.step${index}`)))
    : action.kind === 'qwenwork_mcp_gui'
      ? (action.operation === 'connect'
          ? [1, 2, 3, 4].map(index => t(`agent.managed.actionDetail.guidance.qwenWork.connect.step${index}`))
          : [1, 2, 3].map(index => t(`agent.managed.actionDetail.guidance.qwenWork.disconnect.step${index}`, { connector: action.connectorName })))
      : action.kind === 'kimi_instruction_conflict'
        ? [1, 2, 3].map(index => t(`agent.managed.actionDetail.guidance.kimiConflict.step${index}`, {
            source: safeDisplayTarget(action.sourceLabel),
            target: safeDisplayTarget(action.targetLabel),
          }))
        : []

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.055] p-2.5 text-xs leading-relaxed text-amber-200">
      <p>{instruction}</p>

      {action.kind === 'codex_hook_trust' && (
        <div className="space-y-1">
          <dl><Fact label={t('agent.managed.actionDetail.source')} value={action.sourceLabel} mono /></dl>
          <p className="text-gray-400">{t('agent.managed.codexTrust.planNotice')}</p>
        </div>
      )}

      {action.kind === 'claude_cowork_plugin_upload' && (
        <dl className="space-y-1">
          <Fact label={t('agent.managed.actionDetail.package')} value={action.packageLabel} mono />
        </dl>
      )}

      {(action.kind === 'qwenwork_mcp_gui' || action.kind === 'custom_mcp_import') && (
        <div className="space-y-2">
          <dl className="space-y-1">
            <Fact label={t('agent.managed.actionDetail.connector')} value={action.connectorName} />
            <Fact label={t('agent.managed.actionDetail.serverType')} value={action.serverType} mono />
          </dl>
          <CopyableValue
            label={t('agent.managed.actionDetail.mcpConfiguration')}
            value={action.configurationJson}
            copied={copied === 'configuration'}
            error={copyError === 'configuration'}
            onCopy={() => void copy('configuration', action.configurationJson)}
          />
          {action.kind === 'custom_mcp_import' && action.operation === 'connect' && <CopyableValue
            label={t('agent.managed.component.instruction')}
            value={action.usageGuide} copied={copied === 'instruction'} error={copyError === 'instruction'}
            onCopy={() => void copy('instruction', action.usageGuide)}
          />}
        </div>
      )}

      {action.kind === 'mcp_activation' && (
        <dl className="space-y-1">
          <Fact label={t('agent.managed.actionDetail.server')} value={action.serverName} mono />
          <Fact label={t('agent.managed.actionDetail.config')} value={safeDisplayTarget(action.configLabel)} mono />
          <Fact label={t('agent.managed.actionDetail.reason')} value={t(`agent.managed.actionDetail.activationReason.${action.reason}`)} />
        </dl>
      )}

      {action.kind === 'manual_file_removal' && (
        <dl className="space-y-1">
          <Fact label={t('agent.managed.actionDetail.component')} value={t(componentLabelKey(action.componentKey))} />
          <Fact label={t('agent.managed.actionDetail.target')} value={safeDisplayTarget(action.physicalTargetLabel)} mono />
        </dl>
      )}

      {action.kind === 'kimi_instruction_conflict' && (
        <dl className="space-y-1">
          <Fact label={t('agent.managed.actionDetail.source')} value={safeDisplayTarget(action.sourceLabel)} mono />
          <Fact label={t('agent.managed.actionDetail.target')} value={safeDisplayTarget(action.targetLabel)} mono />
          <Fact label={t('agent.managed.actionDetail.reason')} value={t(`agent.managed.actionDetail.kimiConflictReason.${action.reason}`)} />
        </dl>
      )}

      {steps.length > 0 && (
        <div>
          <p className="text-gray-400">{t('agent.managed.actionDetail.steps')}</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-gray-300">
            {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
          </ol>
        </div>
      )}
    </div>
  )
}

function CopyableValue({
  label,
  value,
  copied,
  error,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  error: boolean
  onCopy: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-gray-400">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={t('agent.managed.actionDetail.copyValue', { label })}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-gray-400 hover:bg-white/[0.06] hover:text-gray-200"
        >
          <Copy size={11} aria-hidden />
          {copied ? t('agent.managed.actionDetail.copied') : t('agent.managed.actionDetail.copy')}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-white/[0.06] bg-black/10 p-2 font-mono text-[11px] text-gray-300">{value}</pre>
      {error && <p className="mt-1 text-red-300" role="alert">{t('agent.managed.actionDetail.copyFailed')}</p>}
    </div>
  )
}
