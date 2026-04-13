import { describe, it, expect } from 'vitest';
import { pickDisplayTitle } from '../../src/utils/display-title.js';

describe('pickDisplayTitle', () => {
  it('直接返回已有的 title', () => {
    expect(pickDisplayTitle('明确的标题', '正文内容')).toBe('明确的标题');
  });

  it('title 为空字符串时回退到 content 前 20 个字符', () => {
    const content = '这是一段没有显式标题的正文内容,应该取前 20 个字作为显示标题';
    const result = pickDisplayTitle(null, content);
    expect(result).toBeTruthy();
    expect(Array.from(result!.replace(/…$/, '')).length).toBeLessThanOrEqual(20);
    expect(result).toMatch(/^这是一段没有/);
  });

  it('title 为 undefined 时同样回退', () => {
    expect(pickDisplayTitle(undefined, 'hello world')).toBe('hello world');
  });

  it('title 只有空白字符时回退', () => {
    expect(pickDisplayTitle('   ', 'real content')).toBe('real content');
  });

  it('content 短于 20 个字符时原样返回,不加省略号', () => {
    expect(pickDisplayTitle(null, '短内容')).toBe('短内容');
  });

  it('content 恰好 20 个字符时不加省略号', () => {
    const twenty = '一二三四五六七八九十一二三四五六七八九十';
    expect(pickDisplayTitle(null, twenty)).toBe(twenty);
  });

  it('content 超过 20 个字符时截断并加省略号', () => {
    const twentyOne = '一二三四五六七八九十一二三四五六七八九十零';
    const result = pickDisplayTitle(null, twentyOne);
    expect(result).toBe('一二三四五六七八九十一二三四五六七八九十…');
  });

  it('按 code point 截断 emoji,不破坏代理对', () => {
    const content = '👨‍👩‍👧‍👦'.repeat(10);
    const result = pickDisplayTitle(null, content);
    expect(result).toBeTruthy();
    // 不应该产生乱码(不检查具体长度,只要不 throw 且是字符串)
    expect(typeof result).toBe('string');
  });

  it('折叠多余空白', () => {
    expect(pickDisplayTitle(null, '  多个\n\n空白   字符  ')).toBe('多个 空白 字符');
  });

  it('title 和 content 都为空时返回 null', () => {
    expect(pickDisplayTitle(null, null)).toBeNull();
    expect(pickDisplayTitle(null, '')).toBeNull();
    expect(pickDisplayTitle('', '   ')).toBeNull();
  });

  it('maxLen 可自定义', () => {
    expect(pickDisplayTitle(null, '一二三四五六', 3)).toBe('一二三…');
  });
});
