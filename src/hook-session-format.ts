/**
 * SessionStart 注入正文的格式化与 G1 预算安全网（纯函数,无 IO）。
 *
 * 从 hook-session-start.ts 拆出,单独成模块的原因:hook-session-start 顶层有
 * main().catch()(脚本入口)且会读 stdin,直接 import 会触发副作用。把纯拼装/截断
 * 逻辑放这里,既可被 hook 脚本引用,也能在单测里零副作用地直接测。
 *
 * ## G1 背景
 * Claude Code 对 hook 输出有 10,000 字符硬上限(官方文档,不可配),超限则整体落盘为
 * persisted-output、模型只见前 2KB 预览——等于个性化上下文全丢。这里留 1K 余量做安全网。
 * 详见 docs/design/hook-injection-overflow-fix-2026-06-11.md §4.5。
 * 注:这是退化版(固定规则、只截唯一无上界的画像段),将来由"第二层注入预算机制"取代(backlog)。
 */

import type { PrepareOutput } from './types.js';

export const INJECT_BUDGET_CHARS = 9000;
export const PROFILE_FLOOR_CHARS = 500;   // 画像保底,避免被其他段挤到归零
export const HARD_CAP_CHARS = 9800;       // 极端兜底:整体硬截断,宁丢尾部也不触发 persisted-output
const PROFILE_TRUNCATE_MARKER = '……（画像过长已截断，完整画像可调 brain_prepare 获取）';
const HARD_CAP_MARKER = '……（上下文过长已截断，可调 brain_prepare / brain_recall 获取完整记忆）';

/** 画像段:供 G1 预算按段截断(画像是唯一无上界的段落)。 */
export function formatProfileSection(result: PrepareOutput): string {
  return result.profile?.text ? `## 用户画像\n${result.profile.text}` : '';
}

/** 其余段(枢纽/标签/结晶/最近活跃/行为指导):条数已有上限,体积相对可控。 */
export function formatRestSections(result: PrepareOutput): string {
  const sections: string[] = [];

  // 枢纽节点
  if (result.keystones.length > 0) {
    const lines = result.keystones.map(k =>
      `- ${k.title ?? k.id}（${k.link_count} 条关联，id: ${k.id}）`
    );
    sections.push(`## 枢纽节点\n${lines.join('\n')}`);
  }

  // 标签索引
  if (result.tags.length > 0) {
    const lines = result.tags.map(t =>
      `- ${t.title}（${t.link_count} 条关联，id: ${t.id}）`
    );
    sections.push(`## 标签索引\n${lines.join('\n')}`);
  }

  // 结晶
  if (result.crystals.highlighted.length > 0 || result.crystals.others.length > 0) {
    const lines: string[] = [];
    for (const c of result.crystals.highlighted) {
      lines.push(`- ${c.title ?? c.snippet}（id: ${c.id}）`);
    }
    for (const c of result.crystals.others) {
      lines.push(`- ${c.title ?? c.id}（id: ${c.id}）`);
    }
    sections.push(`## 结晶\n${lines.join('\n')}`);
  }

  // 最近活跃
  if (result.recent.length > 0) {
    const lines = result.recent.map(r =>
      `- ${r.title ?? r.id}（${r.type}，${r.timestamp}，id: ${r.id}）`
    );
    sections.push(`## 最近活跃\n${lines.join('\n')}`);
  }

  // 行为指导
  if (result.guidance) {
    sections.push(`## 行为指导\n${result.guidance}`);
  }

  return sections.join('\n\n');
}

/** 在 maxLen 内、尽量在段落边界(\n\n)截断一段文本,并追加 marker。 */
function truncateAtParagraph(text: string, maxLen: number, marker: string): string {
  if (text.length <= maxLen) return text;
  // 防御:maxLen 小到放不下 marker 时,硬切到 maxLen、不追加 marker(保证输出 ≤ maxLen)。
  // 当前 G1 装配不会走到这里(调用方传的 maxLen 都 ≥ PROFILE_FLOOR_CHARS=500 ≫ marker),
  // 加这层是防未来复用时静默超界。
  if (maxLen <= marker.length) return text.slice(0, Math.max(0, maxLen));
  const budget = Math.max(0, maxLen - marker.length);
  const slice = text.slice(0, budget);
  const para = slice.lastIndexOf('\n\n');
  // 段落边界存在且不至于把内容砍到太短(>一半预算)时,优先在边界截
  const body = para > budget * 0.5 ? slice.slice(0, para) : slice;
  return body.trimEnd() + marker;
}

/**
 * 组装 SessionStart 注入正文,并施加 G1 预算安全网。
 *
 * 规则(design §4.5):
 *   1. 总长 ≤ budget → 原样输出。
 *   2. 超出 → 只截画像段(唯一无上界的段落),在段落边界截 + 标记。
 *   3. 画像截到 PROFILE_FLOOR_CHARS 仍超 → 整体在 HARD_CAP_CHARS 硬截断 + 标记
 *      (宁丢尾部索引,也不让整体触发 persisted-output——后者等于全丢)。
 *
 * /clear、错误 fallback 等走 profileSection='' + restSection=静态短文本,自然落规则 1。
 */
export function assembleSessionContext(parts: {
  skillContent: string;
  profileSection: string;
  restSection: string;
  budget?: number;
}): string {
  const budget = parts.budget ?? INJECT_BUDGET_CHARS;

  const build = (profile: string): string => {
    const prepareText = [profile, parts.restSection].filter(Boolean).join('\n\n');
    return `[TIDE MIND — SESSION CONTEXT]

## 使用指南
${parts.skillContent}

${prepareText}

---
以上内容由 Tide Mind 在会话启动时自动注入。brain_recall 和 brain_digest 工具仍可在对话过程中使用。`;
  };

  let content = build(parts.profileSection);
  if (content.length <= budget) return content;

  // 超预算:计算画像可用空间。固定骨架 = 不含画像时的长度;有 restSection 时画像与之间多一个 \n\n。
  const fixedLen = build('').length;
  const sepLen = parts.restSection ? 2 : 0;
  const profileBudget = budget - fixedLen - sepLen;

  if (profileBudget >= PROFILE_FLOOR_CHARS) {
    const truncatedProfile = truncateAtParagraph(parts.profileSection, profileBudget, PROFILE_TRUNCATE_MARKER);
    content = build(truncatedProfile);
    if (content.length <= budget) return content;
  } else {
    // 连 floor 都放不下:画像截到 floor,剩下交给硬截断兜底
    const flooredProfile = truncateAtParagraph(parts.profileSection, PROFILE_FLOOR_CHARS, PROFILE_TRUNCATE_MARKER);
    content = build(flooredProfile);
  }

  // 极端兜底:整体仍超 → 在 HARD_CAP_CHARS 硬截断
  if (content.length > HARD_CAP_CHARS) {
    content = content.slice(0, HARD_CAP_CHARS - HARD_CAP_MARKER.length).trimEnd() + HARD_CAP_MARKER;
  }
  return content;
}
