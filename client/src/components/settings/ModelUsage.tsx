import { useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Info, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { useFormatters } from '../../hooks/useFormatters'
import { Section } from './shared'
import {
  EVENT_TYPE_LABELS, EVENT_TYPE_COLORS,
  OPERATION_CATEGORY_MAP, OPERATION_LABELS,
  getOperationCategory,
  type OperationCategory,
} from '../../lib/constants'
import type { TokenUsageData, TokenUsageFilteredData } from '../../lib/api'
import { modelColors, categoryColors, chartVar, semantic } from '../../lib/tokens'

// ============================================================
// 用量统计：汇总卡片 + 趋势图 + 操作统计 + 明细表
// ============================================================

type TrendMetric = 'tokens' | 'cost'
type TrendDimension = 'model' | 'category'
type TimeRange = '7d' | '30d' | 'all'

// --- 颜色（引用 tokens 单一来源）---

const MODEL_COLORS = modelColors
const CATEGORY_COLORS = categoryColors

const CATEGORY_ORDER: OperationCategory[] = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution']

// --- 工具函数 ---

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  if (n > 0) return `$${n.toFixed(4)}`
  return '$0'
}

/** 将 model ID 归入显示类别 */
function getModelGroup(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'claude-haiku'
  if (m.includes('sonnet')) return 'claude-sonnet'
  if (m.includes('opus')) return 'claude-opus'
  if (m.includes('flash')) return 'gemini-flash'
  if (m.includes('gemini') && m.includes('pro')) return 'gemini-pro'
  return 'other'
}

const MODEL_GROUP_LABELS: Record<string, string> = {
  'claude-haiku': 'Haiku',
  'claude-sonnet': 'Sonnet',
  'claude-opus': 'Opus',
  'gemini-flash': 'Gemini Flash',
  'gemini-pro': 'Gemini Pro',
  other: 'other', // will be resolved via t() at render time
}

function getDateFilter(range: TimeRange): { after?: string; before?: string } {
  if (range === 'all') return {}
  const days = range === '7d' ? 7 : 30
  const d = new Date()
  d.setDate(d.getDate() - days)
  return { after: d.toISOString().slice(0, 10) }
}

// --- 主组件 ---

const DETAIL_PAGE_SIZE = 100

// 模块级稳定引用:useIPC 要求 fetcher 身份稳定(见 useIPC.ts 文档),
// inline 箭头函数会导致每次 render 重新触发 IPC 形成无限拉取循环。
const fetchTokenUsage = () => window.api.stats.tokenUsage()

export function ModelUsage() {
  const { t } = useTranslation('settings')
  const { data: tokenUsage } = useIPC<TokenUsageData>(fetchTokenUsage)
  const [opsRange, setOpsRange] = useState<TimeRange>('30d')
  const [detailRange, setDetailRange] = useState<TimeRange>('30d')
  const [detailPage, setDetailPage] = useState(0)

  const opsFilter = useMemo(() => getDateFilter(opsRange), [opsRange])
  const detailFilter = useMemo(() => ({
    ...getDateFilter(detailRange),
    limit: DETAIL_PAGE_SIZE,
    offset: detailPage * DETAIL_PAGE_SIZE,
  }), [detailRange, detailPage])

  const fetchOps = useCallback(
    () => window.api.stats.tokenUsageFiltered(opsFilter),
    [opsFilter],
  )
  const { data: opsData } = useIPC<TokenUsageFilteredData>(fetchOps)
  const fetchDetail = useCallback(
    () => window.api.stats.tokenUsageFiltered(detailFilter),
    [detailFilter],
  )
  const { data: detailData } = useIPC<TokenUsageFilteredData>(fetchDetail)

  const handleDetailRangeChange = useCallback((r: TimeRange) => {
    setDetailRange(r)
    setDetailPage(0)
  }, [])

  const totals = tokenUsage?.totals ?? { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, estimated_cost: 0, call_count: 0 }
  const totalTokens = totals.input_tokens + totals.output_tokens + totals.thinking_tokens

  return (
    <div className="space-y-6 max-w-2xl">
      {/* 1. 累计汇总 */}
      <SummaryCards totals={totals} totalTokens={totalTokens} countByOperation={tokenUsage?.countByOperation ?? []} />

      {/* 2. 用量趋势 */}
      <TrendChart tokenUsage={tokenUsage} />

      {/* 3. 操作统计 */}
      <OperationStats data={opsData} range={opsRange} onRangeChange={setOpsRange} />

      {/* 4. 明细表 */}
      <DetailTable
        data={detailData}
        range={detailRange}
        onRangeChange={handleDetailRangeChange}
        page={detailPage}
        onPageChange={setDetailPage}
        pageSize={DETAIL_PAGE_SIZE}
      />
    </div>
  )
}

