import { Check, ChevronLeft, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolTypeDef } from './toolTypes'

interface ManualSkillFileStepProps {
  toolDef?: ToolTypeDef
  skillContent: string
  skillLoaded: boolean
  usingBaseFallback: boolean
  copied: string | null
  onCopy: (text: string, key: string) => void
  onPrevious: () => void
  onNext: () => void
}

export function ManualSkillFileStep({
  toolDef,
  skillContent,
  skillLoaded,
  usingBaseFallback,
  copied,
  onCopy,
  onPrevious,
  onNext,
}: ManualSkillFileStepProps) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        {toolDef ? (
          <>{t('agent.wizard.copySkillTo')} <code className="text-gray-300 bg-white/5 px-1 py-0.5 rounded">{t(toolDef.skillPathKey)}</code>:</>
        ) : (
          <>{t('agent.wizard.copySkillGeneric')}</>
        )}
      </p>
      {!skillLoaded ? (
        <div className="flex items-center gap-2 py-8 justify-center text-xs text-gray-500">
          <Loader2 size={14} className="animate-spin" />
          {t('agent.wizard.loading')}
        </div>
      ) : (
        <>
          <div className="relative">
            <pre className="px-4 py-3 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-gray-300 font-mono overflow-x-auto leading-relaxed max-h-56 overflow-y-auto">
              {skillContent}
            </pre>
            <button
              onClick={() => onCopy(skillContent, 'skill')}
              className="absolute top-2 right-2 p-1.5 bg-white/5 hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
            >
              {copied === 'skill' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          </div>
          <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/10 rounded-lg">
            <p className="text-[10px] text-amber-400">
              {t('agent.wizard.skillHint')}
            </p>
          </div>
          {usingBaseFallback && (
            <div className="px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded-lg">
              <p className="text-[10px] text-blue-400">
                {t('agent.wizard.baseFallbackHint')}
              </p>
            </div>
          )}
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
        </>
      )}
    </div>
  )
}
