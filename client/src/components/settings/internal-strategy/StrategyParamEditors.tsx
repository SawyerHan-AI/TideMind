import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { InfoTip } from '../../InfoTip'
import type { StrategyParam } from './types'

// ============================================================
// LLMConfigSection: 策略级 LLM 模型 + 思考配置
// ============================================================

const TIER_OPTION_KEYS = [
  { value: 'light', labelKey: 'strategy.tierLight' },
  { value: 'standard', labelKey: 'strategy.tierStandard' },
  { value: 'heavy', labelKey: 'strategy.tierHeavy' },
]

export function LLMConfigSection({ strategyName }: { strategyName: string }) {
  const { t } = useTranslation('settings')
  const [values, setValues] = useState<Record<string, number | string | boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.config.strategyParams(strategyName).then(params => {
      if (!cancelled) setValues(params)
    })
    return () => { cancelled = true }
  }, [strategyName])

  const handleChange = async (key: string, newValue: string) => {
    const parsed = newValue === 'true' ? true : newValue === 'false' ? false : isNaN(Number(newValue)) ? newValue : Number(newValue)
    setValues(prev => ({ ...prev, [key]: parsed }))
    setSaving(key)
    try {
      await window.api.config.strategyParamUpdate(strategyName, key, newValue)
    } catch (err) {
      console.error('LLM config update failed:', err)
    }
    setSaving(null)
  }

  const tier = String(values.llm_tier ?? 'standard')
  const thinkingOn = values.thinking === true
  const budget = Number(values.thinking_budget ?? 0)

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg text-xs">
      <span className="text-indigo-400/70 text-[10px] font-medium shrink-0">LLM</span>

      {/* 模型档位 */}
      <div className="flex items-center gap-1.5">
        <span className="text-gray-500 text-[10px]">{t('strategy.modelLabel')}</span>
        <select
          value={tier}
          onChange={e => handleChange('llm_tier', e.target.value)}
          className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 focus:outline-none focus:border-indigo-400/50 cursor-pointer"
        >
          {TIER_OPTION_KEYS.map(o => (
            <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
          ))}
        </select>
        {saving === 'llm_tier' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
      </div>

      {/* 思考开关 */}
      <div className="flex items-center gap-1.5">
        <span className="text-gray-500 text-[10px]">{t('strategy.thinkingLabel')}</span>
        <button
          onClick={() => handleChange('thinking', thinkingOn ? 'false' : 'true')}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
            thinkingOn
              ? 'bg-indigo-400/20 text-indigo-300 border border-indigo-400/30'
              : 'bg-white/5 text-gray-500 border border-white/10'
          }`}
        >
          {thinkingOn ? t('strategy.thinkingOn') : t('strategy.thinkingOff')}
        </button>
        {saving === 'thinking' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
      </div>

      {/* 思考预算 */}
      {thinkingOn && (
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500 text-[10px]">{t('strategy.budgetLabel')}</span>
          <input
            type="number"
            value={budget}
            step={512}
            min={256}
            onChange={e => handleChange('thinking_budget', e.target.value)}
            className="w-16 px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50"
          />
          <span className="text-gray-600 text-[10px]">tokens</span>
          {saving === 'thinking_budget' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
        </div>
      )}
    </div>
  )
}

// ============================================================
// EditableStrategyParams: 策略文件参数（可编辑）
// ============================================================

export function EditableStrategyParams({ params }: { params: StrategyParam[] }) {
  const { t } = useTranslation('settings')
  const strategyNames = [...new Set(params.map(p => p.strategyName))]
  const [values, setValues] = useState<Record<string, Record<string, number | string | boolean>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all(
      strategyNames.map(async name => {
        const p = await window.api.config.strategyParams(name)
        return [name, p] as const
      }),
    ).then(results => {
      if (cancelled) return
      const map: Record<string, Record<string, number | string | boolean>> = {}
      for (const [name, p] of results) map[name] = p
      setValues(map)
    })
    return () => { cancelled = true }
  }, [strategyNames.join(',')])

  const handleChange = async (strategyName: string, key: string, newValue: string) => {
    setValues(prev => ({
      ...prev,
      [strategyName]: { ...prev[strategyName], [key]: isNaN(Number(newValue)) ? newValue : Number(newValue) },
    }))
    setSaving(key)
    try {
      await window.api.config.strategyParamUpdate(strategyName, key, newValue)
    } catch (err) {
      console.error('Strategy param update failed:', err)
    }
    setSaving(null)
  }

  return (
    <>
      {params.map(p => {
        const val = values[p.strategyName]?.[p.key]
        return (
          <div key={`${p.strategyName}-${p.key}`} className="flex items-center gap-3">
            <div className="flex-1">
              <label className="flex items-center text-xs text-gray-300">
                {t(p.label)}
                <InfoTip content={t(p.tip)} />
                {saving === p.key && <Loader2 size={10} className="ml-1 animate-spin text-indigo-400" />}
              </label>
            </div>
            <input
              type="number"
              value={val !== undefined ? String(val) : ''}
              step={p.step ?? 1}
              onChange={e => handleChange(p.strategyName, p.key, e.target.value)}
              className="w-24 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50"
            />
          </div>
        )
      })}
    </>
  )
}