// ============================================================
// 1. 汇总卡片
// ============================================================

function SummaryCards({ totals, totalTokens, countByOperation }: {
  totals: TokenUsageData['totals']
  totalTokens: number
  countByOperation: TokenUsageData['countByOperation']
}) {
  const { t } = useTranslation('settings')

  // 按5大类别聚合调用次数
  const countByCategory = useMemo(() => {
    const map: Record<string, number> = {}
    for (const cat of CATEGORY_ORDER) map[cat] = 0
    for (const row of countByOperation) {
      const cat = getOperationCategory(row.operation)
      map[cat] = (map[cat] ?? 0) + row.cnt
    }
    return map
  }, [countByOperation])

  return (
    <div className="grid grid-cols-3 gap-3">
      <SummaryCard
        label={t('usage.totalTokens')}
        value={formatTokenCount(totalTokens)}
        tooltip={
          <div className="space-y-1">
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.input')}</span><span>{formatTokenCount(totals.input_tokens)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.output')}</span><span>{formatTokenCount(totals.output_tokens)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.thinking')}</span><span>{formatTokenCount(totals.thinking_tokens)}</span></div>
          </div>
        }
      />
      <SummaryCard
        label={t('usage.totalCalls')}
        value={String(totals.call_count)}
        tooltip={
          <div className="space-y-1">
            {CATEGORY_ORDER.map(cat => (
              <div key={cat} className="flex justify-between gap-4">
                <span className="text-gray-400">{EVENT_TYPE_LABELS[cat]}</span>
                <span>{countByCategory[cat] ?? 0}</span>
              </div>
            ))}
          </div>
        }
      />
      <SummaryCard
        label={t('usage.totalEstimatedCost')}
        value={formatCost(totals.estimated_cost)}
        tooltip={
          <div className="space-y-1">
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.input')}</span><span className="text-[10px] text-gray-500">{t('usage.perToken')}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.output')}</span><span className="text-[10px] text-gray-500">{t('usage.perToken')}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">{t('usage.thinking')}</span><span className="text-[10px] text-gray-500">{t('usage.perToken')}</span></div>
            <div className="border-t border-white/10 pt-1 mt-1 flex justify-between gap-4">
              <span className="text-gray-300">{t('usage.subtotal')}</span>
              <span className="text-white font-medium">{formatCost(totals.estimated_cost)}</span>
            </div>
          </div>
        }
      />
    </div>
  )
}

function SummaryCard({ label, value, tooltip }: { label: string; value: string; tooltip: React.ReactNode }) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const iconRef = useRef<HTMLSpanElement>(null)

  const show = () => {
    if (!iconRef.current) return
    const rect = iconRef.current.getBoundingClientRect()
    setPos({ x: rect.right, y: rect.bottom })
    setVisible(true)
  }

  return (
    <div className="glass-card rounded-xl p-3 relative">
      <div className="flex items-start justify-between">
        <p className="text-[10px] text-gray-500 mb-1">{label}</p>
        <span
          ref={iconRef}
          className="text-gray-500 hover:text-gray-300 transition-colors cursor-help"
          onMouseEnter={show}
          onMouseLeave={() => setVisible(false)}
        >
          <Info size={12} />
        </span>
        {visible && createPortal(
          <div
            className="fixed z-[9999] min-w-[160px] px-3 py-2.5 rounded-lg text-[11px] text-gray-200 leading-relaxed pointer-events-none backdrop-blur-xl border"
            style={{
              right: window.innerWidth - pos.x,
              top: pos.y + 6,
              background: 'var(--theme-popup-bg)',
              borderColor: 'var(--theme-popup-border)',
              boxShadow: 'var(--theme-popup-shadow)',
            }}
          >
            {tooltip}
          </div>,
          document.body,
        )}
      </div>
      <p className="text-lg font-semibold font-mono tabular-nums text-gray-100">{value}</p>
    </div>
  )
}

