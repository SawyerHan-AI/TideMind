/**
 * 前端维度工具函数
 * 与 src/utils/dimensions.ts 保持同步
 */
export type DerivedCategory = 'record' | 'knowledge' | 'belief' | 'hypothesis' | 'intention';
export declare function deriveCategory(specificity: number, subjectivity: number, actuality: number): DerivedCategory;
