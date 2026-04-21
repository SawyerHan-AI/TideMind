import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as d3 from 'd3'
import { useIPC } from '../../hooks/useIPC'
import { useDataRevision } from '../../contexts/DataChangeContext'
import { GraphToolbar } from './GraphToolbar'
import { DERIVED_CATEGORY_COLORS, RELATION_COLORS, RELATION_LINE_STYLES } from '../../lib/constants'
import { deriveCategory } from '../../lib/dimensions'
import { brand, semantic } from '../../lib/tokens'
import type { ExplorerFilter, GraphNodeData, GraphLinkData, StructureHole } from '../../lib/api'

/* ---------- types ---------- */

interface GraphViewProps {
  filter: ExplorerFilter
  selectedId: string | null
  onSelect: (id: string | null) => void
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string
  type: string
  content: string
  heat: number
  refinement: number
  connectivity: number
  independence: number
  specificity: number
  subjectivity: number
  actuality: number
  project: string | null
  is_keystone: number
  is_crystal: number
  is_tag: number
  is_meta: number
  // d3 adds x, y, vx, vy, fx, fy
}

interface LinkRelation {
  type: string
  confidence: number
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string
  from_id: string
  to_id: string
  relation: LinkRelation[]
  strength: number
  status: string
}

/* ---------- helpers ---------- */

function nodeRadius(node: SimNode): number {
  return 4 + Math.min(node.connectivity * 2, 12)
}

function primaryRelationType(relation: LinkRelation[]): string {
  if (!Array.isArray(relation) || relation.length === 0) return 'analogous'
  return relation.reduce((best, r) => r.confidence > best.confidence ? r : best, relation[0]).type
}

function lineDashForRelation(relation: LinkRelation[]): number[] {
  const relType = primaryRelationType(relation)
  const style = RELATION_LINE_STYLES[relType] ?? 'dashed'
  if (style === 'dashed') return [5, 5]
  if (style === 'dotted') return [2, 2]
  return [] // solid
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len) + '...'
}

/** Draw a 5-pointed star at (cx, cy) */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath()
  for (let i = 0; i < 5; i++) {
    const angle = (i * 4 * Math.PI) / 5 - Math.PI / 2
    const method = i === 0 ? 'moveTo' : 'lineTo'
    ctx[method](cx + r * Math.cos(angle), cy + r * Math.sin(angle))
  }
  ctx.closePath()
}

/* ---------- component ---------- */

