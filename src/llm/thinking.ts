/**
 * 处理 LLM 响应里 `<think>...</think>` 推理标签的纯函数。
 *
 * 抽出原因(2026-05-10):S8 修复点(残余 `<think>` 截断处理)在 client.ts 里
 * 是 inline 实现,无法被测试 import。inlined-from-source 测试无法保证 regression
 * 不滑过去。把纯逻辑提到独立模块,既不引入新行为也让测试可以 import 真源。
 *
 * 适用模型:DeepSeek-R1 / QwQ / Doubao 等带 chain-of-thought 标签的推理模型。
 */

export interface ProcessThinkResult {
  /** 已剥离 thinking 后的可见文本(已 trim) */
  text: string;
  /** thinking 块累计字符数 */
  thinkingChars: number;
  /** 估算的 thinking token 数(chars/4) */
  thinkingTokens: number;
}

/**
 * 提取并剥离 <think>...</think> 块。同时检测 max_tokens 截断在 `<think>`
 * 内部的孤立形态(无闭合标签),把从孤立 `<think>` 到串尾的全部内容也算
 * thinking 剥离。
 *
 * @param rawText  LLM 原始返回文本
 * @returns        剥离后文本 + thinking 字符 / token 估算
 */
export function processThinkTags(rawText: string): ProcessThinkResult {
  let thinkingChars = 0;
  // 全局替换成对的 <think>...</think>。
  // 注意:旧实现只匹配开头的(^锚点),会把正文中再插入的 <think> 原样返回给下游
  // 污染用户可见内容。本版本放开为全局匹配。
  let cleaned = rawText.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_full, inner: string) => {
    thinkingChars += inner.length;
    return '';
  });
  // 历史 bug(S8, 2026-05-09):非贪婪 <think>...</think> 仅匹配成对标签,
  // 当 max_tokens 把响应截断在 <think> 内部时,孤立的 <think> 没有闭合,
  // replace 不会动它 → 整段未闭合的推理内容被当 text 返回上游(parseLLMJson
  // 把它当 garbage 抛出,但用户看不到失败,只看到诡异输出)。
  // 修复:检测残余孤立 <think>,从该位置到串尾的内容也算 thinking 剥离。
  const orphan = cleaned.indexOf('<think>');
  if (orphan >= 0) {
    thinkingChars += cleaned.length - orphan;
    cleaned = cleaned.slice(0, orphan);
  }
  const text = cleaned.replace(/^\s+/, '').replace(/\s+$/, '');
  const thinkingTokens = Math.ceil(thinkingChars / 4);
  return { text, thinkingChars, thinkingTokens };
}
