import { useTranslation } from 'react-i18next'
import { DERIVED_CATEGORY_BG, DERIVED_CATEGORY_LABELS, ROLE_LABELS } from '../lib/constants'
import { deriveCategory } from '../lib/dimensions'

interface TypeBadgeProps {
  /** 三维内容性质 */
  specificity?: number
  subjectivity?: number
  actuality?: number
  /** refinement === 0 表示尚未经 LLM 标注 */
  refinement?: number
  /** 结构角色 */
  is_crystal?: number
  is_keystone?: number
  is_tag?: number
  is_meta?: number
  /** @deprecated 旧 type 字段，用于双写期间 fallback */
  type?: string
}

export function TypeBadge({ specificity, subjectivity, actuality, refinement, is_crystal, is_keystone, is_tag, is_meta, type }: TypeBadgeProps) {
  const { t } = useTranslation('explorer')
  const isPending = refinement != null && refinement === 0

  // 从维度计算派生分类
  const category = (!isPending && specificity != null && subjectivity != null && actuality != null)
    ? deriveCategory(specificity, subjectivity, actuality)
    : null

  const label = isPending ? t('detail.pendingClassify') : (category ? DERIVED_CATEGORY_LABELS[category] : (type ?? t('detail.unknown')))
  const bgClass = isPending ? 'bg-white/5 text-gray-500' : (category ? DERIVED_CATEGORY_BG[category] : 'bg-gray-500/20 text-gray-400')

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${bgClass}`}>
        {label}
      </span>
      {!!is_crystal && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 border border-amber-500/25 text-amber-300">
          {ROLE_LABELS.crystal}
        </span>
      )}
      {!!is_keystone && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-400/10 border border-indigo-400/25 text-indigo-300">
          {ROLE_LABELS.keystone}
        </span>
      )}
      {!!is_tag && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] border border-white/[0.08] text-gray-400">
          {ROLE_LABELS.tag}
        </span>
      )}
      {!!is_meta && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] border border-white/[0.08] text-gray-500">
          {ROLE_LABELS.meta}
        </span>
      )}
    </span>
  )
}
