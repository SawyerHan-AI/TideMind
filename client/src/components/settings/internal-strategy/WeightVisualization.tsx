import { useTranslation } from 'react-i18next'
import { semantic } from '../../../lib/tokens'

// ============================================================
// WeightVisualization
// ============================================================

export function WeightVisualization({ getVal }: { getVal: (s: string, k: string, f: number) => number }) {
  const { t } = useTranslation('settings')
  const weights = [
    { label: 'BM25 (\u03b1)', value: getVal('search', 'alpha', 0.3), color: semantic.blue },
    { label: t('strategy.nodes.searchWeights.beta'), value: getVal('search', 'beta', 0.5), color: semantic.purple },
    { label: t('strategy.nodes.searchWeights.gamma'), value: getVal('search', 'gamma', 0.1), color: semantic.amber },
    { label: t('strategy.nodes.searchWeights.delta'), value: getVal('search', 'delta', 0.1), color: semantic.teal },
  ]
  const total = weights.reduce((s, w) => s + w.value, 0)

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400">{t('strategy.weightDistribution')}</span>
        <span className="text-[10px] text-gray-500">({t('strategy.weightTotal', { total: total.toFixed(2) })})</span>
      </div>
      <div className="flex h-6 rounded-lg overflow-hidden border border-white/5">
        {weights.map(w => (
          <div
            key={w.label}
            style={{
              width: total > 0 ? `${(w.value / total) * 100}%` : '25%',
              backgroundColor: w.color,
              minWidth: w.value > 0 ? '2px' : 0,
            }}
            className="transition-all duration-300 flex items-center justify-center"
          >
            {w.value / total > 0.15 && (
              <span className="text-[9px] text-white font-medium truncate px-1">{w.label}</span>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-2">
        {weights.map(w => (
          <div key={w.label} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: w.color }} />
            <span className="text-[10px] text-gray-500">{w.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
