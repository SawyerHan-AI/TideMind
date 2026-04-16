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
  let cleaned = raw.trim();

  // 1. 尝试提取 markdown 代码块
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) cleaned = codeBlock[1].trim();

  // 2. 直接解析
  try {
    return JSON.parse(cleaned) as T;
  } catch { /* continue */ }

  // 3. 提取 JSON 对象或数组（括号深度计数，精确定位匹配的闭合符号）
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

  // 4. 清理 BOM 和不可见字符后再试
  const sanitized = cleaned.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try { return JSON.parse(sanitized) as T; } catch { /* continue */ }

  return null;
}
