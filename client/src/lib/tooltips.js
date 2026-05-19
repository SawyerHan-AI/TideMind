// ============================================================
// 外脑概念解释文案集中管理 — i18n 版本
// 所有文案已移至 locales/*/tooltips.json
// 这里导出便捷函数，保持现有 API 兼容
// ============================================================
import i18n from './i18n';
const t = (key) => i18n.t(key, { ns: 'tooltips' });
function i18nTipRecord(prefix, keys) {
    return new Proxy({}, {
        get(_target, prop) {
            return t(`${prefix}.${prop}`);
        },
    });
}
export const DERIVED_CATEGORY_TIPS = i18nTipRecord('derivedCategory', ['record', 'knowledge', 'belief', 'hypothesis', 'intention']);
export const ROLE_TIPS = i18nTipRecord('role', ['crystal', 'keystone', 'tag']);
/** @deprecated 改用 DERIVED_CATEGORY_TIPS */
export const NODE_TYPE_TIPS = i18nTipRecord('nodeType', ['fact', 'context', 'preference', 'idea', 'crystal', 'meta']);
export const MATURITY_TIPS = i18nTipRecord('maturity', ['heat', 'refinement', 'connectivity', 'independence', 'maturity_score']);
export const NODE_ATTR_TIPS = i18nTipRecord('nodeAttr', ['keystone', 'version', 'source_stream']);
export const LINK_TIPS = i18nTipRecord('link', [
    'caused_by', 'continues', 'updates', 'supports', 'contradicts', 'summarizes',
    'part_of', 'analogous', 'tagged', 'confirmed', 'pending', 'strength',
]);
export const OPERATION_TIPS = i18nTipRecord('operation', ['prepare', 'recall', 'digest']);
export const GATE_TIPS = i18nTipRecord('gate', ['basic_digest', 'bm25_search', 'vector_search', 'graph_expansion', 'crystal_generation', 'divergent_scan']);
export const SEARCH_WEIGHT_TIPS = i18nTipRecord('searchWeight', ['alpha', 'beta', 'gamma', 'delta']);
export const METABOLISM_TIPS = i18nTipRecord('metabolism', ['decay_base', 'link_decay_base', 'link_delete_threshold', 'dedup_threshold', 'landing_threshold', 'pending_threshold', 'landing_top_k']);
export const STRATEGY_SKILL_TIPS = i18nTipRecord('strategySkill', ['strategy', 'skill']);
export const GATE_OVERVIEW_TIP = () => t('gateOverview');
