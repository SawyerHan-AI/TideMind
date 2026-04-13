export function HeatIndicator({ heat, className = '' }: { heat: number; className?: string }) {
  // heat 范围 0-10，映射到颜色
  const normalized = Math.min(heat / 3, 1) // 3 以上就算很热了
  const hue = 220 - normalized * 180 // 蓝(220) → 橙(40) → 红(0)
  const saturation = 30 + normalized * 50
  const lightness = 40 + normalized * 15

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(normalized * 100, 100)}%`,
            backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
          }}
        />
      </div>
      <span className="text-xs text-gray-500 tabular-nums">{heat.toFixed(1)}</span>
    </div>
  )
}
