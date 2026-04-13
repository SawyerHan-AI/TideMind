/**
 * link-judge 启发式推断单元测试
 *
 * 测试 inferLinkType 纯函数逻辑，不依赖数据库或 LLM。
 */
import { describe, it, expect, vi } from 'vitest';

// ---- Mock strategy loader ----
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import { inferLinkType } from '../../src/llm/link-judge.js';

// ---- inferLinkType ----

describe('inferLinkType', () => {
  it('一方是 crystal (is_crystal=1) -> summarizes', () => {
    const result = inferLinkType(
      { type: 'crystal', content: 'A', is_crystal: 1 },
      { type: 'fact', content: 'B' },
    );
    expect(result).toEqual({ type: 'summarizes', confidence: 0.8 });
  });

  it('另一方是 crystal 同样 -> summarizes', () => {
    const result = inferLinkType(
      { type: 'idea', content: 'A' },
      { type: 'crystal', content: 'B', is_crystal: 1 },
    );
    expect(result).toEqual({ type: 'summarizes', confidence: 0.8 });
  });

  it('actuality 差距大 -> part_of', () => {
    const result = inferLinkType(
      { content: 'A', actuality: 0.9 },
      { content: 'B', actuality: 0.2 },
    );
    expect(result).toEqual({ type: 'part_of', confidence: 0.5 });
  });

  it('actuality 差距大（反序） -> part_of', () => {
    const result = inferLinkType(
      { content: 'A', actuality: 0.1 },
      { content: 'B', actuality: 0.9 },
    );
    expect(result).toEqual({ type: 'part_of', confidence: 0.5 });
  });

  it('双高 actuality + 低 subjectivity -> supports', () => {
    const result = inferLinkType(
      { content: 'A', actuality: 0.9, subjectivity: 0.1 },
      { content: 'B', actuality: 0.8, subjectivity: 0.2 },
    );
    expect(result).toEqual({ type: 'supports', confidence: 0.6 });
  });

  it('双高 subjectivity -> analogous', () => {
    const result = inferLinkType(
      { content: 'A', subjectivity: 0.8 },
      { content: 'B', subjectivity: 0.9 },
    );
    expect(result).toEqual({ type: 'analogous', confidence: 0.5 });
  });

  it('一方高 specificity -> continues', () => {
    const result = inferLinkType(
      { content: 'A', specificity: 0.8 },
      { content: 'B' },
    );
    expect(result).toEqual({ type: 'continues', confidence: 0.5 });
  });

  it('另一方高 specificity -> continues', () => {
    const result = inferLinkType(
      { content: 'A' },
      { content: 'B', specificity: 0.9 },
    );
    expect(result).toEqual({ type: 'continues', confidence: 0.5 });
  });

  it('默认 (idea + idea) -> analogous', () => {
    const result = inferLinkType(
      { type: 'idea', content: 'A' },
      { type: 'idea', content: 'B' },
    );
    expect(result).toEqual({ type: 'analogous', confidence: 0.4 });
  });
});