// ============================================================
// 2. 趋势图
// ============================================================

function TrendChart({ tokenUsage }: { tokenUsage: TokenUsageData | null }) {
  const { t } = useTranslation('settings')
  const [metric, setMetric] = useState<TrendMetric>('tokens')
  const [dimension, setDimension] = useState<TrendDimension>('model')

  // 构建堆叠面积图数据
  const { chartData, keys, colors, labels } = useMemo(() => {
    // 动态解析 other 标签（放在 memo 内，依赖 t 以响应语言切换）
    const resolvedModelGroupLabels: Record<string, string> = {
      ...MODEL_GROUP_LABELS,
      other: t('usage.otherModel'),
    }

    if (!tokenUsage) return { chartData: [], keys: [], colors: {} as Record<string, string>, labels: {} as Record<string, string> }

    if (dimension === 'model') {
      // 按模型分组
      const source = tokenUsage.dailyByModel
      const allGroups = new Set<string>()
      const byDate: Record<string, Record<string, number>> = {}

      for (const row of source) {
        const group = getModelGroup(row.model)
        allGroups.add(group)
        if (!byDate[row.date]) byDate[row.date] = {}
        const val = metric === 'tokens'
          ? (row.input_tokens + row.output_tokens + row.thinking_tokens)
          : row.estimated_cost
        byDate[row.date][group] = (byDate[row.date][group] ?? 0) + val
      }

      const sortedKeys = Array.from(allGroups).sort((a, b) => {
        // 按总量排序，大的在上
        let sumA = 0, sumB = 0
        for (const d of Object.values(byDate)) { sumA += d[a] ?? 0; sumB += d[b] ?? 0 }
        return sumB - sumA
      })

      // 确保每个日期都包含所有模型 key（缺失补 0），否则单点数据不渲染
      const defaults = Object.fromEntries(sortedKeys.map(k => [k, 0]))
      const data = Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, vals]) => ({ date: date.slice(5), ...defaults, ...vals }))

      return {
        chartData: data,
        keys: sortedKeys,
        colors: MODEL_COLORS,
        labels: resolvedModelGroupLabels,
      }
    } else {
      // 按操作类别分组
      const source = tokenUsage.dailyByOperation
      const byDate: Record<string, Record<string, number>> = {}

      for (const row of source) {
        const cat = getOperationCategory(row.operation)
        if (!byDate[row.date]) byDate[row.date] = {}
        const val = metric === 'tokens'
          ? (row.input_tokens + row.output_tokens + row.thinking_tokens)
          : row.estimated_cost
        byDate[row.date][cat] = (byDate[row.date][cat] ?? 0) + val
      }

      // 确保每个日期都包含所有类别 key（缺失补 0）
      const totalByCat: Record<string, number> = {}
      for (const d of Object.values(byDate)) {
        for (const [k, v] of Object.entries(d)) totalByCat[k] = (totalByCat[k] ?? 0) + v
      }
      const sortedCatKeys = CATEGORY_ORDER.filter(c => (totalByCat[c] ?? 0) > 0)
        .sort((a, b) => (totalByCat[b] ?? 0) - (totalByCat[a] ?? 0))
      const catDefaults = Object.fromEntries(sortedCatKeys.map(k => [k, 0]))
      const data = Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, vals]) => ({ date: date.slice(5), ...catDefaults, ...vals }))

      return {
        chartData: data,
        keys: sortedCatKeys,
        colors: CATEGORY_COLORS,
        labels: EVENT_TYPE_LABELS,
      }
    }
  }, [tokenUsage, metric, dimension, t])

  const tooltipStyle = {
    backgroundColor: chartVar.tooltipBg,
    border: '1px solid var(--border-subtle)',
    borderRadius: '8px',
    fontSize: '11px',
    color: chartVar.tooltipText,
  }

  return (
    <Section title={t('usage.trendTitle')}>
      <div className="space-y-3">
        {/* 切换条 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ToggleGroup
              options={[{ value: 'model', label: t('usage.byModel') }, { value: 'category', label: t('usage.byCategory') }]}
              value={dimension}
              onChange={(v) => setDimension(v as TrendDimension)}
            />
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup
              options={[{ value: 'tokens', label: t('usage.token') }, { value: 'cost', label: t('usage.cost') }]}
              value={metric}
              onChange={(v) => setMetric(v as TrendMetric)}
            />
          </div>
        </div>

        {chartData.length > 0 ? (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  {keys.map(key => (
                    <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colors[key] ?? semantic.gray} stopOpacity={0.6} />
                      <stop offset="95%" stopColor={colors[key] ?? semantic.gray} stopOpacity={0.25} />
                    </linearGradient>
                  ))}
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: chartVar.tick }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9, fill: chartVar.tick }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={metric === 'tokens' ? formatTokenCount : (v: number) => formatCost(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number) => metric === 'tokens' ? formatTokenCount(v) : formatCost(v)}
                  labelFormatter={(label) => `${t('usage.tooltipDate')}: ${label}`}
                />
                <Legend
                  wrapperStyle={{ fontSize: '10px', color: chartVar.tick }}
                  iconSize={8}
                  formatter={(value) => labels[value] ?? value}
                />
                {keys.map(key => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stackId="1"
                    stroke={colors[key] ?? semantic.gray}
                    fill={`url(#grad-${key})`}
                    strokeWidth={1.5}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-xs text-gray-500 py-8 text-center">{t('usage.noData')}</p>
        )}
      </div>
    </Section>
  )
}

// ============================================================
// 3. 操作统计
// ============================================================

function OperationStats({ data, range, onRangeChange }: {
  data: TokenUsageFilteredData | null
  range: TimeRange
  onRangeChange: (r: TimeRange) => void
}) {
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 按5大类别分组
  const grouped = useMemo(() => {
    if (!data) return []
    const map: Record<string, { cnt: number; cost: number; operations: Array<{ operation: string; cnt: number; cost: number }> }> = {}
    for (const cat of CATEGORY_ORDER) {
      map[cat] = { cnt: 0, cost: 0, operations: [] }
    }

    for (const row of data.operationStats) {
      const cat = getOperationCategory(row.operation)
      if (!map[cat]) map[cat] = { cnt: 0, cost: 0, operations: [] }
      map[cat].cnt += row.cnt
      map[cat].cost += row.estimated_cost
      map[cat].operations.push({
        operation: row.operation,
        cnt: row.cnt,
        cost: row.estimated_cost,
      })
    }

    return CATEGORY_ORDER
      .filter(cat => map[cat].cnt > 0)
      .map(cat => ({
        category: cat,
        label: EVENT_TYPE_LABELS[cat],
        ...map[cat],
      }))
  }, [data])

  const toggle = (cat: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }

  return (
    <Section title={t('usage.operationStats')}>
      <div className="space-y-3">
        <RangeSelector value={range} onChange={onRangeChange} />

        {grouped.length > 0 ? (
          <div className="space-y-1">
            {/* 表头 */}
            <div className="flex items-center gap-4 px-2 py-1.5 text-[11px] text-gray-500 font-medium border-b border-white/5">
              <span className="flex-1">{t('usage.opsCategory')}</span>
              <span className="w-16 text-right">{t('usage.opsCount')}</span>
              <span className="w-20 text-right">{t('usage.opsEstimatedCost')}</span>
            </div>

            {grouped.map(group => {
              const isExpanded = expanded.has(group.category)
              return (
                <div key={group.category}>
                  {/* 类别行 */}
                  <button
                    onClick={() => toggle(group.category)}
                    className="flex items-center gap-4 px-2 py-2 w-full hover:bg-white/[0.03] rounded transition-colors"
                  >
                    <span className="flex items-center gap-1.5 flex-1 text-left">
                      {isExpanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
                      <span className="text-xs font-medium text-gray-300">
                        {group.label}
                      </span>
                    </span>
                    <span className="w-16 text-xs text-gray-300 text-right tabular-nums font-mono">{group.cnt}</span>
                    <span className="w-20 text-xs text-gray-300 text-right tabular-nums font-mono">{formatCost(group.cost)}</span>
                  </button>

                  {/* 展开的子操作 */}
                  {isExpanded && group.operations.length > 0 && (
                    <div className="ml-6 border-l border-white/5 pl-3 mb-1">
                      {group.operations.map(op => (
                        <div key={op.operation} className="flex items-center gap-4 px-2 py-1.5">
                          <span className="flex-1 text-[11px] text-gray-400">
                            {OPERATION_LABELS[op.operation] ?? op.operation}
                          </span>
                          <span className="w-16 text-[11px] text-gray-400 text-right tabular-nums font-mono">{op.cnt}</span>
                          <span className="w-20 text-[11px] text-gray-400 text-right tabular-nums font-mono">{formatCost(op.cost)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500 py-4 text-center">{t('usage.noOpsData')}</p>
        )}
      </div>
    </Section>
  )
}

// ============================================================
// 4. 明细表
// ============================================================

function DetailTable({ data, range, onRangeChange, page, onPageChange, pageSize }: {
  data: TokenUsageFilteredData | null
  range: TimeRange
  onRangeChange: (r: TimeRange) => void
  page: number
  onPageChange: (p: number) => void
  pageSize: number
}) {
  const { t } = useTranslation('settings')
  const { formatShortDate } = useFormatters()
  const totalLogs = data?.totalLogs ?? 0
  const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize))

  // 动态解析 other 标签
  const resolvedModelGroupLabels: Record<string, string> = {
    ...MODEL_GROUP_LABELS,
    other: t('usage.otherModel'),
  }

  if (!data || totalLogs === 0) return null

  return (
    <Section title={t('usage.detailTitle')}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <RangeSelector value={range} onChange={onRangeChange} />
          <span className="text-[11px] text-gray-500">{t('usage.totalRecords', { count: totalLogs })}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 border-b border-white/5">
                <th className="text-left py-1.5 px-2 font-medium">{t('usage.colTime')}</th>
                <th className="text-left py-1.5 px-2 font-medium">{t('usage.colOperation')}</th>
                <th className="text-left py-1.5 px-2 font-medium">{t('usage.colModel')}</th>
                <th className="text-right py-1.5 px-2 font-medium">{t('usage.colTotalTokens')}</th>
                <th className="text-right py-1.5 px-2 font-medium">{t('usage.colEstimatedCost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.recentLogs.map((log) => {
                const cat = getOperationCategory(log.operation)
                const totalTk = log.input_tokens + log.output_tokens + log.thinking_tokens
                return (
                  <tr key={log.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-1.5 px-2 text-gray-400 font-mono whitespace-nowrap">
                      {formatShortDate(log.created)}
                    </td>
                    <td className="py-1.5 px-2">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[10px] text-gray-400">
                          {EVENT_TYPE_LABELS[cat]}
                        </span>
                        <span className="text-gray-500">·</span>
                        <span className="text-gray-300 text-[11px]">
                          {OPERATION_LABELS[log.operation] ?? log.operation ?? '-'}
                        </span>
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-gray-300 truncate max-w-[120px]">
                      {resolvedModelGroupLabels[getModelGroup(log.model)] ?? log.model}
                    </td>
                    <td className="py-1.5 px-2 text-right text-gray-300 font-mono tabular-nums">
                      {formatTokenCount(totalTk)}
                    </td>
                    <td className="py-1.5 px-2 text-right text-gray-300 font-mono tabular-nums">
                      {formatCost(log.estimated_cost)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 翻页 */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              disabled={page === 0}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} className="text-gray-400" />
            </button>
            <span className="text-[11px] text-gray-400 tabular-nums font-mono">
              {page + 1} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} className="text-gray-400" />
            </button>
          </div>
        )}
      </div>
    </Section>
  )
}

// ============================================================
// 共用组件
// ============================================================

function RangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const { t } = useTranslation('settings')
  const options: { value: TimeRange; label: string }[] = [
    { value: '7d', label: t('usage.range7d') },
    { value: '30d', label: t('usage.range30d') },
    { value: 'all', label: t('usage.rangeAll') },
  ]

  return (
    <ToggleGroup
      options={options}
      value={value}
      onChange={(v) => onChange(v as TimeRange)}
    />
  )
}

function ToggleGroup<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 ${
            value === opt.value ? 'text-white' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
          }`}
          style={value === opt.value ? { background: 'var(--selected-bg)' } : {}}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
