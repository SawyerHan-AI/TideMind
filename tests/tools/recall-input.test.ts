/**
 * normalizeRecallInput 单元测试
 *
 * 重点:兼容字段 scope 的裸值(无前缀)必须映射到 tags,不能被静默丢弃。
 */
import { describe, it, expect } from 'vitest';
import { normalizeRecallInput } from '../../src/tools/recall-input.js';

describe('normalizeRecallInput - scope 兼容映射', () => {
  it('带 tag: 前缀的 scope → tags', () => {
    const input = normalizeRecallInput({ scope: 'tag:tidemind' }, null, undefined);
    expect(input.tags).toEqual(['tidemind']);
  });

  it('带 project: 前缀的 scope → tags', () => {
    const input = normalizeRecallInput({ scope: 'project:my-app' }, null, undefined);
    expect(input.tags).toEqual(['my-app']);
  });

  it('裸 scope(无前缀)也映射到 tags,而非被静默丢弃', () => {
    const input = normalizeRecallInput({ scope: 'tidemind' }, null, undefined);
    expect(input.tags).toEqual(['tidemind']);
    // 单 tag 还会反向写回 scope 供 recall.ts 老逻辑用
    expect(input.scope).toBe('tag:tidemind');
  });

  it('空 scope 字符串不产生空 tag', () => {
    const input = normalizeRecallInput({ scope: '' }, null, undefined);
    expect(input.tags).toBeUndefined();
  });

  it('显式 tags 存在时不被 scope 覆盖', () => {
    const input = normalizeRecallInput({ tags: ['explicit'], scope: 'tidemind' }, null, undefined);
    expect(input.tags).toEqual(['explicit']);
  });
});

describe('normalizeRecallInput - limit 不再被强制默认', () => {
  it('未传 limit 时 input.limit 为 undefined(交给 recall.ts 按 mode 取策略默认值)', () => {
    const input = normalizeRecallInput({ query: 'x' }, null, undefined);
    expect(input.limit).toBeUndefined();
  });

  it('显式传 limit 时透传', () => {
    const input = normalizeRecallInput({ query: 'x', limit: 12 }, null, undefined);
    expect(input.limit).toBe(12);
  });
});

describe('normalizeRecallInput - 其它兼容映射保持不变', () => {
  it('source_file → vault_file + 反向 source_file', () => {
    const input = normalizeRecallInput({ source_file: 'notes/a.md' }, null, undefined);
    expect(input.vault_file).toBe('notes/a.md');
    expect(input.source_file).toBe('notes/a.md');
  });

  it('index_ref node: → node_id', () => {
    const input = normalizeRecallInput({ index_ref: 'node:abc' }, null, undefined);
    expect(input.node_id).toBe('abc');
  });

  it('created_after/before → time + 反向回写', () => {
    const input = normalizeRecallInput(
      { created_after: '2026-01-01', created_before: '2026-02-01' }, null, undefined,
    );
    expect(input.time?.after).toBe('2026-01-01');
    expect(input.created_after).toBe('2026-01-01');
    expect(input.created_before).toBe('2026-02-01');
  });
});
