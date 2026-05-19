interface TypeBadgeProps {
    /** 三维内容性质 */
    specificity?: number;
    subjectivity?: number;
    actuality?: number;
    /** refinement === 0 表示尚未经 LLM 标注 */
    refinement?: number;
    /** 结构角色 */
    is_crystal?: number;
    is_keystone?: number;
    is_tag?: number;
    is_meta?: number;
    /** @deprecated 旧 type 字段，用于双写期间 fallback */
    type?: string;
}
export declare function TypeBadge({ specificity, subjectivity, actuality, refinement, is_crystal, is_keystone, is_tag, is_meta, type }: TypeBadgeProps): import("react/jsx-runtime").JSX.Element;
export {};
