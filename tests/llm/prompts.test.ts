/**
 * llm/prompts.ts 单元测试
 *
 * 纯字符串拼接函数，验证 prompt 生成格式。
 */
import { describe, it, expect } from 'vitest';
import {
  CRYSTAL_SYSTEM,
  crystalPrompt,
  RECONSOLIDATE_SYSTEM,
  reconsolidatePrompt,
  KEYSTONE_ENRICH_SYSTEM,
  DEDUP_MERGE_SYSTEM,
  LEARNING2_SYSTEM,
  LEARNING3_SYSTEM,
} from '../../src/llm/prompts.js';

// ===== system prompt 常量 =====

describe('system prompt 常量', () => {
  it('CRYSTAL_SYSTEM 包含 JSON 输出格式要求', () => {
    expect(CRYSTAL_SYSTEM).toContain('content');
    expect(CRYSTAL_SYSTEM).toContain('tags');
    expect(CRYSTAL_SYSTEM).toContain('confidence');
    expect(CRYSTAL_SYSTEM).toContain('JSON');
  });

  it('RECONSOLIDATE_SYSTEM 包含 needs_update 字段', () => {
    expect(RECONSOLIDATE_SYSTEM).toContain('needs_update');
    expect(RECONSOLIDATE_SYSTEM).toContain('conflict_detected');
  });

  it('KEYSTONE_ENRICH_SYSTEM 非空', () => {
    expect(KEYSTONE_ENRICH_SYSTEM.length).toBeGreaterThan(10);
  });

  it('DEDUP_MERGE_SYSTEM 非空', () => {
    expect(DEDUP_MERGE_SYSTEM.length).toBeGreaterThan(10);
  });

  it('LEARNING2_SYSTEM 包含 direction 字段', () => {
    expect(LEARNING2_SYSTEM).toContain('direction');
    expect(LEARNING2_SYSTEM).toContain('increase');
    expect(LEARNING2_SYSTEM).toContain('decrease');
  });

  it('LEARNING3_SYSTEM 包含 recommendations 字段', () => {
    expect(LEARNING3_SYSTEM).toContain('recommendations');
    expect(LEARNING3_SYSTEM).toContain('low_risk');
    expect(LEARNING3_SYSTEM).toContain('high_risk');
  });
});

// ===== crystalPrompt =====

describe('crystalPrompt', () => {
  it('包含所有输入节点内容', () => {
    const result = crystalPrompt(['记忆A', '记忆B', '记忆C']);
    expect(result).toContain('1. 记忆A');
    expect(result).toContain('2. 记忆B');
    expect(result).toContain('3. 记忆C');
    expect(result).toContain('3 条相关记忆');
  });

  it('单条记忆', () => {
    const result = crystalPrompt(['唯一记忆']);
    expect(result).toContain('1. 唯一记忆');
    expect(result).toContain('1 条相关记忆');
  });

  it('无已有结晶时不包含避免重复部分', () => {
    const result = crystalPrompt(['A', 'B']);
    expect(result).not.toContain('已有的高层洞察');
  });

  it('有已有结晶时包含避免重复部分', () => {
    const result = crystalPrompt(['A', 'B'], ['已有洞察1', '已有洞察2']);
    expect(result).toContain('已有的高层洞察');
    expect(result).toContain('- 已有洞察1');
    expect(result).toContain('- 已有洞察2');
    expect(result).toContain('不要与已有洞察重复');
  });

  it('空已有结晶数组不显示', () => {
    const result = crystalPrompt(['A'], []);
    expect(result).not.toContain('已有的高层洞察');
  });
});

// ===== reconsolidatePrompt =====

describe('reconsolidatePrompt', () => {
  it('包含待评估记忆和上下文', () => {
    const result = reconsolidatePrompt(
      '目标记忆内容',
      ['上下文1', '上下文2'],
    );
    expect(result).toContain('目标记忆内容');
    expect(result).toContain('1. 上下文1');
    expect(result).toContain('2. 上下文2');
    expect(result).toContain('是否需要更新');
  });

  it('带 meta 信息', () => {
    const result = reconsolidatePrompt(
      '内容',
      ['ctx'],
      { created: '2026-01-15', version: 3 },
    );
    expect(result).toContain('创建于 2026-01-15');
    expect(result).toContain('版本 3');
  });

  it('只有 created 没有 version', () => {
    const result = reconsolidatePrompt(
      '内容',
      ['ctx'],
      { created: '2026-03-01' },
    );
    expect(result).toContain('创建于 2026-03-01');
    expect(result).not.toContain('版本');
  });

  it('无 meta 时只显示待评估记忆', () => {
    const result = reconsolidatePrompt('内容', ['ctx']);
    expect(result).toContain('待评估记忆: 内容');
    expect(result).not.toContain('创建于');
  });
});
