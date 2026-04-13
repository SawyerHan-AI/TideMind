import { nodeColors, relationColors, semantic } from './tokens'
import i18n from './i18n'

const t = (key: string) => i18n.t(key, { ns: 'constants' })

// --- 派生分类（从维度计算） ---
export const DERIVED_CATEGORY_COLORS: Record<string, string> = nodeColors

export function getDerivedCategoryLabel(key: string): string {
  return t(`derivedCategory.${key}`)
}

export const DERIVED_CATEGORY_BG: Record<string, string> = {
  record: 'bg-white/[0.06] border border-white/[0.08] text-gray-300',
  knowledge: 'bg-white/[0.06] border border-white/[0.08] text-gray-300',
  belief: 'bg-white/[0.06] border border-white/[0.08] text-gray-300',
  hypothesis: 'bg-white/[0.06] border border-white/[0.08] text-gray-300',
  intention: 'bg-white/[0.06] border border-white/[0.08] text-gray-300',
}

// --- 结构角色 ---
export function getRoleLabel(key: string): string {
  return t(`role.${key}`)
}

// --- 旧分类（双写期间保留，标记 deprecated） ---
/** @deprecated 改用 DERIVED_CATEGORY_COLORS */
export const NODE_TYPE_COLORS: Record<string, string> = {
  fact: semantic.blue,
  context: semantic.teal,
  preference: semantic.purple,
  idea: semantic.amber,
  crystal: semantic.orange,
  meta: semantic.gray,
}

/** @deprecated 改用 getDerivedCategoryLabel */
export function getNodeTypeLabel(key: string): string {
  return t(`nodeType.${key}`)
}

/** @deprecated 改用 DERIVED_CATEGORY_BG */
export const NODE_TYPE_BG: Record<string, string> = {
  fact: 'bg-blue-500/10 border border-blue-500/30 text-blue-300',
  context: 'bg-teal-500/10 border border-teal-500/30 text-teal-300',
  preference: 'bg-purple-500/10 border border-purple-500/30 text-purple-300',
  idea: 'bg-amber-500/10 border border-amber-500/30 text-amber-300',
  crystal: 'bg-orange-500/10 border border-orange-500/30 text-orange-300',
  meta: 'bg-gray-500/10 border border-gray-500/20 text-gray-400',
}

export const OPERATION_COLORS: Record<string, string> = {
  prepare: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
  recall: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
  digest: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
}

/** 关系类型 → 颜色分组 */
export const RELATION_COLORS: Record<string, string> = relationColors

export function getRelationLabel(key: string): string {
  return t(`relation.${key}`)
}

export function getGateLabel(key: string): string {
  return t(`gate.${key}`)
}

export const GATE_THRESHOLDS: Record<string, { threshold: number; unit: string }> = {
  basic_digest: { threshold: 0, unit: '' },
  bm25_search: { threshold: 0, unit: '' },
  vector_search: { threshold: 50, unit: 'nodes' },
  graph_expansion: { threshold: 100, unit: 'nodes' },
  crystal_generation: { threshold: 200, unit: 'nodes' },
  divergent_scan: { threshold: 500, unit: 'nodes' },
}

export function getGateInfo(key: string): { label: string; threshold: number; unit: string } {
  const th = GATE_THRESHOLDS[key] ?? { threshold: 0, unit: '' }
  return { label: getGateLabel(key), threshold: th.threshold, unit: th.unit ? i18n.t('units.nodes') : '' }
}

// --- 时间线事件类型 ---

export const EVENT_TYPE_COLORS: Record<string, string> = {
  memory:          'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  think_associate: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  think_emerge:    'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  output:          'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  evolution:       'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  config:          'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
}

export function getEventTypeLabel(key: string): string {
  return t(`eventType.${key}`)
}

export function getEventSubtypeLabel(key: string): string {
  return t(`eventSubtype.${key}`)
}

// --- 触发角色 ---

export function getActorLabel(key: string): string {
  return t(`actor.${key}`)
}

export const ACTOR_COLORS: Record<string, string> = {
  user: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
  agent: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
  brain: 'bg-white/[0.06] border border-white/[0.08] text-gray-400',
}

/** 关系类型 → 线型（图视图用） */
export const RELATION_LINE_STYLES: Record<string, string> = {
  caused_by: 'solid',
  continues: 'solid',
  updates: 'solid',
  supports: 'solid',
  contradicts: 'dashed',
  summarizes: 'dotted',
  part_of: 'dotted',
  analogous: 'dashed',
  tagged: 'dotted',
}

// --- LLM 操作 → 5大类别映射（用于用量统计） ---

export type OperationCategory = 'memory' | 'think_associate' | 'think_emerge' | 'output' | 'evolution'

