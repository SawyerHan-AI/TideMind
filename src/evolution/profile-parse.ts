/**
 * 用户画像响应解析与净化。
 *
 * 从 profile-synthesize.ts 迁出，单独成模块的两个原因：
 *   1. 读取侧（prepare.ts buildProfile）需要复用同一套提取逻辑做存量脏数据自愈，
 *      而 profile-synthesize.ts 依赖 better-sqlite3 / callLLM 等重模块，prepare 不该被牵连。
 *   2. 云端（pro/cloud-server）经 `@core/` 别名复用同一份逻辑，避免本地/云端两套解析漂移。
 * 因此本文件只依赖 parseLLMJson，不碰 IO / DB / 网络。
 *
 * ## 历史事故（2026-06-09，定位见 docs/design/hook-injection-overflow-fix-2026-06-11.md）
 *
 * LLM 把画像作为 ```json {...}``` 返回，且 profile_text 值里含未转义引号导致整段 JSON 非法。
 * parseLLMJson 的"宽容子串提取"(json-parse.ts step4) 会回退去抓"第一个能 parse 的
 * brace/bracket span"，结果抓到了 structured 内部某个**合法的数组字段**并返回——一个数组，
 * 不是带 profile_text 的对象。旧 fast path 只判 `if (fastParsed)`(数组 truthy)就采信，
 * `fastParsed.profile_text ?? response.trim()` 兜底把**原始响应全文**当画像存库，专为
 * 未转义引号设计的慢路径从未执行。
 *
 * 修复（F1）：fast path 加严格形状校验——只有"对象且 profile_text 是字符串"才采信，
 * 否则 fall through 到慢路径（慢路径对这条 response 本就能正确分段提取）。
 */

import { parseLLMJson } from '../llm/json-parse.js';

export interface ParsedProfile {
  profileText: string;
  structured: Record<string, unknown>;
}

/**
 * 解析 LLM 的画像响应。
 *
 * 返回 null 表示**彻底失败**——慢路径也救不回来、提取结果仍是一坨"像 JSON 的原文"。
 * 调用方应据此放弃本轮更新、保留上一版画像，而不是把脏全文存库（见 F2）。
 *
 * 注意失败判定刻意只认"像 JSON blob 的原文"：LLM 返回纯散文（无任何 JSON fence/对象）时，
 * profileText = 原文是**合理降级**（散文本身就是画像文本），不算失败——这条行为被
 * tests/evolution/profile-synthesize.test.ts 的"LLM 返回非 JSON 时退化为纯文本画像"固化。
 */