export function GraphView({ filter, selectedId, onSelect }: GraphViewProps) {
  const { t } = useTranslation('explorer')
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const sizeRef = useRef({ width: 0, height: 0 })
  const rafRef = useRef<number>(0)
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const draggedNodeRef = useRef<SimNode | null>(null)

  // toolbar state
  const [neighborhoodDepth, setNeighborhoodDepth] = useState(0)
  const [pathMode, setPathMode] = useState(false)
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [showStructureHoles, setShowStructureHoles] = useState(false)
  const [connectivityThreshold, setConnectivityThreshold] = useState(0)
  const [highlightedPath, setHighlightedPath] = useState<Set<string>>(new Set())
  const [structureHoles, setStructureHoles] = useState<StructureHole[]>([])

  // track mounted state to guard async setState calls
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // data fetching
  const rev = useDataRevision(['nodes', 'links'])
  const { data: graphData } = useIPC(
    () => window.api.nodes.graph(filter),
    [filter.type, filter.tags, filter.heatMin, filter.heatMax, filter.search, rev],
  )

  // fetch structure holes when toggled
  useEffect(() => {
    if (showStructureHoles) {
      let cancelled = false
      window.api.nodes.structureHoles(10)
        .then(result => { if (!cancelled) setStructureHoles(result) })
        .catch(() => { if (!cancelled) setStructureHoles([]) })
      return () => { cancelled = true }
    } else {
      setStructureHoles([])
    }
  }, [showStructureHoles])

  // adjacency map for neighbor lookups
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!graphData) return map
    for (const l of graphData.links) {
      if (!map.has(l.from_id)) map.set(l.from_id, new Set())
      if (!map.has(l.to_id)) map.set(l.to_id, new Set())
      map.get(l.from_id)!.add(l.to_id)
      map.get(l.to_id)!.add(l.from_id)
    }
    return map
  }, [graphData])

  // compute N-hop neighborhood of selected node
  const neighborhoodSet = useMemo(() => {
    if (!selectedId || neighborhoodDepth === 0) return null
    const visited = new Set<string>()
    let frontier = [selectedId]
    for (let d = 0; d <= neighborhoodDepth; d++) {
      const next: string[] = []
      for (const nid of frontier) {
        if (visited.has(nid)) continue
        visited.add(nid)
        const neighbors = adjacency.get(nid)
        if (neighbors) {
          for (const nb of neighbors) {
            if (!visited.has(nb)) next.push(nb)
          }
        }
      }
      frontier = next
    }
    return visited
  }, [selectedId, neighborhoodDepth, adjacency])

  // 1-hop neighbors of selected
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return new Set<string>()
    return adjacency.get(selectedId) ?? new Set<string>()
  }, [selectedId, adjacency])

  const maxConnectivity = useMemo(() => {
    if (!graphData) return 0
    return Math.max(0, ...graphData.nodes.map(n => n.connectivity))
  }, [graphData])

  // O(1) lookup map for nodes — rebuilt when simulation nodes change
  const nodesByIdRef = useRef<Map<string, SimNode>>(new Map())
  // Keep the map in sync: updated inside the data-sync effect below

  /* ---- Render function ---- */
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    const transform = transformRef.current

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.k, transform.k)

    const nodes = nodesRef.current
    const links = linksRef.current
    const pathSet = highlightedPath
    const holeNodeIds = new Set<string>()
    for (const h of structureHoles) {
      holeNodeIds.add(h.nodeA)
      holeNodeIds.add(h.nodeB)
    }

    // Determine visibility — O(1) via Map
    const nodesById = nodesByIdRef.current
    const isVisible = (id: string): boolean => {
      if (connectivityThreshold > 0) {
        const n = nodesById.get(id)
        if (n && n.connectivity < connectivityThreshold) return false
      }
      if (neighborhoodSet && !neighborhoodSet.has(id)) return false
      return true
    }

    // Draw structure hole dashed lines
    if (structureHoles.length > 0) {
      ctx.strokeStyle = `${semantic.amber}66`
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      for (const hole of structureHoles) {
        const a = nodes.find(n => n.id === hole.nodeA)
        const b = nodes.find(n => n.id === hole.nodeB)
        if (a && b && a.x != null && a.y != null && b.x != null && b.y != null) {
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
      ctx.setLineDash([])
    }

    // Draw links
    for (const link of links) {
      const source = link.source as SimNode
      const target = link.target as SimNode
      if (source.x == null || source.y == null || target.x == null || target.y == null) continue
      if (!isVisible(source.id) || !isVisible(target.id)) continue

      const inPath = pathSet.size > 0 && pathSet.has(source.id) && pathSet.has(target.id)
      const baseThickness = 1 + link.strength * 3
      const thickness = inPath ? baseThickness * 2 : baseThickness
      const relType = primaryRelationType(link.relation)
      const baseColor = RELATION_COLORS[relType] ?? RELATION_COLORS.analogous
      const alpha = inPath ? 0.8 : 0.4

      ctx.beginPath()
      ctx.setLineDash(lineDashForRelation(link.relation))
      ctx.strokeStyle = hexWithAlpha(baseColor, alpha)
      ctx.lineWidth = thickness
      ctx.moveTo(source.x, source.y)
      ctx.lineTo(target.x, target.y)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // Draw nodes
    const showLabelsZoom = transform.k > 1.2
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      if (!isVisible(node.id)) continue

      const r = nodeRadius(node)
      const isSelected = node.id === selectedId
      const isNeighbor = selectedNeighbors.has(node.id)
      const isHoleNode = holeNodeIds.has(node.id)

      // opacity: if something is selected, dim nodes outside the active neighborhood
      let alpha = 0.3 + node.heat * 0.7
      if (selectedId) {
        const inNeighborhood = neighborhoodSet
          ? neighborhoodSet.has(node.id)  // N-hop mode: use full depth set
          : isNeighbor                     // default: 1-hop neighbors
        if (!isSelected && !inNeighborhood) alpha *= 0.3
      }

      // node circle
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
      const cat = deriveCategory(node.specificity ?? 0.5, node.subjectivity ?? 0.5, node.actuality ?? 0.5)
      ctx.fillStyle = hexWithAlpha(DERIVED_CATEGORY_COLORS[cat] ?? semantic.gray, alpha)
      ctx.fill()

      // selected ring
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2)
        ctx.strokeStyle = brand.primary
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // path-from indicator (green ring for first node in path mode)
      if (pathFrom && node.id === pathFrom) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2)
        ctx.strokeStyle = semantic.green
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      // highlighted path node indicator
      if (pathSet.size > 0 && pathSet.has(node.id)) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2)
        ctx.strokeStyle = brand.primary
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // keystone star
      if (node.is_keystone) {
        ctx.fillStyle = hexWithAlpha('#fbbf24', alpha)
        drawStar(ctx, node.x + r + 4, node.y - r - 2, 4)
        ctx.fill()
      }

      // structure hole highlight ring
      if (isHoleNode) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2)
        ctx.strokeStyle = `${semantic.amber}99`
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // labels: show for selected, neighbors, or when zoomed in
      if (isSelected || isNeighbor || showLabelsZoom) {
        ctx.fillStyle = `rgba(255, 255, 255, ${isSelected || isNeighbor ? 0.9 : 0.5})`
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(truncate(node.content, 10), node.x, node.y + r + 3)
      }
    }

    ctx.restore()
  }, [selectedId, selectedNeighbors, highlightedPath, neighborhoodSet, connectivityThreshold, structureHoles, pathFrom])

  /*
   * KEY FIX: use a ref so simulation ticks / zoom / resize always call
   * the LATEST render, not the one captured when the callback was created.
   */
  const renderRef = useRef(render)
  renderRef.current = render

  /** Stable scheduleRender — never changes identity, always calls latest render via ref */
  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => renderRef.current())
  }, []) // empty deps: stable reference forever

  // Cancel any pending RAF on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Re-render when visual state changes
  useEffect(() => {
    scheduleRender()
  }, [render]) // render changes when any visual dep changes; scheduleRender is stable

  /* ---- Convert raw data into SimNode/SimLink, preserving positions ---- */
  useEffect(() => {
    if (!graphData) return

    const oldPositions = new Map<string, { x: number; y: number }>()
    for (const n of nodesRef.current) {
      if (n.x != null && n.y != null) oldPositions.set(n.id, { x: n.x, y: n.y })
    }

    const nodes: SimNode[] = graphData.nodes.map(n => {
      const old = oldPositions.get(n.id)
      return {
        ...n,
        x: old?.x ?? sizeRef.current.width / 2 + (Math.random() - 0.5) * 200,
        y: old?.y ?? sizeRef.current.height / 2 + (Math.random() - 0.5) * 200,
      }
    })

    const nodeIds = new Set(nodes.map(n => n.id))
    const links: SimLink[] = graphData.links
      .filter(l => nodeIds.has(l.from_id) && nodeIds.has(l.to_id))
      .map(l => ({
        ...l,
        source: l.from_id as any,
        target: l.to_id as any,
      }))

    nodesRef.current = nodes
    linksRef.current = links
    nodesByIdRef.current = new Map(nodes.map(n => [n.id, n]))

    const { width, height } = sizeRef.current

    if (simulationRef.current) simulationRef.current.stop()

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius(d => nodeRadius(d) + 2))
      .alphaDecay(0.02)
      .on('tick', () => scheduleRender()) // scheduleRender is stable, always calls latest render

    simulationRef.current = sim

    return () => {
      sim.stop()
    }
  }, [graphData, scheduleRender])

  /* ---- Canvas sizing ---- */
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width: rect.width, height: rect.height }
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      // update center force
      if (simulationRef.current) {
        const center = simulationRef.current.force('center') as d3.ForceCenter<SimNode> | undefined
        if (center) {
          center.x(rect.width / 2).y(rect.height / 2)
        }
      }
      scheduleRender()
    }

    const observer = new ResizeObserver(resizeCanvas)
    observer.observe(container)
    resizeCanvas()

    return () => observer.disconnect()
  }, [scheduleRender])

  /* ---- Zoom/pan behavior ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        transformRef.current = event.transform
        scheduleRender() // stable ref, always calls latest render
      })

    zoomBehaviorRef.current = zoom
    const sel = d3.select(canvas)
    sel.call(zoom)

    // Disable default double-click zoom (we handle it ourselves)
    sel.on('dblclick.zoom', null)

    return () => {
      sel.on('.zoom', null)
    }
  }, [scheduleRender])

  /* ---- Hit test ---- */
  const hitTest = useCallback((px: number, py: number): SimNode | null => {
    const t = transformRef.current
    const x = (px - t.x) / t.k
    const y = (py - t.y) / t.k

    // Check in reverse order so top-drawn nodes are checked first
    const nodes = nodesRef.current
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]
      if (node.x == null || node.y == null) continue
      const r = nodeRadius(node) + 2
      const dx = node.x - x
      const dy = node.y - y
      if (dx * dx + dy * dy <= r * r) return node
    }
    return null
  }, [])

  /* ---- Click (via pointerup to avoid D3 drag suppression) ---- */
  const pointerDownRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownRef.current = { x: e.clientX, y: e.clientY, time: Date.now() }
    }

    const handlePointerUp = (e: PointerEvent) => {
      const down = pointerDownRef.current
      pointerDownRef.current = null
      if (!down) return

      // Only treat as click if pointer moved < 5px and held < 500ms
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (dx * dx + dy * dy > 25 || Date.now() - down.time > 500) return

      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const node = hitTest(px, py)

      if (node) {
        if (pathMode) {
          if (!pathFrom) {
            setPathFrom(node.id)
          } else {
            // find path
            window.api.nodes.path(pathFrom, node.id)
              .then(result => { if (mountedRef.current) setHighlightedPath(new Set(result.path)) })
              .catch(() => { if (mountedRef.current) setHighlightedPath(new Set()) })
            setPathFrom(null)
            // Keep pathMode on so user can see the result and toggle off manually
          }
        } else {
          onSelect(node.id)
          setHighlightedPath(new Set()) // clear any previous path
        }
      } else {
        // Click on empty space: deselect & clear path
        if (!pathMode) {
          onSelect(null)
          setHighlightedPath(new Set())
        }
      }
    }

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointerup', handlePointerUp)
    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointerup', handlePointerUp)
    }
  }, [hitTest, onSelect, pathMode, pathFrom])

  /* ---- Drag ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sel = d3.select(canvas)

    const drag = d3.drag<HTMLCanvasElement, unknown>()
      .subject((event) => {
        const rect = canvas.getBoundingClientRect()
        const px = event.sourceEvent.clientX - rect.left
        const py = event.sourceEvent.clientY - rect.top
        const node = hitTest(px, py)
        if (node) {
          // Return the node as subject with screen coords for d3
          const t = transformRef.current
          return { x: node.x! * t.k + t.x, y: node.y! * t.k + t.y, node }
        }
        return null
      })
      .on('start', (event) => {
        const node = (event.subject as any).node as SimNode
        // Don't restart simulation here — wait for actual drag movement
        node.fx = node.x
        node.fy = node.y
        draggedNodeRef.current = node
      })
      .on('drag', (event) => {
        const node = draggedNodeRef.current
        if (!node) return
        // Restart simulation only on actual drag movement
        if (!event.active) simulationRef.current?.alphaTarget(0.3).restart()
        const t = transformRef.current
        node.fx = (event.x - t.x) / t.k
        node.fy = (event.y - t.y) / t.k
      })
      .on('end', (event) => {
        const node = draggedNodeRef.current
        if (!event.active) simulationRef.current?.alphaTarget(0)
        if (node) {
          node.fx = null
          node.fy = null
        }
        draggedNodeRef.current = null
      })

    sel.call(drag as any)

    return () => {
      sel.on('.drag', null)
    }
  }, [hitTest])

  /* ---- Double-click: center on node ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleDblClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const node = hitTest(px, py)
      if (node && node.x != null && node.y != null) {
        const { width, height } = sizeRef.current
        const targetK = 2
        const tx = width / 2 - node.x * targetK
        const ty = height / 2 - node.y * targetK
        const newTransform = d3.zoomIdentity.translate(tx, ty).scale(targetK)

        const sel = d3.select(canvas)
        if (zoomBehaviorRef.current) {
          sel.transition().duration(500).call(zoomBehaviorRef.current.transform, newTransform)
        }
        onSelect(node.id)
      }
    }

    canvas.addEventListener('dblclick', handleDblClick)
    return () => canvas.removeEventListener('dblclick', handleDblClick)
  }, [hitTest, onSelect])

  /* ---- Toolbar handlers ---- */
  const handleZoomIn = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !zoomBehaviorRef.current) return
    d3.select(canvas).transition().duration(300).call(zoomBehaviorRef.current.scaleBy, 1.5)
  }, [])

  const handleZoomOut = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !zoomBehaviorRef.current) return
    d3.select(canvas).transition().duration(300).call(zoomBehaviorRef.current.scaleBy, 1 / 1.5)
  }, [])

  const handleFitAll = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !zoomBehaviorRef.current) return
    const nodes = nodesRef.current
    if (nodes.length === 0) return

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue
      const r = nodeRadius(n)
      minX = Math.min(minX, n.x - r)
      minY = Math.min(minY, n.y - r)
      maxX = Math.max(maxX, n.x + r)
      maxY = Math.max(maxY, n.y + r)
    }

    if (!isFinite(minX)) return

    const { width, height } = sizeRef.current
    const padding = 40
    const gw = maxX - minX || 1
    const gh = maxY - minY || 1
    const scale = Math.min((width - padding * 2) / gw, (height - padding * 2) / gh, 4)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = width / 2 - cx * scale
    const ty = height / 2 - cy * scale

    const newTransform = d3.zoomIdentity.translate(tx, ty).scale(scale)
    d3.select(canvas).transition().duration(500).call(zoomBehaviorRef.current.transform, newTransform)
  }, [])

  const handlePathModeToggle = useCallback(() => {
    setPathMode(m => {
      if (m) {
        // turning off
        setPathFrom(null)
        setHighlightedPath(new Set())
      }
      return !m
    })
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor: pathMode ? 'crosshair' : 'default' }}
      />
      <GraphToolbar
        neighborhoodDepth={neighborhoodDepth}
        onNeighborhoodDepthChange={setNeighborhoodDepth}
        pathMode={pathMode}
        pathFrom={pathFrom}
        onPathModeToggle={handlePathModeToggle}
        showStructureHoles={showStructureHoles}
        onStructureHolesToggle={() => setShowStructureHoles(v => !v)}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFitAll={handleFitAll}
        connectivityThreshold={connectivityThreshold}
        onConnectivityThresholdChange={setConnectivityThreshold}
        maxConnectivity={maxConnectivity}
      />
      {/* Loading indicator */}
      {!graphData && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-gray-500 text-sm">{t('explorer:graph.loading')}</div>
        </div>
      )}
      {graphData && graphData.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-gray-500 text-sm">{t('explorer:graph.noData')}</div>
        </div>
      )}
    </div>
  )
}

/* ---- utility ---- */
function hexWithAlpha(hex: string, alpha: number): string {
  // Expects a 6-digit #RRGGBB string (all callers in this file use that format)
  if (hex.length !== 7 || !hex.startsWith('#')) {
    // Fallback: return a transparent black rather than NaN-based rgba
    return `rgba(0, 0, 0, ${alpha})`
  }
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
