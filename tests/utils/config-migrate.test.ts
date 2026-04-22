/**
 * config-migrate 单元测试
 *
 * 验证启动时模型 ID 自动迁移的正确性、幂等性、安全性。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { migrateConfigIfNeeded } from '../../src/utils/config-migrate.js';
import type { Logger } from '../../src/utils/logger.js';

// migrateConfigIfNeeded 接收 logger 参数,不依赖 createLogger,因此无需 vi.mock
function makeLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('migrateConfigIfNeeded', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-config-migrate-'));
    configPath = path.join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('替换三个停用模型 ID', () => {
    fs.writeFileSync(configPath, [
      '[llm]',
      'light_model = "claude-haiku-3"',
      'standard_model = "claude-sonnet-4-0"',
      'heavy_model = "claude-opus-4-0"',
    ].join('\n'));

    const changed = migrateConfigIfNeeded(makeLog(), configPath);
    expect(changed).toBe(true);

    const after = fs.readFileSync(configPath, 'utf-8');
    expect(after).toContain('light_model = "claude-haiku-4-5"');
    expect(after).toContain('standard_model = "claude-sonnet-4-6"');
    expect(after).toContain('heavy_model = "claude-opus-4-6"');
  });

  it('生成 .bak 备份文件并保留原内容', () => {
    const raw = 'heavy_model = "claude-opus-4-0"';
    fs.writeFileSync(configPath, raw);

    migrateConfigIfNeeded(makeLog(), configPath);

    const baks = fs.readdirSync(tmpDir).filter(f => f.includes('.bak.'));
    expect(baks.length).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, baks[0]), 'utf-8')).toBe(raw);
  });

  it('幂等:已是新 ID 不改写文件,不创建备份', () => {
    fs.writeFileSync(configPath, 'heavy_model = "claude-opus-4-7"');

    const changed = migrateConfigIfNeeded(makeLog(), configPath);

    expect(changed).toBe(false);
    expect(fs.readdirSync(tmpDir).some(f => f.includes('.bak'))).toBe(false);
  });

  it('保留注释和格式', () => {
    const raw = [
      '# 这是 LLM 配置',
      '[llm]',
      'provider = "anthropic"',
      'heavy_model = "claude-opus-4-0"  # 旧模型',
      '',
      '[other]',
      'foo = "bar"',
    ].join('\n');
    fs.writeFileSync(configPath, raw);

    migrateConfigIfNeeded(makeLog(), configPath);

    const after = fs.readFileSync(configPath, 'utf-8');
    expect(after).toContain('# 这是 LLM 配置');
    expect(after).toContain('heavy_model = "claude-opus-4-6"  # 旧模型');
    expect(after).toContain('foo = "bar"');
  });

  it('自定义模型 ID 不被误改', () => {
    const raw = 'heavy_model = "my-custom-model"';
    fs.writeFileSync(configPath, raw);

    const changed = migrateConfigIfNeeded(makeLog(), configPath);

    expect(changed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(raw);
  });

  it('config 文件不存在时安全返回 false', () => {
    const changed = migrateConfigIfNeeded(makeLog(), path.join(tmpDir, 'no-such.toml'));
    expect(changed).toBe(false);
  });

  it('单引号字符串也能识别', () => {
    fs.writeFileSync(configPath, "heavy_model = 'claude-opus-4-0'");

    const changed = migrateConfigIfNeeded(makeLog(), configPath);

    expect(changed).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain("'claude-opus-4-6'");
  });

  it('部分字段命中、部分不命中:仅替换命中字段', () => {
    fs.writeFileSync(configPath, [
      'light_model = "claude-haiku-4-5"',
      'standard_model = "claude-sonnet-4-0"',
      'heavy_model = "claude-opus-4-7"',
    ].join('\n'));

    const changed = migrateConfigIfNeeded(makeLog(), configPath);

    expect(changed).toBe(true);
    const after = fs.readFileSync(configPath, 'utf-8');
    expect(after).toContain('light_model = "claude-haiku-4-5"');
    expect(after).toContain('standard_model = "claude-sonnet-4-6"');
    expect(after).toContain('heavy_model = "claude-opus-4-7"');
  });

  it('迁移日志包含字段名和新旧 ID', () => {
    const log = makeLog();
    fs.writeFileSync(configPath, 'heavy_model = "claude-opus-4-0"');

    migrateConfigIfNeeded(log, configPath);

    const calls = (log.info as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(calls).toContain('heavy_model');
    expect(calls).toContain('claude-opus-4-0');
    expect(calls).toContain('claude-opus-4-6');
  });

  it('同日多次调用只生成一次 .bak 备份(原始备份不被覆盖)', () => {
    const original = 'heavy_model = "claude-opus-4-0"';
    fs.writeFileSync(configPath, original);

    // 第一次:旧 ID → 新 ID,生成 .bak
    migrateConfigIfNeeded(makeLog(), configPath);
    const baksFirst = fs.readdirSync(tmpDir).filter(f => f.includes('.bak.'));
    expect(baksFirst.length).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, baksFirst[0]), 'utf-8')).toBe(original);

    // 用户(或测试场景)把文件改回旧 ID,模拟同日再次启动 daemon
    fs.writeFileSync(configPath, original);
    migrateConfigIfNeeded(makeLog(), configPath);

    // .bak 数量仍为 1,内容仍是最早的 original(未被覆盖)
    const baksSecond = fs.readdirSync(tmpDir).filter(f => f.includes('.bak.'));
    expect(baksSecond.length).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, baksSecond[0]), 'utf-8')).toBe(original);
  });
});
