import { brand, chartVar } from '../lib/tokens'

/**
 * 四维成熟度雷达图（自定义 SVG，不依赖图表库）
 */
export function MaturityRadar({ heat, refinement, connectivity, independence, size = 80 }: {
  heat: number
  refinement: number
  connectivity: number
  independence: number
  size?: number
}) {
  const center = size / 2
  const maxR = size / 2 - 8

  // 四个轴：上(heat)、右(refinement)、下(connectivity)、左(independence)
  const values = [
    Math.min(heat / 3, 1),   // 归一化 heat
    refinement,
    connectivity,
    independence,
  ]

  const angles = [
    -Math.PI / 2,       // 上
    0,                   // 右
    Math.PI / 2,         // 下
    Math.PI,             // 左
  ]

  const points = values.map((v, i) => ({
    x: center + Math.cos(angles[i]) * v * maxR,
    y: center + Math.sin(angles[i]) * v * maxR,
  }))

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z'

  // 网格线
  const gridLevels = [0.25, 0.5, 0.75, 1]

  return (
    <svg width={size} height={size} className="drop-shadow-sm">
      {/* 网格 */}
      {gridLevels.map(level => (
        <polygon
          key={level}
          points={angles.map(a => `${center + Math.cos(a) * level * maxR},${center + Math.sin(a) * level * maxR}`).join(' ')}
          fill="none"
          stroke={chartVar.grid}
          strokeWidth={0.5}
        />
      ))}

      {/* 轴线 */}
      {angles.map((a, i) => (
        <line
          key={i}
          x1={center}
          y1={center}
          x2={center + Math.cos(a) * maxR}
          y2={center + Math.sin(a) * maxR}
          stroke={chartVar.grid}
          strokeWidth={0.5}
        />
      ))}

      {/* 数据区域 */}
      <path d={pathD} fill={`${brand.primary}33`} stroke={brand.primary} strokeWidth={1.5} />

      {/* 数据点 */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2} fill={brand.primary} />
      ))}

      {/* 标签 */}
      <text x={center} y={4} textAnchor="middle" className="fill-gray-500 text-[7px]">H</text>
      <text x={size - 2} y={center + 3} textAnchor="end" className="fill-gray-500 text-[7px]">R</text>
      <text x={center} y={size - 1} textAnchor="middle" className="fill-gray-500 text-[7px]">C</text>
      <text x={4} y={center + 3} textAnchor="start" className="fill-gray-500 text-[7px]">I</text>
    </svg>
  )
}
