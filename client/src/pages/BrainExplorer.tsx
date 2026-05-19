import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useIPC } from '../hooks/useIPC'
import { useDataRevision } from '../contexts/DataChangeContext'
import { useDebounce } from '../hooks/useDebounce'
import { FilterBar } from '../components/explorer/FilterBar'
import { ListView } from '../components/explorer/ListView'
import { GraphView } from '../components/explorer/GraphView'
import { DetailPanel } from '../components/explorer/DetailPanel'
import type { ExplorerFilter } from '../lib/api'

export function BrainExplorer() {
  const { t } = useTranslation('explorer')
  const [searchParams] = useSearchParams()

  const [filter, setFilter] = useState<ExplorerFilter>(() => ({
    sortBy: 'created',
    sortDir: 'DESC',
    limit: 30,
    offset: 0,
    tags: searchParams.get('tag') || undefined,
    // 与 FilterBar 滑块默认显示值保持一致，避免首次加载时后端不加热度过滤
    heatMin: 0.05,
  }))
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get('node') || null,
  )
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list')
  const [page, setPage] = useState(0)
  // perf-optimization-2026-05-17 P2-2:GraphView 节点上限。默认 500,用户可
  // 在 GraphToolbar 调到 200/500/1000/2000。d3 force 是 O(n²),万节点级别
  // 直接锁死 renderer——加显式上限避免误开导致卡死。
  const [graphLimit, setGraphLimit] = useState(500)

  // Sync URL params
  useEffect(() => {
    const nodeParam = searchParams.get('node')
    if (nodeParam) setSelectedId(nodeParam)
    const tagParam = searchParams.get('tag')
    if (tagParam) setFilter(f => ({ ...f, tags: tagParam }))
  }, [searchParams])

  const rev = useDataRevision(['nodes', 'links'])
  const debouncedSearch = useDebounce(filter.search ?? '', 300)
  const useSearchMode = debouncedSearch.length > 0

  // Reset to first page whenever the search query changes
  useEffect(() => { setPage(0) }, [debouncedSearch])

  // window.api.nodes.list 把整个 filter 传后端，下面所有字段都参与查询。
  // deps 漏一个就意味着改这个过滤项不会触发重取，列表与实际过滤错位。
  // GraphView 已经做过同样补全 (filter.archived/sortDir/createdAfter/createdBefore/graphLimit)。
  const { data: listData, loading } = useIPC(
    () => useSearchMode
      ? window.api.nodes.search(debouncedSearch, 30)
      : window.api.nodes.list({
          ...filter,
          search: undefined,
          offset: page * 30,
        }),
    [
      debouncedSearch, useSearchMode,
      filter.type, filter.tags, filter.sortBy, filter.sortDir,
      filter.heatMin, filter.heatMax, filter.archived,
      filter.createdAfter, filter.createdBefore, filter.limit,
      page, rev,
    ],
  )

  const handleFilterChange = (patch: Partial<ExplorerFilter>) => {
    setFilter(f => ({ ...f, ...patch }))
    setPage(0)
  }

  return (
    <div className="flex h-full gap-0">
      {/* Left panel */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-white/5">
        {/* Filter bar (includes view switcher) */}
        <div className="px-4 pt-9 pb-3 border-b border-white/5">
          <FilterBar
            filter={filter}
            onFilterChange={handleFilterChange}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </div>

        {/* View content */}
        <div className="flex-1 overflow-auto">
          {viewMode === 'list' ? (
            <ListView
              nodes={listData?.nodes ?? []}
              total={listData?.total ?? 0}
              page={page}
              onPageChange={setPage}
              selectedId={selectedId}
              onSelect={setSelectedId}
              loading={loading}
            />
          ) : (
            <div className="relative h-full">
              <GraphView
                filter={{ ...filter, search: debouncedSearch || undefined, graphLimit }}
                selectedId={selectedId}
                onSelect={setSelectedId}
                graphLimit={graphLimit}
                onGraphLimitChange={setGraphLimit}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right panel -- Detail */}
      <div className="w-[420px] flex-shrink-0 overflow-auto pt-8">
        <DetailPanel nodeId={selectedId} onNavigate={setSelectedId} />
      </div>
    </div>
  )
}
