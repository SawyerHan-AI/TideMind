import { describe, it, expect } from 'vitest';
import { processThinkTags } from '../../src/llm/thinking.js';

// 这些测试 import 真源,与 tests/llm/client-logic.test.ts 的 inlined-from-source
// 形式互补 — 后者是历史副本,本文件保护 S8 (max_tokens 截断在 <think> 内部) 的回归。

describe('processThinkTags', () => {
  it('removes paired <think>...</think> at start', () => {
    const r = processThinkTags('<think>分析中</think>真正答案');
    expect(r.text).toBe('真正答案');
    expect(r.thinkingChars).toBe(3);
  });

  it('removes paired <think>...</think> in middle (global match)', () => {
    // 旧版只锚 ^,中段插入的 <think> 会泄给用户。本版本全局清。
    // 注意:正则 `\s*` 会吃掉 </think> 后的一个空格,结果只剩 '开头 结尾'。
    const r = processThinkTags('开头 <think>中段思考</think> 结尾');
    expect(r.text).toBe('开头 结尾');
    expect(r.thinkingChars).toBe(4);
  });

  it('removes multiple paired <think> blocks', () => {
    const r = processThinkTags('<think>a</think>x<think>bb</think>y');
    expect(r.text).toBe('xy');
    expect(r.thinkingChars).toBe(3);
  });

  it('S8 — orphaned <think> at max_tokens truncation, no closing tag', () => {
    // 推理模型 max_tokens 用尽,响应截断在 <think> 内部。
    const r = processThinkTags('回答 a <think>未闭合的推理被截断');
    // 孤立 <think> 起的部分应剥离,thinkingChars 包含 '<think>' 标签本身长度
    expect(r.text).toBe('回答 a');
    // '<think>未闭合的推理被截断' 共 17 字符
    expect(r.thinkingChars).toBe('<think>未闭合的推理被截断'.length);
  });

  it('S8 — orphaned <think> after a closed pair', () => {
    const r = processThinkTags('<think>aa</think>真答案<think>未闭合');
    expect(r.text).toBe('真答案');
    // 内层 'aa' 2 字符 + 孤立 '<think>未闭合' 11 字符
    expect(r.thinkingChars).toBe(2 + '<think>未闭合'.length);
  });

  it('returns thinkingTokens as ceil(chars/4)', () => {
    const r = processThinkTags('<think>1234567</think>x');
    // 7 chars / 4 = 1.75 → ceil → 2
    expect(r.thinkingTokens).toBe(2);
  });

  it('trims leading/trailing whitespace from text', () => {
    const r = processThinkTags('<think>x</think>   answer   ');
    expect(r.text).toBe('answer');
  });

  it('returns empty string when entire response is unclosed <think>', () => {
    const r = processThinkTags('<think>整段都是没闭合的推理被截断');
    expect(r.text).toBe('');
    expect(r.thinkingChars).toBeGreaterThan(0);
  });

  it('no <think> tags returns text unchanged', () => {
    const r = processThinkTags('普通回答  无 think 标签');
    expect(r.text).toBe('普通回答  无 think 标签');
    expect(r.thinkingChars).toBe(0);
    expect(r.thinkingTokens).toBe(0);
  });

  it('empty input returns empty result', () => {
    const r = processThinkTags('');
    expect(r.text).toBe('');
    expect(r.thinkingChars).toBe(0);
    expect(r.thinkingTokens).toBe(0);
  });
});