export function parseProfileResponse(response: string): ParsedProfile | null {
  // 快路径:先用 parseLLMJson 做健壮解析(括号深度计数,能正确定位配对的 { },比贪婪正则更可靠)。
  const fastParsed = parseLLMJson<{ profile_text?: string; structured?: Record<string, unknown> }>(response);
  // F1 形状校验:parseLLMJson 的宽容子串提取可能返回 JSON 内部的数组/子对象
  // (json-parse.ts step4),只有"对象且 profile_text 是字符串"才算 fast path 成功,
  // 否则落慢路径。用严格版(要求 profile_text 为 string)而非宽松版
  // ('profile_text' in obj):宽松版在"对象只有 structured 没有 profile_text"子案例下,
  // profile_text ?? response.trim() 仍会把原文存库,原始危害残留。
  if (
    fastParsed
    && typeof fastParsed === 'object'
    && !Array.isArray(fastParsed)
    && typeof fastParsed.profile_text === 'string'
  ) {
    return { profileText: fastParsed.profile_text, structured: fastParsed.structured ?? {} };
  }

  // 慢路径前置:fast path 失败说明 profile_text 里有未转义引号之类的脏内容,
  // 仍然需要拿到一个"最宽的 JSON 样本"做分段提取。复用 markdown code fence /
  // 贪婪正则作为候选样本,不把 null 当致命错误。
  const fenceMatch = response.match(/```json\s*\n([\s\S]*?)\n```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonStr) {
    // 没有任何 JSON 结构——纯散文。合理降级为原文画像（非失败）。
    // 但空白/空串视为失败(null):不该用空画像 supersede 健康旧画像。
    const prose = response.trim();
    return prose ? { profileText: prose, structured: {} } : null;
  }

  // 慢路径：profile_text 中包含未转义引号导致整体 JSON 无法 parse
  // 策略：用 "structured" key 的位置把 JSON 切成两段
  let profileText = response.trim();
  let structured: Record<string, unknown> = {};

  try {
    // 定位 "structured" 的起始位置（从后往前找，因为 profile_text 里可能包含该词）
    const structuredKeyIdx = jsonStr.lastIndexOf('"structured"');
    if (structuredKeyIdx > 0) {
      // 从 "structured": 后面提取它的值对象
      const afterKey = jsonStr.slice(structuredKeyIdx + '"structured"'.length);
      const colonIdx = afterKey.indexOf(':');
      if (colonIdx >= 0) {
        const valueStart = afterKey.slice(colonIdx + 1);
        // 找到这个对象的开头 {
        const objStart = valueStart.indexOf('{');
        if (objStart >= 0) {
          // 用括号配对找到完整的 {} 块
          let depth = 0;
          let end = -1;
          for (let i = objStart; i < valueStart.length; i++) {
            if (valueStart[i] === '{') depth++;
            else if (valueStart[i] === '}') {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
          if (end > 0) {
            const structuredJson = valueStart.slice(objStart, end + 1);
            try {
              structured = JSON.parse(structuredJson);
            } catch {
              // structured 块也无法 parse，跳过（保持 structured = {}）
            }
          }
        }
      }
    }

    // 提取 profile_text：找到 "profile_text" key 后的值
    const ptKeyIdx = jsonStr.indexOf('"profile_text"');
    if (ptKeyIdx >= 0) {
      const afterPtKey = jsonStr.slice(ptKeyIdx + '"profile_text"'.length);
      const ptColonIdx = afterPtKey.indexOf(':');
      if (ptColonIdx >= 0) {
        const afterColon = afterPtKey.slice(ptColonIdx + 1).trimStart();
        if (afterColon.startsWith('"')) {
          // 找到 profile_text 值的结尾——从 "structured" key 的位置往回找
          const endSearch = structuredKeyIdx > 0
            ? jsonStr.slice(0, structuredKeyIdx)
            : jsonStr;
          // profile_text 值在第一个 " 开始，到 "structured" 前最后一个 " 结束
          const ptValueStart = ptKeyIdx + '"profile_text"'.length + ptColonIdx + 1;
          const ptContent = endSearch.slice(ptValueStart).trimStart();
          // 去掉开头的引号和末尾的逗号+引号
          const cleaned = ptContent.replace(/^"/, '').replace(/"\s*,?\s*$/, '');
          // 将 JSON 转义还原
          profileText = cleaned
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .trim();
        }
      }
    }
  } catch {
    // 分段提取失败——落到下面的失败判定
  }

  // F2 彻底失败判定:慢路径跑完,若 profileText 仍是"像 JSON blob 的原文"
  // (以 ``` 或 { 开头),或被切成空白(如 structured 键物理位置在 profile_text 之前、
  // 慢路径把 profile_text 整段切掉的情形)——都判本轮失败返回 null。
  // 空白也算失败:不该用空画像 supersede 健康旧画像。
  if (looksLikeRawJsonBlob(profileText) || profileText.trim() === '') {
    return null;
  }

  return { profileText, structured };
}

/**
 * 判断一段文本是否"看起来仍是未解析的 JSON 原文"(本次事故的危害形态)。
 * 用于 F2 失败判定与 F3 污染检测。
 *
 * 自然语言画像绝不会以 ``` 或 { 开头,所以这两者足以判定"是原文 blob、不是干净画像"。
 * (不再额外要求含 "profile_text" 子串——那会漏掉"缺 profile_text 键的畸形对象"这类原文。)
 */
function looksLikeRawJsonBlob(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('```') || t.startsWith('{');
}

/**
 * 读取侧自愈（F3）：把可能被污染的画像节点 content 净化为可用文本。
 *
 * - 健康内容（纯文本，或"文本 + \n\n---\n\n```json``` structured"标准格式）：原样切出 text。
 * - 污染内容（以 ```json / { 开头且含 "profile_text"）：调 parseProfileResponse 重新提取。
 * - 无法救回：返回 null，调用方走各自的降级（prepare 走基础统计、synthesize 视为无基线）。
 *
 * **任何情况下不返回 raw JSON 当画像文本。**
 */
export function sanitizeProfileContent(content: string): ParsedProfile | null {
  // 标准格式：profileText + '\n\n---\n\n```json\n' + structured + '\n```'
  const parts = content.split('\n\n---\n\n```json\n');
  const head = parts[0];

  // 头部不像 JSON blob → 健康，直接用（structured 尽力解析，失败不影响 text）
  if (!looksLikeRawJsonBlob(head)) {
    let structured: Record<string, unknown> = {};
    if (parts.length > 1) {
      try {
        structured = JSON.parse(parts[1].replace(/\n```$/, '')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }
    return { profileText: head, structured };
  }

  // 头部就是 JSON blob → 污染，走解析提取
  return parseProfileResponse(content);
}
