import { ChevronRight, Package } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { inputClass } from '../shared'
import { TOOL_TYPES } from './toolTypes'

interface ToolSelectionStepProps {
  agentName: string
  setAgentName: (value: string) => void
  toolType: string
  setToolType: (value: string) => void
  customToolType: string
  setCustomToolType: (value: string) => void
  effectiveToolType: string
  usePlugin: boolean
  creating: boolean
  onCreateAndNext: () => void
}

export function ToolSelectionStep({
  agentName,
  setAgentName,
  toolType,
  setToolType,
  customToolType,
  setCustomToolType,
  effectiveToolType,
  usePlugin,
  creating,
  onCreateAndNext,
}: ToolSelectionStepProps) {
  const { t } = useTranslation('settings')

  return (
    <div className="space-y-4">
      <div>
        <label className="text-[11px] text-gray-400 mb-1.5 block">{t('agent.table.toolType')}</label>
        <div className="grid grid-cols-4 gap-2">
          {TOOL_TYPES.map(item => (
            <button
              key={item.id}
              onClick={() => {
                if (item.comingSoon) return
                setToolType(item.id)
                if (!agentName || TOOL_TYPES.some(tt => tt.label === agentName)) {
                  setAgentName(item.label)
                }
              }}
              disabled={item.comingSoon}
              className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                item.comingSoon
                  ? 'bg-white/[0.01] border-white/5 text-gray-600 cursor-not-allowed'
                  : toolType === item.id
                    ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                    : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
              }`}
            >
              <span className="flex items-center gap-1">
                {item.label}
                {item.comingSoon && <span className="text-[9px] text-gray-600">{t('agent.wizard.comingSoon')}</span>}
                {!item.comingSoon && item.pluginSupport && <Package size={10} className="opacity-50" />}
              </span>
            </button>
          ))}
          <button
            onClick={() => {
              setToolType('other')
              if (!customToolType) {
                setCustomToolType(`custom-${Math.random().toString(36).slice(2, 6)}`)
              }
            }}
            className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
              toolType === 'other'
                ? 'bg-indigo-400/10 border-indigo-400/30 text-indigo-400'
                : 'bg-white/[0.02] border-white/5 text-gray-300 hover:bg-white/[0.05]'
            }`}
          >
            {t('agent.wizard.other')}
          </button>
        </div>
        {usePlugin && (
          <p className="text-[10px] text-emerald-400/70 mt-1.5 flex items-center gap-1">
            <Package size={10} />
            {t('agent.wizard.pluginSupportHint')}
          </p>
        )}
      </div>

      <div>
        <label className="text-[11px] text-gray-400 mb-1.5 block">{t('agent.wizard.agentName')}</label>
        <input
          value={agentName}
          onChange={e => setAgentName(e.target.value)}
          placeholder={t('agent.wizard.agentNamePlaceholder')}
          className={`${inputClass} w-full text-xs`}
        />
        <p className="text-[10px] text-gray-500 mt-1">
          {t('agent.wizard.agentNameHint')}
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onCreateAndNext}
          disabled={!agentName.trim() || !effectiveToolType.trim() || creating}
          className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? t('agent.wizard.creating') : t('agent.wizard.createAndContinue')}
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}
