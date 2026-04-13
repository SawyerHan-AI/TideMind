/**
 * 画像凝练（profile-synthesize）
 *
 * 定期从 crystals、preferences、tags 中综合生成用户画像。
 * 画像增量演进——每次在上一版基础上增补修改。
 * 归类：思考涌现
 */

import type Database from 'better-sqlite3';
import { createNode } from '../db/nodes.js';
import { createLogger } from '../utils/logger.js';
import { callLLM } from '../llm/client.js';
import { isLlmConfigured } from '../config.js';
import { getParam, getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { logTimelineEvent } from '../db/log.js';
import { supersedeNode } from '../integrations/shared/version.js';

const log = createLogger('profile-synthesize');

const STRATEGY_NAME = 'profile-synthesize';

const FALLBACK_SYSTEM = `你是一个用户画像综合器。从结晶洞察、用户偏好和知识标签中，综合生成一段全面的用户画像。

根据输入的记忆材料，生成或更新用户画像。画像应该增量演进、全面但不冗余、有依据、自然流畅。

输出 JSON:
{
  "profile_text": "自然语言画像描述",
  "structured": {}
}

只输出 JSON，不要其他内容。`;

/** 查找当前有效的画像节点 */
function findCurrentProfile(db: Database.Database): { id: string; content: string; created: string } | null {
  const row = db.prepare(
    `SELECT id, content, created FROM nodes
     WHERE type = 'meta' AND title = 'user-profile' AND is_superseded = 0 AND archived = 0
     ORDER BY created DESC LIMIT 1`,
  ).get() as { id: string; content: string; created: string } | undefined;
  return row ?? null;
}

/** 统计自指定时间以来新增的特定类型/角色节点数 */
function countNewNodesSince(
  db: Database.Database,
  since: string,
  filter: { type?: string; is_crystal?: number },
): number {
  const conditions = ['created > ?', 'is_superseded = 0', 'archived = 0'];
  const params: unknown[] = [since];

  if (filter.type) {
    conditions.push('type = ?');
    params.push(filter.type);
  }
  if (filter.is_crystal !== undefined) {
    conditions.push('is_crystal = ?');
    params.push(filter.is_crystal);
  }

  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as { cnt: number };
  return row.cnt;
}

/** 检查是否应该触发画像生成 */
function shouldRun(db: Database.Database): boolean {
  const current = findCurrentProfile(db);

  // 从未生成过画像——必须跑
  if (!current) return true;

  const since = current.created;
  const triggerCrystals = getParam(STRATEGY_NAME, 'trigger_min_new_crystals', 3);
  const triggerPrefs = getParam(STRATEGY_NAME, 'trigger_min_new_preferences', 4);
  const triggerMaxDays = getParam(STRATEGY_NAME, 'trigger_max_days', 7);

  // 新增结晶达到阈值
  const newCrystals = countNewNodesSince(db, since, { is_crystal: 1 });
  if (newCrystals >= triggerCrystals) {
    log.info(`触发：新增 ${newCrystals} 条结晶 >= ${triggerCrystals}`);
    return true;
  }

  // 新增意愿达到阈值
  const newPrefs = countNewNodesSince(db, since, { type: 'preference' });
  if (newPrefs >= triggerPrefs) {
    log.info(`触发：新增 ${newPrefs} 条意愿 >= ${triggerPrefs}`);
    return true;
  }

  // 兜底：超过最大天数
  const daysSince = (Date.now() - new Date(since).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince >= triggerMaxDays) {
    log.info(`触发：距上次生成已 ${daysSince.toFixed(1)} 天 >= ${triggerMaxDays}`);
    return true;
  }

  log.info(`跳过：新结晶 ${newCrystals}/${triggerCrystals}，新意愿 ${newPrefs}/${triggerPrefs}，天数 ${daysSince.toFixed(1)}/${triggerMaxDays}`);
  return false;
}

/** 获取与 crystal 有链接的 preference 节点 ID 集合（用于去重） */
function getPreferencesLinkedToCrystals(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT n.id
    FROM nodes n
    JOIN links l ON (l.from_id = n.id OR l.to_id = n.id)
    JOIN nodes c ON (
      (l.from_id = c.id AND l.to_id = n.id)
      OR (l.to_id = c.id AND l.from_id = n.id)
    )
    WHERE n.type = 'preference' AND n.is_superseded = 0 AND n.archived = 0
      AND c.is_crystal = 1 AND c.is_superseded = 0 AND c.archived = 0
  `).all() as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

/** 粗略估算文本 token 数（中文约 1.5 字/token，英文约 4 字符/token） */
function estimateTokens(text: string): number {
  // 简单启发：中文字符按 1.5 字/token，ASCII 按 4 字符/token
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++;
    else ascii++;
  }
  return Math.ceil(cjk / 1.5 + ascii / 4);
}

/** 渲染 profile_fields 为人类可读列表 */
function renderProfileFields(fieldsJson: string): string {
  try {
    const fields = JSON.parse(fieldsJson) as Array<{ name: string; description: string }>;
    if (!Array.isArray(fields) || fields.length === 0) return '';
    return fields.map(f => `- **${f.name}**: ${f.description}`).join('\n');
  } catch {
    return '';
  }
}

export async function runProfileSynthesize(db: Database.Database): Promise<void> {
  if (!isLlmConfigured()) {
    log.debug('LLM 未配置，跳过');
    return;
  }
  if (!shouldRun(db)) return;

  const inputMaxTokens = getParam(STRATEGY_NAME, 'input_max_tokens', 15000);

  // 1. 上一版画像
  const currentProfile = findCurrentProfile(db);
  const previousProfileSection = currentProfile
    ? `## 上一版画像（请在此基础上增量更新）\n\n${currentProfile.content}\n\n---`
    : '';

  // 2. Crystal 节点
  const crystals = db.prepare(`
    SELECT id, content, title, maturity_score FROM nodes
    WHERE is_crystal = 1 AND is_superseded = 0 AND archived = 0 AND heat > 0.01
    ORDER BY maturity_score DESC
  `).all() as Array<{ id: string; content: string; title: string | null; maturity_score: number }>;

  // 3. Preference 节点（去重）
  const linkedPrefIds = getPreferencesLinkedToCrystals(db);
  const allPreferences = db.prepare(`
    SELECT id, content, title FROM nodes
    WHERE type = 'preference' AND is_superseded = 0 AND archived = 0 AND heat > 0.01
    ORDER BY maturity_score DESC
  `).all() as Array<{ id: string; content: string; title: string | null }>;
  const preferences = allPreferences.filter(p => !linkedPrefIds.has(p.id));

  // 4. 核心 Tags
  const tags = db.prepare(`
    SELECT n.title, COUNT(l.id) as link_count FROM nodes n
    LEFT JOIN links l ON (l.from_id = n.id OR l.to_id = n.id)
    WHERE n.is_tag = 1 AND n.is_superseded = 0 AND n.archived = 0 AND n.heat > 0.01
    GROUP BY n.id
    ORDER BY link_count DESC
    LIMIT 30
  `).all() as Array<{ title: string; link_count: number }>;

  // 5. Token 预算控制——从低 maturity_score 的 crystal 开始截断
  const crystalTexts = crystals.map(c => {
    const title = c.title ? `**${c.title}**\n` : '';
    return `${title}${c.content}`;
  });

  // 估算总 token 并截断
  const baseTokens = estimateTokens(previousProfileSection)
    + estimateTokens(preferences.map(p => p.content).join('\n'))
    + estimateTokens(tags.map(t => t.title).join(', '))
    + 500; // system prompt + fields 等固定开销

  let crystalTokens = crystalTexts.reduce((sum, t) => sum + estimateTokens(t), 0);
  while (crystalTexts.length > 0 && baseTokens + crystalTokens > inputMaxTokens) {
    crystalTexts.pop(); // 从末尾（最低 maturity_score）开始截断
    crystalTokens = crystalTexts.reduce((sum, t) => sum + estimateTokens(t), 0);
  }

  const crystalsText = crystalTexts.length > 0
    ? crystalTexts.map((t, i) => `${i + 1}. ${t}`).join('\n\n')
    : '（暂无结晶）';

  const preferencesSection = preferences.length > 0
    ? `## 用户意愿\n\n${preferences.map(p => `- ${p.content}`).join('\n')}`
    : '';

  const tagsText = tags.map(t => `${t.title}（${t.link_count} 条关联）`).join('、');

  // 6. Profile fields
  const profileFieldsJson = getParam(STRATEGY_NAME, 'profile_fields', '[]') as string;
  const fieldsRendered = renderProfileFields(profileFieldsJson);
  const profileFieldsSection = fieldsRendered
    ? `## 结构化字段要求\n\n以下字段如果能从上述材料中推断出来，请填写到 structured 对象中。推断不出来的字段直接省略。你也可以在这些字段之外自由添加你认为有价值的字段。\n\n${fieldsRendered}`
    : '';

  // 7. 渲染 user prompt
  const variables: Record<string, string> = {
    previous_profile_section: previousProfileSection,
    crystals: crystalsText,
    preferences_section: preferencesSection,
    tags: tagsText,
    profile_fields_section: profileFieldsSection,
  };

  const fallbackUserPrompt = [previousProfileSection, `## 结晶洞察\n\n${crystalsText}`, preferencesSection, `## 核心标签\n\n${tagsText}`, profileFieldsSection]
    .filter(Boolean).join('\n\n');

  log.info(`输入：${crystalTexts.length} 条结晶, ${preferences.length} 条意愿, ${tags.length} 个标签`);

  // 8. 调用 LLM
  const response = await callLLM({
    prompt: renderUserPrompt(STRATEGY_NAME, variables, fallbackUserPrompt),
    system: getPrompt(STRATEGY_NAME, FALLBACK_SYSTEM),
    ...getLLMOptions(STRATEGY_NAME),
    maxTokens: 2000,
    operationName: STRATEGY_NAME,
  });

  if (!response) {
    log.warn('LLM 无响应');
    return;
  }

  // 9. 解析输出
  let profileText: string;
  let structured: Record<string, unknown> = {};
  try {
    // 尝试从 response 中提取 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 如果没有 JSON，把整个响应当做 profile_text
      profileText = response.trim();
    } else {
      const parsed = JSON.parse(jsonMatch[0]);
      profileText = parsed.profile_text ?? response.trim();
      structured = parsed.structured ?? {};
    }
  } catch {
    profileText = response.trim();
  }

  // 10. 组装存储内容（profile_text + structured 合并存入 content）
  const contentParts = [profileText];
  if (Object.keys(structured).length > 0) {
    contentParts.push('\n\n---\n\n```json\n' + JSON.stringify(structured, null, 2) + '\n```');
  }
  const finalContent = contentParts.join('');

  // 11. 创建新节点并 supersede 旧节点
  const newNode = createNode(db, {
    type: 'meta',
    content: finalContent,
    title: 'user-profile',
    is_meta: 1,
    source_tool: 'profile-synthesize',
    tags: ['user-profile'],
    heat: 1.0,
    refinement: 0.8,
    independence: 1.0,
  });

  if (currentProfile) {
    supersedeNode(db, currentProfile.id, newNode.id);
    log.info(`画像更新：${currentProfile.id} → ${newNode.id}`);
  } else {
    log.info(`首次画像生成：${newNode.id}`);
  }

  // 12. 记录时间线事件
  logTimelineEvent(db, {
    type: 'think_emerge',
    subtype: 'profile_synthesize',
    title: JSON.stringify({ key: 'profile_synthesized', params: { crystals: crystalTexts.length, preferences: preferences.length } }),
    detail: { node_id: newNode.id, is_update: !!currentProfile },
    node_ids: [newNode.id],
    important: 1,
  });
}