/** llm_usage_log.operation → 5大内部策略类别 */
export const OPERATION_CATEGORY_MAP: Record<string, OperationCategory> = {
  // 记忆
  digest: 'memory',
  'annotate': 'memory',
  dedup: 'memory',
  synaptic: 'memory',
  // 思考（关联）
  'link-evaluate': 'think_associate',
  'link-discover': 'think_associate',
  'link-revalidate': 'think_associate',
  'link-judge': 'think_associate',
  'layer2-link-refine': 'think_associate',
  contradiction: 'think_associate',
  assess: 'think_associate',
  // 思考（涌现）
  keystone: 'think_emerge',
  divergent: 'think_emerge',
  crystal: 'think_emerge',
  'temporal-crystal': 'think_emerge',
  'tag-define': 'think_emerge',
  // 输出
  prepare: 'output',
  reconsolidate: 'output',
  // 进化
  learning2: 'evolution',
  learning3: 'evolution',
}

export function getOperationLabel(key: string): string {
  return t(`operation.${key}`)
}

/** 获取操作所属类别，未知操作归入 memory */
export function getOperationCategory(operation: string | null): OperationCategory {
  if (!operation) return 'memory'
  return OPERATION_CATEGORY_MAP[operation] ?? 'memory'
}

export function getSourceToolLabel(key: string): string {
  return t(`sourceTool.${key}`)
}

// ===== Backward compatibility: static Record objects that resolve at access time =====
// These use Proxy to dynamically resolve translations so existing code using
// DERIVED_CATEGORY_LABELS[key] etc. continues to work without refactoring every call site.

function i18nRecord(prefix: string, keys: string[]): Record<string, string> {
  const base: Record<string, string> = {}
  for (const k of keys) base[k] = '' // placeholder
  return new Proxy(base, {
    get(_target, prop: string) {
      const MISSING = '__eb_missing__'
      const key = String(prop)
      const resolved = i18n.t(`${prefix}.${key}`, { ns: 'constants', defaultValue: MISSING })
      // When translation is missing, return the raw key (e.g. "link_discover") instead of
      // the i18n path ("eventSubtype.link_discover") so call-sites display something usable.
      return resolved === MISSING ? key : resolved
    },
  })
}

export const DERIVED_CATEGORY_LABELS = i18nRecord('derivedCategory', ['record', 'knowledge', 'belief', 'hypothesis', 'intention'])
export const ROLE_LABELS = i18nRecord('role', ['crystal', 'keystone', 'tag', 'meta'])
export const NODE_TYPE_LABELS = i18nRecord('nodeType', ['fact', 'context', 'preference', 'idea', 'crystal', 'meta'])
export const RELATION_LABELS = i18nRecord('relation', ['caused_by', 'continues', 'updates', 'supports', 'contradicts', 'summarizes', 'part_of', 'analogous', 'tagged'])
export const EVENT_TYPE_LABELS = i18nRecord('eventType', ['memory', 'think_associate', 'think_emerge', 'output', 'evolution', 'config'])
export const EVENT_SUBTYPE_LABELS = i18nRecord('eventSubtype', [
  'digest', 'correction', 'archive', 'landing_connection', 'annotate', 'dedup', 'dedup_merge', 'synaptic_scaling',
  'link_classify', 'refine_links', 'link_discover', 'pending_link_review',
  'keystone_identification', 'tag_promote', 'divergent_scan', 'crystal_update', 'split_merge',
  'recall', 'prepare', 'reconsolidation', 'profile_synthesize', 'learning2', 'learning3', 'strategy_rollback',
  'settings_change', 'strategy_update', 'gate_unlock',
  'logseq_sync', 'logseq_file_change', 'obsidian_sync', 'obsidian_file_change', 'apple_notes_sync',
  'daemon_start', 'daemon_stop',
])
export const ACTOR_LABELS = i18nRecord('actor', ['user', 'agent', 'brain'])
export const OPERATION_LABELS = i18nRecord('operation', [
  'digest', 'annotate', 'dedup', 'synaptic', 'link-evaluate', 'link-discover', 'link-revalidate',
  'link-judge', 'layer2-link-refine', 'contradiction', 'assess', 'temporal-crystal',
  'keystone', 'divergent', 'crystal', 'prepare', 'reconsolidate', 'learning2', 'learning3',
])
export const SOURCE_TOOL_LABELS = i18nRecord('sourceTool', ['cursor', 'claude-code', 'codex', 'logseq', 'client'])

// GATE_LABELS backward compat: returns { label, threshold, unit }
export const GATE_LABELS: Record<string, { label: string; threshold: number; unit: string }> = new Proxy(
  {} as Record<string, { label: string; threshold: number; unit: string }>,
  {
    get(_target, prop: string) {
      return getGateInfo(prop)
    },
  },
)
