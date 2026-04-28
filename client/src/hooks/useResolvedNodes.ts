import { useState, useEffect, useRef } from 'react'

export type NodeInfo = { title: string | null; type: string }
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
  const loadedKey = useRef('')
  const latestKeyRef = useRef('')

  useEffect(() => {
    if (!enabled || nodeIds.length === 0) return

    const key = nodeIds.slice().sort().join(',')
    if (key === loadedKey.current) return

    prevKey.current = key
    loadedKey.current = key
    latestKeyRef.current = key
    setLoading(true)

    window.api.timeline
      .resolveNodes(nodeIds)
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
  }, [enabled, nodeIds])

  return { nodeMap, loading }
}
