import { CheckCircle, ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Agent } from './types'
import type { PluginVerifyMcpMeta } from './toolTypes'
import { VerifyItem } from './VerifyItem'

interface AgentWizardVerifyStepProps {
  createdAgent: Agent
  usePlugin: boolean
  pluginGenerated: boolean
  desktopConfigWritten: boolean
  pluginToolLabel: string
  pluginVerifyMcp?: PluginVerifyMcpMeta
  isManual: boolean
  onPrevious: () => void
  onClose: () => void
}

export function AgentWizardVerifyStep({
  createdAgent,
  usePlugin,
  pluginGenerated,
  desktopConfigWritten,
  pluginToolLabel,
  pluginVerifyMcp,
  isManual,
  onPrevious,
  onClose,
}: AgentWizardVerifyStepProps) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">{t('agent.wizard.verifyDescription')}</p>
      <div className="space-y-2">
        <VerifyItem
          ok={true}
          label={t('agent.wizard.verifyAgentCreated', { name: createdAgent.name, id: createdAgent.id })}
        />
        {usePlugin && (
          <VerifyItem
            ok={pluginGenerated}
            label={t('agent.wizard.verifyPluginGenerated', {
              tool: pluginToolLabel,
            })}
          />
        )}
        {pluginVerifyMcp && (
          <VerifyItem
            ok={desktopConfigWritten}
            label={t(pluginVerifyMcp.labelKey)}
            hint={t(desktopConfigWritten ? pluginVerifyMcp.hintOkKey : pluginVerifyMcp.hintFailKey)}
          />
        )}
        {isManual && (
          <>
            <VerifyItem
              ok={false}
              label={t('agent.wizard.verifyMcpAdded')}
              hint={t('agent.wizard.verifyMcpAddedHint')}
            />
            <VerifyItem
              ok={false}
              label={t('agent.wizard.verifySkillCopied')}
              hint={t('agent.wizard.verifySkillCopiedHint')}
            />
            <VerifyItem
              ok={false}
              label={t('agent.wizard.verifyToolRestarted')}
            />
          </>
        )}
        <VerifyItem
          ok={!!createdAgent.last_active}
          label={t('agent.wizard.verifyFirstConnection')}
          hint={!createdAgent.last_active ? t('agent.wizard.verifyFirstConnectionHint') : undefined}
        />
      </div>
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onPrevious}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          <ChevronLeft size={14} />
          {t('agent.wizard.prevStep')}
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium text-white transition-colors"
        >
          <CheckCircle size={14} />
          {t('agent.wizard.finish')}
        </button>
      </div>
    </div>
  )
}
