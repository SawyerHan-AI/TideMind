/**
 * strategy/loader.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config to avoid filesystem side effects
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    general: { data_dir: '/tmp/test-eb-strategy' },
    anthropic: { api_key: '' },
    vertex: { project_id: '', region: 'us-central1' },
    ollama: { url: 'http://localhost:11434' },
    gemini: { api_key: '' },
    llm: { provider: 'anthropic', standard_model: '', heavy_model: '' },
    embedding: { provider: 'vertex', model: 'gemini-embedding-001', dimensions: 3072 },
    search: { alpha: 0.3, beta: 0.5, gamma: 0.1, delta: 0.1 },
    gates: {},
    metabolism: {},
  }),
  getDataDir: () => '/tmp/test-eb-strategy',
  isLlmConfigured: () => false,
}));

// Mock node:fs at module level so both test and loader share the same mock
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const defaultMtimeMs = 1000;
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      readdirSync: vi.fn().mockReturnValue([]),
      readFileSync: vi.fn().mockReturnValue(''),
      statSync: vi.fn().mockReturnValue({ mtimeMs: defaultMtimeMs }),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ mtimeMs: defaultMtimeMs }),
  };
});

import fs from 'node:fs';
import {
  loadStrategies,
  getStrategy,
  getParam,
  getPrompt,
  reloadStrategies,
  getStrategyNames,
} from '../../src/strategy/loader.js';

const SAMPLE_STRATEGY = `# metabolism-params

版本: 2 状态: active

## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| dedup_threshold | 0.92 | 去重阈值 |
| landing_link_threshold | 0.80 | 着陆链接阈值 |
| pending_link_threshold | 0.60 | 待确认链接阈值 |
| max_retries | 3 | 最大重试次数 |
| enabled | true | 是否启用 |
| mode | balanced | 运行模式 |

## System Prompt

You are a helpful assistant for the Tide Mind system.

## Other Section

Some other content.
`;

beforeEach(() => {
  // Reset mocks and strategy cache
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.readFileSync).mockReturnValue('');
  vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as any);
  reloadStrategies();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===== getParam =====

describe('getParam', () => {
  it('should return fallback when no strategy loaded', () => {
    const result = getParam('metabolism-params', 'dedup_threshold', 0.90);
    expect(result).toBe(0.90);
  });

  it('should return parsed number value when strategy exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    reloadStrategies();

    const result = getParam('metabolism-params', 'dedup_threshold', 0.90);
    expect(result).toBe(0.92);
  });

  it('should return fallback when param does not exist in strategy', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    reloadStrategies();

    const result = getParam('metabolism-params', 'nonexistent_param', 42);
    expect(result).toBe(42);
  });

  it('should return fallback when strategy name does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    reloadStrategies();

    const result = getParam('nonexistent-strategy', 'dedup_threshold', 0.90);
    expect(result).toBe(0.90);
  });

  it('should return string value when fallback is string', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    reloadStrategies();

    const result = getParam('metabolism-params', 'mode', 'default');
    expect(result).toBe('balanced');
  });

  it('should return fallback when type mismatch (param is string but fallback is number)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    reloadStrategies();

    // 'mode' is a string in the strategy, but fallback is a number
    const result = getParam('metabolism-params', 'mode', 0);
    expect(result).toBe(0); // Should return fallback due to type mismatch
  });
});

// ===== loadStrategies =====

describe('loadStrategies', () => {
  it('should handle missing strategies directory gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadStrategies('/nonexistent/dir');

    expect(getStrategyNames()).toEqual([]);
  });

  it('should load multiple strategy files (only .md)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['a.system.md', 'b.system.md', 'c.txt'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue('| param1 | 1.0 | desc |');
    loadStrategies('/tmp/strategies');

    const names = getStrategyNames();
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('c');
  });

  it('should return default version and status (version no longer parsed from file)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['test-strategy.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    loadStrategies('/tmp/strategies');

    const strategy = getStrategy('test-strategy');
    expect(strategy).not.toBeNull();
    expect(strategy!.version).toBe(1); // 版本号已迁移到 DB 管理
    expect(strategy!.status).toBe('active');
  });
});

// ===== getStrategy =====

describe('getStrategy', () => {
  it('should return null for nonexistent strategy', () => {
    const result = getStrategy('nonexistent');
    expect(result).toBeNull();
  });

  it('should return strategy object with correct fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    loadStrategies('/tmp/strategies');

    const strategy = getStrategy('metabolism-params');
    expect(strategy).not.toBeNull();
    expect(strategy!.name).toBe('metabolism-params');
    expect(strategy!.params).toHaveProperty('dedup_threshold', 0.92);
    expect(strategy!.rawContent).toBe(SAMPLE_STRATEGY);
  });
});

// ===== getPrompt =====

describe('getPrompt', () => {
  it('should return fallback when no strategy loaded', () => {
    const result = getPrompt('metabolism-params', 'default prompt');
    expect(result).toBe('default prompt');
  });

  it('should return system prompt from strategy when available', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    loadStrategies('/tmp/strategies');

    const result = getPrompt('metabolism-params', 'fallback');
    expect(result).toBe('You are a helpful assistant for the Tide Mind system.');
  });

  it('should return fallback when strategy has no system prompt', () => {
    const noPromptStrategy = `# test
版本: 1 状态: active

| param1 | 1.0 | desc |
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['test.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(noPromptStrategy);
    loadStrategies('/tmp/strategies');

    const result = getPrompt('test', 'default prompt');
    expect(result).toBe('default prompt');
  });
});

// ===== reloadStrategies =====

describe('reloadStrategies', () => {
  it('should clear cache and reload from default dir', () => {
    // Load initial with explicit dir
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['old.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue('| param1 | 1.0 | desc |');
    loadStrategies('/tmp/strategies');

    expect(getStrategyNames()).toContain('old');

    // Reload — reloadStrategies uses default dir
    vi.mocked(fs.readdirSync).mockReturnValue(['new.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue('| param2 | 2.0 | desc |');
    reloadStrategies();

    const names = getStrategyNames();
    expect(names).not.toContain('old');
  });
});

// ===== parseParams type conversion =====

describe('parseParams (via getParam)', () => {
  it('should parse boolean true value', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    loadStrategies('/tmp/strategies');

    const result = getParam('metabolism-params', 'enabled', false);
    expect(result).toBe(true);
  });

  it('should parse integer value as number', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['metabolism-params.system.md'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_STRATEGY);
    loadStrategies('/tmp/strategies');

    const result = getParam('metabolism-params', 'max_retries', 1);
    expect(result).toBe(3);
  });
});
