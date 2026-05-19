import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { DERIVED_CATEGORY_BG, DERIVED_CATEGORY_LABELS, ROLE_LABELS } from '../lib/constants';
import { deriveCategory } from '../lib/dimensions';
export function TypeBadge({ specificity, subjectivity, actuality, refinement, is_crystal, is_keystone, is_tag, is_meta, type }) {
    const { t } = useTranslation('explorer');
    const isPending = refinement != null && refinement === 0;
    // 从维度计算派生分类
    const category = (!isPending && specificity != null && subjectivity != null && actuality != null)
        ? deriveCategory(specificity, subjectivity, actuality)
        : null;
    const label = isPending ? t('detail.pendingClassify') : (category ? DERIVED_CATEGORY_LABELS[category] : (type ?? t('detail.unknown')));
    const bgClass = isPending ? 'bg-white/5 text-gray-500' : (category ? DERIVED_CATEGORY_BG[category] : 'bg-gray-500/20 text-gray-400');
    return (_jsxs("span", { className: "inline-flex items-center gap-1", children: [_jsx("span", { className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${bgClass}`, children: label }), !!is_crystal && (_jsx("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 border border-amber-500/25 text-amber-300", children: ROLE_LABELS.crystal })), !!is_keystone && (_jsx("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-400/10 border border-indigo-400/25 text-indigo-300", children: ROLE_LABELS.keystone })), !!is_tag && (_jsx("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] border border-white/[0.08] text-gray-400", children: ROLE_LABELS.tag })), !!is_meta && (_jsx("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/[0.06] border border-white/[0.08] text-gray-500", children: ROLE_LABELS.meta }))] }));
}
