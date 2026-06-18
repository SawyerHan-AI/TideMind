import { useCallback } from 'react'
import { List, Network, Flame } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SearchInput } from '../SearchInput'
import { DERIVED_CATEGORY_LABELS } from '../../lib/constants'
import { useIPC } from '../../hooks/useIPC'
import type { ExplorerFilter } from '../../lib/api'

const NODE_TYPES = ['record', 'knowledge', 'belief', 'hypothesis', 'intention'] as const

const SORT_OPTION_KEYS = [
  { value: 'created', labelKey: 'sort.newest' },
  { value: 'heat', labelKey: 'sort.hottest' },
  { value: 'maturity_score', labelKey: 'sort.maturity' },
  { value: 'connectivity', labelKey: 'sort.connectivity' },
] as const

const selectClass = 'bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-[7px] text-xs text-gray-300 focus:outline-none focus:border-indigo-400/40 transition-colors appearance-none cursor-pointer hover:bg-white/[0.07]'

export function FilterBar({ filter, onFilterChange, viewMode, onViewModeChange, filtersDisabled = false }: {
  filter: ExplorerFilter
  onFilterChange: (patch: Partial<ExplorerFilter>) => void
  viewMode: 'list' | 'graph'
  onViewModeChange: (mode: 'list' | 'graph') => void
  // 搜索模式下后端只走 query+limit,type/tags/heat/sort 全不下推。控件灰化避免
  // 用户误以为过滤生效(实际是全库搜索)。见 BrainExplorer fetchList。
  filtersDisabled?: boolean
}) {
  const { t } = useTranslation('explorer')
  const fetchAllTags = useCallback(() => window.api.nodes.tags(), [])
  const { data: allTags } = useIPC(fetchAllTags)
  const coreTags = (allTags ?? []).filter(item => item.isCore)

  return (
    <div className="space-y-2.5">
      {/* Row 1: Search + View switcher */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchInput
            value={filter.search ?? ''}
            onChange={v => onFilterChange({ search: v })}
            placeholder={t('filter.searchPlaceholder')}
          />
        </div>
        <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
          <button
            onClick={() => onViewModeChange('list')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
              viewMode === 'list' ? 'bg-white/[0.1] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <List size={14} />
            {t('view.list')}
          </button>
          <button
            onClick={() => onViewModeChange('graph')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${
              viewMode === 'graph' ? 'bg-white/[0.1] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Network size={14} />
            {t('view.graph')}
          </button>
        </div>
      </div>

      {/* Row 2: Type + Tag + Sort + Heat */}
      <div className={`flex items-center gap-2 ${filtersDisabled ? 'opacity-40' : ''}`}>
        {/* 类型筛选 */}
        <select
          value={filter.type ?? ''}
          onChange={e => onFilterChange({ type: e.target.value || null })}
          disabled={filtersDisabled}
          className={`${selectClass} disabled:cursor-not-allowed`}
        >
          <option value="">{t('filter.allTypes')}</option>
          {NODE_TYPES.map(nt => (
            <option key={nt} value={nt}>{DERIVED_CATEGORY_LABELS[nt]}</option>
          ))}
        </select>

        {/* 标签筛选 */}
        {coreTags.length > 0 && (
          <select
            value={filter.tags ?? ''}
            onChange={e => onFilterChange({ tags: e.target.value || undefined })}
            disabled={filtersDisabled}
            className={`${selectClass} max-w-[180px] disabled:cursor-not-allowed`}
          >
            <option value="">{t('filter.allTags')}</option>
            {coreTags.map(item => <option key={item.tag} value={item.tag}>{item.tag} ({item.count})</option>)}
          </select>
        )}

        {/* 排序 */}
        <select
          value={filter.sortBy ?? 'created'}
          onChange={e => onFilterChange({ sortBy: e.target.value })}
          disabled={filtersDisabled}
          className={`${selectClass} disabled:cursor-not-allowed`}
        >
          {SORT_OPTION_KEYS.map(opt => (
            <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
          ))}
        </select>

        {/* 弹性间隔 */}
        <div className="flex-1" />

        {/* Heat 范围 */}
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Flame size={12} className={!filtersDisabled && filter.heatMin && filter.heatMin > 0.05 ? 'text-indigo-400' : ''} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={filter.heatMin ?? 0.05}
            onChange={e => onFilterChange({ heatMin: parseFloat(e.target.value) })}
            disabled={filtersDisabled}
            className="w-20 h-1 bg-white/10 rounded-full accent-indigo-400 cursor-pointer disabled:cursor-not-allowed"
            title={t('heat.minLabel', { value: (filter.heatMin ?? 0.05).toFixed(2) })}
          />
          <span className="w-6 text-right tabular-nums text-gray-400">{(filter.heatMin ?? 0.05).toFixed(2)}</span>
        </div>
      </div>

      {/* 搜索模式下过滤器不下推到后端,显式提示避免误解 */}
      {filtersDisabled && (
        <div className="text-[11px] text-gray-500 px-0.5">{t('filter.disabledInSearch')}</div>
      )}
    </div>
  )
}
