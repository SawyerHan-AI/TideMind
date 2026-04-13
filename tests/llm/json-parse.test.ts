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
});
