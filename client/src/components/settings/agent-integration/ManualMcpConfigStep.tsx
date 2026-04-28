import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolTypeDef } from './toolTypes'

interface ManualMcpConfigStepProps {
  toolDef?: ToolTypeDef
  mcpSnippet: string
  copied: string | null
  onCopy: (text: string, key: string) => void
  onPrevious: () => void
  onNext: () => void
}

export function ManualMcpConfigStep({
  toolDef,
  mcpSnippet,
  copied,
  onCopy,
  onPrevious,
  onNext,
}: ManualMcpConfigStepProps) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        {toolDef ? (
          <>{t('agent.wizard.addConfigTo')} <code className="text-gray-300 bg-white/5 px-1 py-0.5 rounded">{t(toolDef.configPathKey)}</code>:</>
        ) : (
          <>{t('agent.wizard.addConfigGeneric')}</>
        )}
      </p>
      <div className="relative">
        <pre className="px-4 py-3 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono overflow-x-auto leading-relaxed">
          {mcpSnippet}
        </pre>
        <button
          onClick={() => onCopy(mcpSnippet, 'mcp')}
          className="absolute top-2 right-2 p-1.5 bg-white/5 hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
        >
          {copied === 'mcp' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
        </button>
      </div>
      <div className="px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg">
        <p className="text-[10px] text-indigo-400">
          {t('agent.wizard.mcpConfigHint')}
        </p>
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
          onClick={onNext}
          className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors"
        >
          {t('agent.wizard.nextStep')}
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}
