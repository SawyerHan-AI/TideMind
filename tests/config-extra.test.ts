/**
 * config.ts 补充测试 — 覆盖 getConfig, isLlmConfigured, getDataDir
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/strategy/loader.js', () => ({
  loadStrategies: () => {},
  getParam: () => 0,
}));

import { loadConfig, resetConfigCache, isLlmConfigured, getConfig, getDataDir } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  resetConfigCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-config-extra-'));
});

afterEach(() => {
  resetConfigCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== getConfig =====

describe('getConfig', () => {
  it('返回包含所有顶层字段的默认配置', () => {
    const config = getConfig();
    expect(config.general).toBeDefined();
    expect(config.anthropic).toBeDefined();
    expect(config.vertex).toBeDefined();
    expect(config.ollama).toBeDefined();
    expect(config.gemini).toBeDefined();
    expect(config.llm).toBeDefined();
    expect(config.embedding).toBeDefined();
    expect(config.search).toBeDefined();
    expect(config.gates).toBeDefined();
    expect(config.metabolism).toBeDefined();
  });

  it('llm provider 为有效值', () => {
    const config = getConfig();
    // 白名单与 src/types.ts AppConfig.llm.provider 及 client/electron/ipc/_validate.ts
    // ALLOWED_PROVIDER_TYPES 保持一致。原值漏 'ollama' 和 'openai-compatible'
    // 是 stale 测试债 —— 之前 config.toml 写了真实合法值 'openai-compatible'
    // 这条断言就 fail。TODO: 把 union 抽成 src/types.ts 的 const 再 import,
    // 避免 5 处重复(types.ts 4 处 + _validate.ts 1 处 + 这里 1 处)。
    expect(['anthropic', 'vertex', 'gemini', 'ollama', 'openai-compatible'])
      .toContain(config.llm.provider);
  });

  it('默认 embedding dimensions 为 3072', () => {
    const config = getConfig();
    expect(config.embedding.dimensions).toBe(3072);
  });

  it('gates 所有值均为非负数', () => {
    const config = getConfig();
    for (const [key, val] of Object.entries(config.gates)) {
      expect(val, `gates.${key} should be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('metabolism 所有值均为正数', () => {
    const config = getConfig();
    for (const [key, val] of Object.entries(config.metabolism)) {
      expect(val, `metabolism.${key} should be > 0`).toBeGreaterThan(0);
    }
  });
});

// ===== getDataDir =====

describe('getDataDir', () => {
  it('返回非空字符串路径', () => {
    const dir = getDataDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  it('默认返回 ~/.tidemind', () => {
    const dir = getDataDir();
    expect(dir).toBe(path.join(os.homedir(), '.tidemind'));
  });

  it('受配置文件影响', () => {
    resetConfigCache();
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
data_dir = "${tmpDir}/custom-brain"
    `);
    loadConfig(configPath);

    const dir = getDataDir();
    expect(dir).toBe(`${tmpDir}/custom-brain`);
  });
});

// ===== isLlmConfigured =====

describe('isLlmConfigured', () => {
  it('anthropic provider 无 api_key 时返回 false', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[llm]
provider = "anthropic"

[anthropic]
api_key = ""
    `);

    resetConfigCache();
    // 临时清除环境变量的影响
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      loadConfig(configPath);
      expect(isLlmConfigured()).toBe(false);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('anthropic provider 有 api_key 时返回 true', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[llm]
provider = "anthropic"

[anthropic]
api_key = "sk-ant-test-key"
    `);

    resetConfigCache();
    loadConfig(configPath);
    expect(isLlmConfigured()).toBe(true);
  });

  it('gemini provider 无 api_key 时返回 false', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[llm]
provider = "gemini"

[gemini]
api_key = ""
    `);

    resetConfigCache();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      loadConfig(configPath);
      expect(isLlmConfigured()).toBe(false);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('gemini provider 有 api_key 时返回 true', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[llm]
provider = "gemini"

[gemini]
api_key = "AIza-test-key"
    `);

    resetConfigCache();
    loadConfig(configPath);
    expect(isLlmConfigured()).toBe(true);
  });

  it('vertex provider 无凭证文件时返回 false', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
data_dir = "${tmpDir}"

[llm]
provider = "vertex"

[vertex]
project_id = "my-project"
    `);

    resetConfigCache();
    loadConfig(configPath);
    // 没有 vertex-credentials.json 文件
    expect(isLlmConfigured()).toBe(false);
  });

  it('vertex provider 有凭证文件和 project_id 时返回 true', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
data_dir = "${tmpDir}"

[llm]
provider = "vertex"

[vertex]
project_id = "my-project"
    `);

    // 创建凭证文件
    fs.writeFileSync(
      path.join(tmpDir, 'vertex-credentials.json'),
      JSON.stringify({ project_id: 'my-project' }),
    );

    resetConfigCache();
    loadConfig(configPath);
    expect(isLlmConfigured()).toBe(true);
  });

  it('vertex provider 凭证文件中含 project_id 可补充配置', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
data_dir = "${tmpDir}"

[llm]
provider = "vertex"

[vertex]
project_id = ""
    `);

    // 凭证文件中有 project_id
    fs.writeFileSync(
      path.join(tmpDir, 'vertex-credentials.json'),
      JSON.stringify({ project_id: 'from-credentials' }),
    );

    resetConfigCache();
    loadConfig(configPath);
    expect(isLlmConfigured()).toBe(true);
  });
});
