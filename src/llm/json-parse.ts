/**
 * 统一的 LLM JSON 响应解析器
 *
 * 合并了 9 处重复实现的最佳实践：
 * - markdown 代码块提取（```json ... ```）
 * - 正则提取第一个 JSON 对象或数组
 * - BOM 和不可见字符清理
 * - 泛型类型支持
 */
export function parseLLMJson<T>(raw: string): T | null {
  const trimmed = raw.trim();

  // 1. 先直接试解析整个文本 —— 如果 model 返回的就是裸 JSON,没必要去匹配代码块。
  //    这避免了"model narration 里附带了 ```python 示例"这种情况下代码块
  //    regex 抓到错误片段的 bug。
  try {
    return JSON.parse(trimmed) as T;
  } catch { /* continue */ }

  let cleaned = trimmed;

  // 2. 从 markdown 代码块中提取:依次尝试 *首个* 与 *末个* 代码块,谁先解析
  //    成功就返回。
  //    历史 bug(2026-05-09):只取末个块的策略与 step 4 "取首个 brace/bracket"
  //    不一致——OpenAI/Anthropic 常见模式是"先输出真答案 JSON,再附 narration
  //    或对比示例",末个块往往是示例,首个块才是答案。两个块都试可同时覆盖
  //    "推理模型先 narration 再答案"和"答案先示例后"两种语序。
  const jsonBlocks: string[] = [];
  const jsonRe = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRe.exec(trimmed)) !== null) {
    jsonBlocks.push(m[1].trim());
  }
  let candidates: string[] = [];
  if (jsonBlocks.length > 0) {
    candidates = jsonBlocks.length === 1
      ? [jsonBlocks[0]]
      : [jsonBlocks[0], jsonBlocks[jsonBlocks.length - 1]];
  } else {
    const anyBlocks: string[] = [];
    const anyRe = /```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
    while ((m = anyRe.exec(trimmed)) !== null) {
      anyBlocks.push(m[1].trim());
    }
    if (anyBlocks.length > 0) {
      candidates = anyBlocks.length === 1
        ? [anyBlocks[0]]
        : [anyBlocks[0], anyBlocks[anyBlocks.length - 1]];
    }
  }

  // 3. 代码块内容直接解析:依次试每个候选,谁成功用谁
  for (const cand of candidates) {
    try { return JSON.parse(cand) as T; } catch { /* continue */ }
  }
  // 把首个候选(或原文)作为后续 step 4 的目标
  if (candidates.length > 0) cleaned = candidates[0];

  // 4. 提取 JSON 对象或数组（括号深度计数，精确定位匹配的闭合符号）
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const starts = [firstBrace, firstBracket].filter(i => i >= 0);
  for (const start of starts.sort((a, b) => a - b)) {
    const openChar = cleaned[start] as '{' | '[';
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { /* continue */ }
    }
  }

  // 5. 清理 BOM 和不可见字符后再试
  // eslint-disable-next-line no-control-regex -- JSON from LLMs can contain raw C0 control chars.
  const sanitized = cleaned.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try { return JSON.parse(sanitized) as T; } catch { /* continue */ }

  return null;
}
