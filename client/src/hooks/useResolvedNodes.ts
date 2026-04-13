import { useState, useEffect, useRef } from 'react'

export type NodeInfo = { title: string; type: string }
export type NodeMap = Record<string, NodeInfo>

/**
 * Resolve node IDs to human-readable titles.
 * Only fetches when `enabled` is true (i.e. the detail panel is expanded).
 * Results are cached across re-renders for the same ID set.
 */
export function useResolvedNodes(
  nodeIds: string[],
  enabled: boolean,
): { nodeMap: NodeMap | null; loading: boolean } {
  const [nodeMap, setNodeMap] = useState<NodeMap | null>(null)
  const [loading, setLoading] = useState(false)
  const prevKey = useRef('')

  useEffect(() => {
    if (!enabled || nodeIds.length === 0) return

    const key = nodeIds.slice().sort().join(',')
    if (key === prevKey.current && nodeMap) return

    prevKey.current = key
    setLoading(true)

    window.api.timeline
      .resolveNodes(nodeIds)
      .then((result: NodeMap) => setNodeMap(result))
      .catch(() => setNodeMap(null))
      .finally(() => setLoading(false))
  }, [enabled, nodeIds])

  return { nodeMap, loading }
}
