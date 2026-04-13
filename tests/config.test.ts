/**
 * config.ts 单元测试 — 聚焦纯函数（deepMerge, parseMarkdownParams, validateConfig）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 由于 config.ts 的内部函数未 export，我们通过 loadConfig 的行为间接测试
// 同时直接测试已 export 的函数

vi.mock('../../src/strategy/loader.js', () => ({
  loadStrategies: () => {},
  getParam: () => 0,
}));

// 不 mock config.ts 本身——我们要测试它
import { loadConfig, resetConfigCache, isLlmConfigured, getConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  resetConfigCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-config-test-'));
});

afterEach(() => {
  resetConfigCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== loadConfig (间接测试 deepMerge) =====

describe('loadConfig', () => {
  it('无配置文件时返回默认配置', () => {
    const config = loadConfig(path.join(tmpDir, 'nonexistent.toml'));
    expect(config.general.data_dir).toBeDefined();
    expect(config.embedding.dimensions).toBe(3072);
    expect(config.llm.provider).toBe('anthropic');
  });

  it('用户配置覆盖默认值（deepMerge）', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
user_name = "test-user"

[embedding]
dimensions = 768
    `);

    const config = loadConfig(configPath);
    expect(config.general.user_name).toBe('test-user');
    expect(config.embedding.dimensions).toBe(768);
    // 未覆盖的字段保持默认
    expect(config.llm.provider).toBe('anthropic');
  });

  it('嵌套对象正确 merge（不丢失未覆盖字段）', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[llm]
provider = "vertex"
    `);

    const config = loadConfig(configPath);
    expect(config.llm.provider).toBe('vertex');
    // 默认的 model 字段应保留
    expect(config.llm.light_model).toBeDefined();
    expect(config.llm.standard_model).toBeDefined();
  });

  it('~ 路径展开为 home 目录', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
data_dir = "~/my-brain"
    `);

    const config = loadConfig(configPath);
    expect(config.general.data_dir).toBe(path.join(os.homedir(), 'my-brain'));
    expect(config.general.data_dir).not.toContain('~');
  });

  it('配置缓存生效', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[general]
user_name = "cached"
    `);

    const config1 = loadConfig(configPath);
    // 修改文件
    fs.writeFileSync(configPath, `
[general]
user_name = "modified"
    `);
    const config2 = loadConfig(configPath);
    // 应返回缓存
    expect(config2.general.user_name).toBe('cached');

    // 清除缓存后重新加载
    resetConfigCache();
    const config3 = loadConfig(configPath);
    expect(config3.general.user_name).toBe('modified');
  });
});

// ===== validateConfig（通过无效配置触发异常） =====

describe('validateConfig (via loadConfig)', () => {
  it('gates 负数值抛出异常', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[gates]
vector_search = -1
    `);

    expect(() => loadConfig(configPath)).toThrow('非负数');
  });

  it('metabolism 零值抛出异常', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[metabolism]
annotate_interval_minutes = 0
    `);

    expect(() => loadConfig(configPath)).toThrow('正数');
  });

  it('embedding dimensions 零值抛出异常', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[embedding]
dimensions = 0
    `);

    expect(() => loadConfig(configPath)).toThrow('正整数');
  });

  it('embedding dimensions 小数抛出异常', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `
[embedding]
dimensions = 3.14
    `);

    expect(() => loadConfig(configPath)).toThrow('正整数');
  });
});
