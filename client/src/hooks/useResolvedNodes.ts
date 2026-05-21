import { useState, useEffect, useRef } from 'react'
import { useDataRevision } from '../contexts/DataChangeContext'

export type NodeInfo = { title: string | null; type: string }
export type NodeMap = Record<string, NodeInfo>

/**
 * Resolve node IDs to human-readable titles.
 * Only fetches when `enabled` is true (i.e. the detail panel is expanded).
 * Results are cached across re-renders for the same ID set.
 *
 * F8: 订阅 `nodes` scope 的 revision — 后端 node title / type 变更
 * (rename / tag refactor / metabolism)时,自动重拉。
 */
export function useResolvedNodes(
  nodeIds: string[],
  enabled: boolean,
): { nodeMap: NodeMap | null; loading: boolean } {
  const [nodeMap, setNodeMap] = useState<NodeMap | null>(null)
  const [loading, setLoading] = useState(false)
  const prevKey = useRef('')
  const loadedKey = useRef('')
  const latestKeyRef = useRef('')

  // 用 string dep key 避免数组引用比较:caller 不必 useMemo 自己稳定 nodeIds,
  // hook 内部按内容比较。原版 deps [enabled, nodeIds] 按引用比对,父组件每次
  // render 重建数组就重跑 effect,即使 ID 集合不变也会切到 loading 状态。
  const nodeIdsKey = nodeIds.slice().sort().join(',')
  const rev = useDataRevision(['nodes'])
  // 在 key 末端拼上 revision,让 nodes scope 变化后 key 自然失效,触发重拉。
  const cacheKey = `${nodeIdsKey}:${rev}`

  useEffect(() => {
    if (!enabled || nodeIdsKey.length === 0) return

    const key = cacheKey
    if (key === loadedKey.current) return

    prevKey.current = key
    loadedKey.current = key
    latestKeyRef.current = key
    setLoading(true)

    window.api.timeline
      .resolveNodes(nodeIdsKey.split(','))
      .then((result) => {
        if (key !== latestKeyRef.current) return // stale — a newer call has superseded us
        setNodeMap(result)
      })
      .catch(() => {
        if (key !== latestKeyRef.current) return
        setNodeMap(null)
      })
      .finally(() => {
        if (key !== latestKeyRef.current) return
        setLoading(false)
      })
  }, [enabled, cacheKey, nodeIdsKey])

  return { nodeMap, loading }
}
