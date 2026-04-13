/**
 * tokens.ts — 所有颜色的单一来源
 *
 * 规则：
 * - 品牌色 / 语义色不随主题变，直接用 hex
 * - 图表 UI 色随主题变，通过 CSS 变量桥接（global.css 定义深色/浅色值）
 * - 其他文件的颜色常量应引用此文件，不重复写 hex
 */

// ── 品牌色 ──────────────────────────────────────────────
export const brand = {
  primary: '#818cf8',     // indigo-400，主品牌色
  secondary: '#a78bfa',   // violet-400，渐变伴侣色
  /** 标准品牌渐变（按钮、强调区域） */
  gradient: 'linear-gradient(135deg, #818cf8, #a78bfa)',
  /** 半透明品牌渐变（悬浮态按钮） */
  gradientAlpha: 'linear-gradient(135deg, rgba(129,140,248,0.8), rgba(167,139,250,0.8))',
  /** hover 态品牌渐变 */
  gradientHover: 'linear-gradient(135deg, rgba(129,140,248,0.95), rgba(167,139,250,0.95))',
} as const

// ── 按钮文字色 ──────────────────────────────────────────
export const btnText = {
  /** 品牌色 / 彩色背景上的文字，深浅主题都保持白色 */
  onBrand: '#ffffff',
} as const

// ── 语义色（节点/关系/图表共用的色相，不随主题变）──────
export const semantic = {
  blue:    '#3b82f6',
  teal:    '#14b8a6',
  purple:  '#a855f7',
  amber:   '#f59e0b',
  green:   '#10b981',
  red:     '#ef4444',
  gray:    '#6b7280',
  orange:  '#f97316',
} as const

// ── 图表 UI 色（随主题变，通过 CSS 变量桥接）────────────
// 实际深色/浅色值定义在 global.css 的 :root / [data-theme="light"] 中
export const chartVar = {
  tick:        'var(--chart-tick)',
  tooltipBg:   'var(--chart-tooltip-bg)',
  tooltipText: 'var(--chart-tooltip-text)',
  grid:        'var(--chart-grid)',
} as const

// ── 派生映射（引用上面的原子色）─────────────────────────

/** 派生分类 → 颜色 */
export const nodeColors: Record<string, string> = {
  record: semantic.blue,
  knowledge: semantic.teal,
  belief: semantic.purple,
  hypothesis: semantic.amber,
  intention: semantic.green,
}

/** 关系类型 → 颜色 */
export const relationColors: Record<string, string> = {
  caused_by: semantic.blue,
  continues: semantic.blue,
  updates: semantic.blue,
  supports: semantic.green,
  contradicts: semantic.red,
  summarizes: semantic.gray,
  part_of: semantic.gray,
  analogous: semantic.amber,
  tagged: semantic.amber,
}

/** LLM 模型 → 颜色 */
export const modelColors: Record<string, string> = {
  'claude-haiku': semantic.green,
  'claude-sonnet': semantic.blue,
  'claude-opus': semantic.purple,
  'gemini-flash': semantic.amber,
  'gemini-pro': semantic.orange,
  other: semantic.gray,
}

/** 5 大内部策略类别 → 颜色 */
export const categoryColors: Record<string, string> = {
  memory: semantic.blue,
  think_associate: semantic.teal,
  think_emerge: semantic.purple,
  output: semantic.green,
  evolution: semantic.amber,
}
