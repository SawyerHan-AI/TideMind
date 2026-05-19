/**
 * 前端维度工具函数
 * 与 src/utils/dimensions.ts 保持同步
 */
export function deriveCategory(specificity, subjectivity, actuality) {
    if (actuality < 0.4) {
        return subjectivity > 0.5 ? 'intention' : 'hypothesis';
    }
    if (subjectivity > 0.5) {
        return 'belief';
    }
    return specificity > 0.5 ? 'record' : 'knowledge';
}
