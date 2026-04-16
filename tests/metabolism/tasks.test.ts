/**
 * ALL_TASKS 注册表验证测试
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _param: string, fallback: number) => fallback,
  getPrompt: () => '',
  getLLMOptions: () => ({}),
  loadStrategies: () => {},
  getStrategy: () => null,
  renderUserPrompt: (_strategy: string, _vars: any, fallback: string) => fallback,
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb', user_name: 'tester' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: 'test', heavy_model: 'test' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.4, beta: 0.3, gamma: 0.2, delta: 0.1 },
    metabolism: { daily_check_hours: [3], weekly_check_days: [0] },
    gates: {
      vector_search: 50, graph_expansion: 20, graph_expansion_links: 10,
      crystal_generation: 100, divergent_scan: 200,
      learning_2_min_nodes: 30, learning_2_min_recall_ops: 10,
    },
    sources: {},
  }),
  getDataDir: () => '/tmp/test-eb',
  isLlmConfigured: () => false,
}));

vi.mock('../../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/connection.js')>();
  return { ...actual, isVecLoaded: () => false };
});

import { ALL_TASKS } from '../../src/metabolism/tasks.js';

describe('ALL_TASKS 注册表', () => {
  it('非空数组', () => {
    expect(Array.isArray(ALL_TASKS)).toBe(true);
    expect(ALL_TASKS.length).toBeGreaterThan(0);
  });

  it('所有 task 都有 id', () => {
    for (const task of ALL_TASKS) {
      expect(typeof task.id).toBe('string');
      expect(task.id.length).toBeGreaterThan(0);
    }
  });

  it('所有 task 都有 execute 函数', () => {
    for (const task of ALL_TASKS) {
      expect(typeof task.execute).toBe('function');
    }
  });

  it('所有 task 都有 intervalStrategy', () => {
    for (const task of ALL_TASKS) {
      expect(typeof task.intervalStrategy).toBe('string');
      expect(task.intervalStrategy.length).toBeGreaterThan(0);
    }
  });

  it('所有 task 都有 defaultIntervalMinutes > 0', () => {
    for (const task of ALL_TASKS) {
      expect(typeof task.defaultIntervalMinutes).toBe('number');
      expect(task.defaultIntervalMinutes).toBeGreaterThan(0);
    }
  });

  it('task ID 不重复', () => {
    const ids = ALL_TASKS.map(t => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('digest-retry 任务设置了 requiresLLM: true', () => {
    const digestRetry = ALL_TASKS.find(t => t.id === 'digest-retry');
    expect(digestRetry).toBeDefined();
    expect(digestRetry!.requiresLLM).toBe(true);
  });

  it('annotate 任务设置了 requiresLLM: true', () => {
    const annotate = ALL_TASKS.find(t => t.id === 'annotate');
    expect(annotate).toBeDefined();
    expect(annotate!.requiresLLM).toBe(true);
  });

  it('link-discover 任务未设置 requiresLLM（不依赖 LLM）', () => {
    const linkDiscover = ALL_TASKS.find(t => t.id === 'link-discover');
    expect(linkDiscover).toBeDefined();
    expect(linkDiscover!.requiresLLM).toBeFalsy();
  });

  it('synaptic-decay 任务未设置 requiresLLM', () => {
    const synapticDecay = ALL_TASKS.find(t => t.id === 'synaptic-decay');
    expect(synapticDecay).toBeDefined();
    expect(synapticDecay!.requiresLLM).toBeFalsy();
  });

  it('所有需要 LLM 的任务都标记了 requiresLLM', () => {
    const llmTasks = ['digest-retry', 'annotate', 'link-evaluate', 'tag-promote',
      'divergent-scan', 'crystal-emerge', 'temporal-crystal', 'profile-synthesize',
      'learning2', 'learning3'];
    for (const taskId of llmTasks) {
      const task = ALL_TASKS.find(t => t.id === taskId);
      expect(task, `task ${taskId} should exist`).toBeDefined();
      expect(task!.requiresLLM, `task ${taskId} should have requiresLLM=true`).toBe(true);
    }
  });

  it('digest-retry 的 defaultIntervalMinutes 为 3', () => {
    const digestRetry = ALL_TASKS.find(t => t.id === 'digest-retry');
    expect(digestRetry!.defaultIntervalMinutes).toBe(3);
  });
});
