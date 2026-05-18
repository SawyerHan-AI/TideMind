import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Maximize2, Route, Circle } from 'lucide-react'

interface GraphToolbarProps {
  neighborhoodDepth: number
  onNeighborhoodDepthChange: (depth: number) => void
  pathMode: boolean
  pathFrom: string | null
  onPathModeToggle: () => void
  showStructureHoles: boolean
  onStructureHolesToggle: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFitAll: () => void
  connectivityThreshold: number
  onConnectivityThresholdChange: (v: number) => void
  maxConnectivity: number
  /** P2-2 节点上限控件 */
  graphLimit?: number
  onGraphLimitChange?: (n: number) => void
  /** 实际渲染节点数(用作信息显示) */
  renderedNodeCount?: number
}

export function GraphToolbar({
  neighborhoodDepth,
  onNeighborhoodDepthChange,
  pathMode,
  pathFrom,
  onPathModeToggle,
  showStructureHoles,
  onStructureHolesToggle,
  onZoomIn,
  onZoomOut,
  onFitAll,
  connectivityThreshold,
  onConnectivityThresholdChange,
  maxConnectivity,
  graphLimit,
  onGraphLimitChange,
  renderedNodeCount,
}: GraphToolbarProps) {
  const { t } = useTranslation('explorer')

  const DEPTH_OPTIONS = [
    { value: 0, label: t('explorer:toolbar.all') },
    { value: 1, label: t('explorer:toolbar.hop1') },
    { value: 2, label: t('explorer:toolbar.hop2') },
    { value: 3, label: t('explorer:toolbar.hop3') },
  ]

  return (
    <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-3 flex-wrap">
      {/* Zoom controls */}
      <div className="flex items-center gap-1 glass-card rounded-lg px-2 py-1.5 border border-white/10">
        <button
          onClick={onZoomIn}
          className="p-1 rounded hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
          title={t('explorer:toolbar.zoomIn')}
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={onZoomOut}
          className="p-1 rounded hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
          title={t('explorer:toolbar.zoomOut')}
        >
          <ZoomOut size={14} />
        </button>
        <button
          onClick={onFitAll}
          className="p-1 rounded hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
          title={t('explorer:toolbar.fitAll')}
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {/* Neighborhood depth */}
      <div className="flex items-center gap-1 glass-card rounded-lg px-2 py-1.5 border border-white/10">
        {DEPTH_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onNeighborhoodDepthChange(opt.value)}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
              neighborhoodDepth === opt.value
                ? 'bg-white/15 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Path discovery */}
      <button
        onClick={onPathModeToggle}
        className={`flex items-center gap-1.5 glass-card rounded-lg px-3 py-1.5 border text-xs font-medium transition-all ${
          pathMode
            ? 'border-indigo-400/40 bg-indigo-400/15 text-indigo-300 shadow-glow-sm-blue'
            : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
        }`}
      >
        <Route size={13} />
        {t('explorer:toolbar.pathDiscovery')}
      </button>

      {/* Structure holes */}
      <button
        onClick={onStructureHolesToggle}
        className={`flex items-center gap-1.5 glass-card rounded-lg px-3 py-1.5 border text-xs font-medium transition-all ${
          showStructureHoles
            ? 'border-amber-500/40 bg-amber-500/15 text-amber-300 shadow-glow-sm-amber'
            : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
        }`}
      >
        <Circle size={13} />
        {t('explorer:toolbar.structureHoles')}
      </button>

      {/* Connectivity threshold */}
      {maxConnectivity > 0 && (
        <div className="flex items-center gap-2 glass-card rounded-lg px-3 py-1.5 border border-white/10">
          <span className="text-xs text-gray-400 whitespace-nowrap">{t('explorer:toolbar.connectivityLabel')}</span>
          <input
            type="range"
            min={0}
            max={maxConnectivity}
            value={connectivityThreshold}
            onChange={e => onConnectivityThresholdChange(Number(e.target.value))}
            className="w-20 h-1 accent-indigo-400"
          />
          <span className="text-xs text-gray-400 tabular-nums w-4 text-right">
            {connectivityThreshold}
          </span>
        </div>
      )}

      {/* Node limit (perf-optimization-2026-05-17 P2-2):d3 force 是 O(n²),
          万节点级别 vault 在没上限的情况下会锁死 renderer。 */}
      {graphLimit !== undefined && onGraphLimitChange && (
        <div className="flex items-center gap-2 glass-card rounded-lg px-3 py-1.5 border border-white/10">
          <span className="text-xs text-gray-400 whitespace-nowrap">{t('explorer:toolbar.nodeLimitLabel', { defaultValue: 'Top' })}</span>
          <select
            value={graphLimit}
            onChange={e => onGraphLimitChange(Number(e.target.value))}
            className="bg-transparent text-xs text-white tabular-nums focus:outline-none cursor-pointer"
          >
            <option value={200} className="bg-neutral-900">200</option>
            <option value={500} className="bg-neutral-900">500</option>
            <option value={1000} className="bg-neutral-900">1000</option>
            <option value={2000} className="bg-neutral-900">2000</option>
          </select>
          {renderedNodeCount !== undefined && (
            <span
              className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap"
              title={t('explorer:toolbar.nodeLimitHint', { defaultValue: '按 heat 高低取前 N 个节点 + 它们的 1-hop 邻居' })}
            >
              ({renderedNodeCount})
            </span>
          )}
        </div>
      )}

      {/* Path mode instruction */}
      {pathMode && (
        <div className="bg-indigo-400/15 backdrop-blur rounded-lg px-3 py-1.5 border border-indigo-400/30">
          <span className="text-xs text-indigo-300">
            {pathFrom ? t('explorer:toolbar.clickSecondNode') : t('explorer:toolbar.clickStartNode')}
          </span>
        </div>
      )}
    </div>
  )
}
