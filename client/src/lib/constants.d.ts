export declare const DERIVED_CATEGORY_COLORS: Record<string, string>;
export declare function getDerivedCategoryLabel(key: string): string;
export declare const DERIVED_CATEGORY_BG: Record<string, string>;
export declare function getRoleLabel(key: string): string;
/** @deprecated 改用 DERIVED_CATEGORY_COLORS */
export declare const NODE_TYPE_COLORS: Record<string, string>;
/** @deprecated 改用 getDerivedCategoryLabel */
export declare function getNodeTypeLabel(key: string): string;
/** @deprecated 改用 DERIVED_CATEGORY_BG */
export declare const NODE_TYPE_BG: Record<string, string>;
export declare const OPERATION_COLORS: Record<string, string>;
/** 关系类型 → 颜色分组 */
export declare const RELATION_COLORS: Record<string, string>;
export declare function getRelationLabel(key: string): string;
export declare function getGateLabel(key: string): string;
export declare const GATE_THRESHOLDS: Record<string, {
    threshold: number;
    unit: string;
}>;
export declare function getGateInfo(key: string): {
    label: string;
    threshold: number;
    unit: string;
};
export declare const EVENT_TYPE_COLORS: Record<string, string>;
export declare function getEventTypeLabel(key: string): string;
export declare function getEventSubtypeLabel(key: string): string;
export declare function getActorLabel(key: string): string;
export declare const ACTOR_COLORS: Record<string, string>;
/** 关系类型 → 线型（图视图用） */
export declare const RELATION_LINE_STYLES: Record<string, string>;
export type OperationCategory = 'memory' | 'think_associate' | 'think_emerge' | 'output' | 'evolution';
/** llm_usage_log.operation → 5大内部策略类别 */
export declare const OPERATION_CATEGORY_MAP: Record<string, OperationCategory>;
export declare function getOperationLabel(key: string): string;
/** 获取操作所属类别，未知操作归入 memory */
export declare function getOperationCategory(operation: string | null): OperationCategory;
export declare function getSourceToolLabel(key: string): string;
export declare const DERIVED_CATEGORY_LABELS: Record<string, string>;
export declare const ROLE_LABELS: Record<string, string>;
export declare const NODE_TYPE_LABELS: Record<string, string>;
export declare const RELATION_LABELS: Record<string, string>;
export declare const EVENT_TYPE_LABELS: Record<string, string>;
export declare const EVENT_SUBTYPE_LABELS: Record<string, string>;
export declare const ACTOR_LABELS: Record<string, string>;
export declare const OPERATION_LABELS: Record<string, string>;
export declare const SOURCE_TOOL_LABELS: Record<string, string>;
export declare const GATE_LABELS: Record<string, {
    label: string;
    threshold: number;
    unit: string;
}>;
