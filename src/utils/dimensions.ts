/**
 * 节点内容性质维度系统
 *
 * 每条记忆在三个正交维度上评分（0-1），取代旧的互斥分类（type 字段）。
 * 分类是从维度派生的视图，不是存储的字段。
 */

// ============================================================
// 类型
// ============================================================

export interface ContentDimensions {
  specificity: number;   // 0 = 一般性知识, 1 = 绑定具体情景
  subjectivity: number;  // 0 = 客观世界, 1 = 个人内在
  actuality: number;     // 0 = 推测假设, 1 = 已确立/已发生
}

export type DerivedCategory = 'record' | 'knowledge' | 'belief' | 'hypothesis' | 'intention';

// ============================================================
// 派生分类
// ============================================================

/**
 * 从三维度计算派生分类。
 * 判断顺序：actuality（区分确立/推测）→ subjectivity（区分客观/主观）→ specificity（区分具体/抽象）
 */
export function deriveCategory(d: ContentDimensions): DerivedCategory {
  if (d.actuality < 0.4) {
    return d.subjectivity > 0.5 ? 'intention' : 'hypothesis';
  }
  if (d.subjectivity > 0.5) {
    return 'belief';
  }
  return d.specificity > 0.5 ? 'record' : 'knowledge';
}

// ============================================================
// 旧 type 兼容（双写期间使用）
// ============================================================

/**
 * 从维度计算旧 type 值，用于双写期间同步 type 列。
 */
export function dimensionsToLegacyType(d: ContentDimensions): string {
  const cat = deriveCategory(d);
  switch (cat) {
    case 'record': return 'fact';
    case 'knowledge': return 'fact';
    case 'belief': return 'preference';
    case 'hypothesis': return 'idea';
    case 'intention': return 'idea';
  }
}

/**
 * 从旧 type 估算维度（数据迁移用）。
 * 估算值是粗略的，后续由 LLM 重新标注精化。
 */
export function legacyTypeToDimensions(type: string): ContentDimensions {
  switch (type) {
    case 'fact':       return { specificity: 0.5, subjectivity: 0.1, actuality: 0.9 };
    case 'context':    return { specificity: 0.3, subjectivity: 0.2, actuality: 0.8 };
    case 'preference': return { specificity: 0.3, subjectivity: 0.8, actuality: 0.8 };
    case 'idea':       return { specificity: 0.5, subjectivity: 0.5, actuality: 0.2 };
    case 'crystal':    return { specificity: 0.2, subjectivity: 0.5, actuality: 0.8 };
    case 'meta':       return { specificity: 0.5, subjectivity: 0.1, actuality: 0.9 };
    case 'tag':        return { specificity: 0.1, subjectivity: 0.1, actuality: 0.9 };
    default:           return { specificity: 0.5, subjectivity: 0.5, actuality: 0.5 };
  }
}

// ============================================================
// 启发式维度推断（入库时使用，替代 inferType）
// ============================================================

/**
 * 基于关键词的粗略维度推断。
 * 在 digest 入库时调用，给出初始分数。后续由 LLM 标注精化。
 */
export function inferDimensions(content: string): ContentDimensions {
  const lower = content.toLowerCase();
  let specificity = 0.5;
  let subjectivity = 0.3;
  let actuality = 0.7;

  // 具体性信号
  if (/\d{4}[-/年]/.test(content) || /今天|昨天|上周|刚才|today|yesterday/.test(lower)) {
    specificity = 0.8;
  }
  if (/一般|通常|总是|规律|原则|always|usually|generally/.test(lower)) {
    specificity = 0.2;
  }

  // 主观性信号
  // 英文 token 加 word boundary，避免 Glove / lovely / preferences 触发假阳。
  // 中文无 boundary，保留子串匹配。
  if (
    /我觉得|我喜欢|偏好|喜欢|讨厌|感觉/.test(content) ||
    /\b(prefer|feel|love|hate)\b/i.test(content)
  ) {
    subjectivity = 0.8;
  }
  if (/决定|选择|decided|chose/.test(lower)) {
    subjectivity = 0.5;
  }

  // 确定性信号
  if (/也许|可能|maybe|perhaps|假设|试试|might|could/.test(lower)) {
    actuality = 0.2;
  }
  if (/确定|已经|完成|决定|confirmed|done|finished/.test(lower)) {
    actuality = 0.9;
  }

  return { specificity, subjectivity, actuality };
}
