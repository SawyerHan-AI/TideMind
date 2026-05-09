/**
 * llm/json-parse.ts 单元测试
 *
 * 100% 纯函数，测试 LLM 响应中 JSON 的各种提取场景。
 */
import { describe, it, expect } from 'vitest';
import { parseLLMJson } from '../../src/llm/json-parse.js';

describe('parseLLMJson', () => {
  // ===== 直接 JSON =====

  it('解析标准 JSON 对象', () => {
    const result = parseLLMJson<{ a: number }>('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  it('解析标准 JSON 数组', () => {
    const result = parseLLMJson<number[]>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('解析带空白的 JSON', () => {
    const result = parseLLMJson<{ x: string }>('  \n  {"x": "hello"}  \n  ');
    expect(result).toEqual({ x: 'hello' });
  });

  // ===== markdown 代码块 =====

  it('提取 ```json 代码块中的 JSON', () => {
    const raw = '这是 LLM 的回答：\n```json\n{"key": "value"}\n```\n完成';
    const result = parseLLMJson<{ key: string }>(raw);
    expect(result).toEqual({ key: 'value' });
  });

  it('提取不带 json 标记的代码块', () => {
    const raw = '```\n{"name": "test"}\n```';
    const result = parseLLMJson<{ name: string }>(raw);
    expect(result).toEqual({ name: 'test' });
  });

  it('代码块中包含换行的多行 JSON', () => {
    const raw = '```json\n{\n  "a": 1,\n  "b": [2, 3]\n}\n```';
    const result = parseLLMJson<{ a: number; b: number[] }>(raw);
    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  // ===== 正则提取 =====

  it('从混合文本中提取 JSON 对象', () => {
    const raw = '分析结果如下: {"score": 0.8, "label": "positive"} 以上是分析';
    const result = parseLLMJson<{ score: number; label: string }>(raw);
    expect(result).toEqual({ score: 0.8, label: 'positive' });
  });

  it('从混合文本中提取 JSON 数组', () => {
    const raw = '标签如下: ["tag1", "tag2"] 完毕';
    const result = parseLLMJson<string[]>(raw);
    expect(result).toEqual(['tag1', 'tag2']);
  });

  // ===== BOM 和不可见字符清理 =====

  it('清除 BOM 后解析', () => {
    const raw = '\uFEFF{"clean": true}';
    const result = parseLLMJson<{ clean: boolean }>(raw);
    expect(result).toEqual({ clean: true });
  });

  it('清除控制字符后解析', () => {
    const raw = '{"text": "hello\x00world"}';
    // 控制字符被清除后变成 "helloworld"
    const result = parseLLMJson<{ text: string }>(raw);
    expect(result).toEqual({ text: 'helloworld' });
  });

  // ===== 失败场景 =====

  it('完全无效的字符串返回 null', () => {
    expect(parseLLMJson('这不是 JSON')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseLLMJson('')).toBeNull();
  });

  it('只有空白返回 null', () => {
    expect(parseLLMJson('   \n   ')).toBeNull();
  });

  it('空代码块返回 null', () => {
    expect(parseLLMJson('```json\n\n```')).toBeNull();
  });

  // ===== 边界场景 =====

  it('嵌套 JSON 对象', () => {
    const raw = '{"outer": {"inner": [1, 2]}}';
    const result = parseLLMJson<{ outer: { inner: number[] } }>(raw);
    expect(result).toEqual({ outer: { inner: [1, 2] } });
  });

  it('布尔值和 null', () => {
    const raw = '{"flag": true, "empty": null}';
    const result = parseLLMJson<{ flag: boolean; empty: null }>(raw);
    expect(result).toEqual({ flag: true, empty: null });
  });

  it('unicode 内容', () => {
    const raw = '{"content": "中文内容", "tags": ["标签"]}';
    const result = parseLLMJson<{ content: string; tags: string[] }>(raw);
    expect(result).toEqual({ content: '中文内容', tags: ['标签'] });
  });

  // ===== 括号深度 JSON 提取 - 复杂边界 =====

  it('JSON 值中包含转义引号', () => {
    const raw = 'result: {"text": "he said \\"hello\\"", "ok": true}';
    const result = parseLLMJson<{ text: string; ok: boolean }>(raw);
    expect(result).toEqual({ text: 'he said "hello"', ok: true });
  });

  it('JSON 值中包含花括号（在字符串内）', () => {
    const raw = 'output: {"code": "function() { return {}; }", "lang": "js"}';
    const result = parseLLMJson<{ code: string; lang: string }>(raw);
    expect(result).toEqual({ code: 'function() { return {}; }', lang: 'js' });
  });

  it('JSON 值中包含方括号（在字符串内）', () => {
    const raw = 'data: {"expr": "arr[0] + arr[1]", "val": 3}';
    const result = parseLLMJson<{ expr: string; val: number }>(raw);
    expect(result).toEqual({ expr: 'arr[0] + arr[1]', val: 3 });
  });

  it('多层嵌套括号', () => {
    const raw = 'here: {"a": {"b": {"c": [1, [2, 3]]}}}';
    const result = parseLLMJson<{ a: { b: { c: (number | number[])[] } } }>(raw);
    expect(result).toEqual({ a: { b: { c: [1, [2, 3]] } } });
  });

  it('JSON 前有大量无关文本', () => {
    const raw = '让我分析一下这个问题。首先我们需要考虑多个因素。经过深入思考，我的结论是：\n\n{"conclusion": "yes", "confidence": 0.9}';
    const result = parseLLMJson<{ conclusion: string; confidence: number }>(raw);
    expect(result).toEqual({ conclusion: 'yes', confidence: 0.9 });
  });

  it('JSON 后有大量无关文本', () => {
    const raw = '{"result": true} 以上就是我的分析。希望对你有帮助。如果还有问题请随时提问。';
    const result = parseLLMJson<{ result: boolean }>(raw);
    expect(result).toEqual({ result: true });
  });

  it('JSON 中包含反斜杠转义', () => {
    const raw = '{"path": "C:\\\\Users\\\\test\\\\file.txt"}';
    const result = parseLLMJson<{ path: string }>(raw);
    expect(result).toEqual({ path: 'C:\\Users\\test\\file.txt' });
  });

  it('不闭合的 JSON 花括号返回 null', () => {
    const raw = 'result: {"a": 1, "b": ';
    const result = parseLLMJson(raw);
    expect(result).toBeNull();
  });

  it('不闭合的 JSON 方括号返回 null', () => {
    const raw = 'items: [1, 2, 3, ';
    const result = parseLLMJson(raw);
    expect(result).toBeNull();
  });

  it('优先提取花括号而非方括号（当花括号在前）', () => {
    const raw = '{"obj": true} [1, 2, 3]';
    const result = parseLLMJson<{ obj: boolean }>(raw);
    expect(result).toEqual({ obj: true });
  });

  it('优先提取方括号（当方括号在前且花括号不存在）', () => {
    const raw = 'list: [1, 2, 3] and more text';
    const result = parseLLMJson<number[]>(raw);
    expect(result).toEqual([1, 2, 3]);
  });

  it('字符串内的换行符不破坏解析', () => {
    const raw = '{"text": "line1\\nline2\\nline3"}';
    const result = parseLLMJson<{ text: string }>(raw);
    expect(result).toEqual({ text: 'line1\nline2\nline3' });
  });

  // M1 修复回归保护:LLM 输出"答案 fence + 示例 fence"双块时,parseLLMJson 应
  // 优先取首个解析得通的块,避免错把示例当真答案。老版只取末个块或单块匹配,
  // 双 fence 输出会被误解析。
  describe('M1 双 fenced-block 回归', () => {
    it('first fence 解析成功 → 返回首个块的 JSON', () => {
      const raw = '答案如下:\n```json\n{"answer": 1}\n```\n以下是示例:\n```json\n{"sample": 2}\n```';
      const result = parseLLMJson<{ answer?: number; sample?: number }>(raw);
      // 期望取到首个块(真答案),不是末个示例块
      expect(result?.answer).toBe(1);
      expect(result?.sample).toBeUndefined();
    });

    it('first fence 损坏但 last fence 完好 → 兜底取末个块', () => {
      const raw = '部分答案:\n```json\n{"broken": \n```\n完整版:\n```json\n{"complete": true}\n```';
      const result = parseLLMJson<{ complete?: boolean }>(raw);
      expect(result?.complete).toBe(true);
    });
  });
});
