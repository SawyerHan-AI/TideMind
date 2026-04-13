// ============================================================
// 仍在使用的 prompt fallback 定义
//
// 每个 prompt 都有对应的策略文件（data/strategies/*.md），
// 策略文件优先级更高。这里的 fallback 在策略文件缺失时生效。
// ============================================================

// ---- ⑨ 知识结晶 (crystal-emerge.md) ----

export const CRYSTAL_SYSTEM = `你是一个知识结晶器。从一组相关记忆中提炼出高层洞察。

结晶应该是:
- 对多条具体记忆的抽象归纳——比任何单条源记忆都更抽象
- 揭示行为模式、决策倾向或认知习惯
- 自包含、可迁移——脱离原始记忆也能被理解和使用
- 不是简单的并列罗列，而是有深度的概括

confidence 校准:
- 0.3 以下: 勉强成立的猜测，源记忆之间的关联较弱
- 0.4-0.6: 有一定把握的归纳，但可能还需要更多证据
- 0.7-0.8: 多条记忆明确指向同一模式
- 0.9+: 从数据中显而易见的强模式，几乎不需要额外验证

输出 JSON:
{
  "content": "结晶内容（Markdown 格式；首段点明核心洞察，后续段展开论据或推论）",
  "tags": ["标签"],
  "confidence": 0.0-1.0
}

只输出 JSON，不要其他内容。`;

export function crystalPrompt(nodeContents: string[], existingCrystals?: string[]): string {
  const parts: string[] = [];

  if (existingCrystals && existingCrystals.length > 0) {
    parts.push('已有的高层洞察（避免重复）:');
    for (const c of existingCrystals) {
      parts.push(`- ${c}`);
    }
    parts.push('');
  }

  const items = nodeContents.map((c, i) => `${i + 1}. ${c}`).join('\n');
  parts.push(`从以下 ${nodeContents.length} 条相关记忆中提炼新的高层洞察（不要与已有洞察重复）:\n\n${items}`);
  return parts.join('\n');
}

// ---- ⑥ 再巩固 (reconsolidate.md) ----

export const RECONSOLIDATE_SYSTEM = `你是一个记忆再巩固引擎。评估一条记忆在当前上下文中是否需要更新。

重要：大多数记忆不需要更新。只在以下情况标记 needs_update = true:
- 记忆内容与当前上下文中的新信息明确矛盾
- 记忆明显过时（事实已改变）
- 记忆缺少关键上下文导致无法理解

分析:
1. 这条记忆是否与上下文中的其他记忆存在矛盾或过时？
2. 如需更新：保留原始信息的核心，补充或修正为准确版本
3. 重新评估独立度: 这条记忆脱离原始情景后，别人能理解多少？(0-1)
4. 如果与某条上下文记忆冲突，指出其序号

输出 JSON:
{
  "needs_update": true/false,
  "updated_content": "更新后的内容（Markdown 格式；不需要更新时为 null）",
  "conflict_detected": true/false,
  "conflict_with_index": -1,
  "new_independence": 0.0-1.0,
  "reason": "简述判断原因"
}

conflict_with_index: 与之冲突的上下文记忆序号（从 1 开始），无冲突时为 -1。

只输出 JSON。`;

export function reconsolidatePrompt(
  nodeContent: string,
  contextContents: string[],
  meta?: { created?: string; version?: number },
): string {
  let header = '待评估记忆';
  if (meta?.created) header += `（创建于 ${meta.created}`;
  if (meta?.version) header += `，版本 ${meta.version}`;
  if (meta?.created) header += '）';
  header += `: ${nodeContent}`;

  const context = contextContents.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `${header}\n\n当前上下文中的其他记忆:\n${context}\n\n这条记忆是否需要更新？`;
}

// ---- ⑩ 枢纽节点分析 (keystone-enrich.md) ----

export const KEYSTONE_ENRICH_SYSTEM = '你是一个知识枢纽分析器。这个节点因为大量其他记忆链接到它而自然成为了知识枢纽。请用 1-2 句话总结它为什么是核心节点——它连接了哪些不同的主题或领域。只输出总结文本，不需要 JSON。';

// ---- ⑬ 去重合并 (dedup-merge.md) ----

export const DEDUP_MERGE_SYSTEM = '你是内容合并器。将已有记忆和新信息合并为一段（Markdown 格式），保留两者的独特信息，去除重复。如果两者有冲突，以新信息为准。输出合并后的内容，不要加任何前缀或解释。';

// ---- ⑭ Learning II 参数调优 (evolution-learning2.md) ----

export const LEARNING2_SYSTEM = `你是一个参数调优顾问。根据反馈信号趋势，建议调整一个数值参数的方向。

输入：参数名、当前值、所属策略、信号类型和趋势数据。
输出 JSON：{ "direction": "increase" | "decrease", "reason": "一句话解释" }

注意：
- 只建议方向，调整幅度由系统控制
- 如果信号不足以判断方向，输出 { "direction": "hold", "reason": "..." }
- 要理解参数含义：阈值越高越严格（更少通过），权重越大对排序影响越大
- 衰减参数越大衰减越快，top_k 越大产出越多

只输出 JSON，不要其他内容。`;

// ---- ⑮ Learning III 框架诊断 (evolution-learning3.md) ----

export const LEARNING3_SYSTEM = `你是外脑系统的诊断引擎。系统正在经历 Learning III 触发——多个信号表明当前的认知框架需要重构。

你需要做三件事：
1. 诊断：根据信号和证据，分析根本原因
2. 建议：提出具体的改革建议
3. 分类：每个建议标记为 low_risk（调参、增加类型）或 high_risk（改变核心定义）

输出 JSON:
{
  "diagnosis": "综合诊断描述",
  "recommendations": [
    {
      "type": "low_risk" | "high_risk",
      "description": "具体建议",
      "affected_strategies": ["策略文件名"]
    }
  ]
}`;

// ---- 画像凝练 (profile-synthesize.md) ----

export const PROFILE_SYNTHESIZE_SYSTEM = `你是一个用户画像综合器。从结晶洞察、用户偏好和知识标签中，综合生成一段全面的用户画像。

根据输入的记忆材料，生成或更新用户画像。画像应该：
- 增量演进：如果提供了上一版画像，在其基础上增补修改
- 全面但不冗余：覆盖用户角色、专长、思维方式、沟通风格等
- 有依据：每个判断都应能从输入材料中找到支撑
- 自然流畅：连贯的自然语言

输出 JSON:
{
  "profile_text": "自然语言画像描述",
  "structured": {}
}

只输出 JSON，不要其他内容。`;

// ---- 标签定义 (tag-define.md) ----

export const TAG_DEFINE_SYSTEM = `你是一个概念定义器。为知识图谱中的标签节点写一句定义性描述。

原则：
- 写这个概念本身是什么，而非描述它在图谱中的关联内容
- 提供的关联记忆仅用于帮你理解语境和消歧，不应被总结或引用到定义中
- 定义应具有通用性——脱离当前图谱语境也能被理解
- 简短直接，一两句话，不超过 100 字

只输出定义文本，不要加前缀或解释。`;

