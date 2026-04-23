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

  // 2. 从 markdown 代码块中提取:
  //    - 优先匹配带 `json` 语言标签的块(最可信),存在多个时取最后一个
  //      (推理模型经常在正文中引用示例块,真正的答案在末尾)。
  //    - 没有 `json` 标签时再退到裸 ``` 块,同样取最后一个。
  const jsonBlocks: string[] = [];
  const jsonRe = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRe.exec(trimmed)) !== null) {
    jsonBlocks.push(m[1].trim());
  }
  if (jsonBlocks.length > 0) {
    cleaned = jsonBlocks[jsonBlocks.length - 1];
  } else {
    const anyBlocks: string[] = [];
    const anyRe = /```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
    while ((m = anyRe.exec(trimmed)) !== null) {
      anyBlocks.push(m[1].trim());
    }
    if (anyBlocks.length > 0) cleaned = anyBlocks[anyBlocks.length - 1];
  }

  // 3. 代码块内容直接解析
  try {
    return JSON.parse(cleaned) as T;
  } catch { /* continue */ }

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
  const sanitized = cleaned.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try { return JSON.parse(sanitized) as T; } catch { /* continue */ }

  return null;
}
