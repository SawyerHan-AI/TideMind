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
  }))
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get('node') || null,
  )
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list')
  const [page, setPage] = useState(0)

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

  const { data: listData, loading } = useIPC(
    () => useSearchMode
      ? window.api.nodes.search(debouncedSearch, 30)
      : window.api.nodes.list({
          ...filter,
          search: undefined,
          offset: page * 30,
        }),
    [debouncedSearch, filter.type, filter.tags, filter.sortBy, filter.heatMin, filter.heatMax, page, rev],
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
                filter={filter}
                selectedId={selectedId}
                onSelect={setSelectedId}
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
