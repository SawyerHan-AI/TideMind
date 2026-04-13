/**
 * vault-config.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { readVaultConfig, getExcludedDirs } from '../../../src/integrations/obsidian/vault-config.js';
import type { ObsidianVaultConfig } from '../../../src/integrations/obsidian/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-vault-cfg-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 在 tmpDir/.obsidian/ 下写入配置文件 */
function writeObsidianConfig(filename: string, data: unknown): void {
  const dir = path.join(tmpDir, '.obsidian');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf-8');
}

// ===== daily-notes.json =====

describe('daily-notes config', () => {
  it('读取 daily-notes.json 的 folder、format、template', () => {
    writeObsidianConfig('daily-notes.json', {
      folder: 'journals',
      format: 'YYYY/MM/YYYY-MM-DD',
      template: 'templates/daily',
    });

    const config = readVaultConfig(tmpDir);
    expect(config.dailyNotes).toEqual({
      folder: 'journals',
      format: 'YYYY/MM/YYYY-MM-DD',
      template: 'templates/daily',
    });
  });

  it('daily-notes.json 缺少字段时使用默认值', () => {
    writeObsidianConfig('daily-notes.json', { folder: 'daily' });

    const config = readVaultConfig(tmpDir);
    expect(config.dailyNotes!.format).toBe('YYYY-MM-DD');
    expect(config.dailyNotes!.template).toBe('');
  });
});

// ===== app.json =====

describe('app config', () => {
  it('读取 attachmentFolderPath 和 useMarkdownLinks', () => {
    writeObsidianConfig('app.json', {
      attachmentFolderPath: 'assets',
      useMarkdownLinks: true,
    });

    const config = readVaultConfig(tmpDir);
    expect(config.attachmentFolder).toBe('assets');
    expect(config.useMarkdownLinks).toBe(true);
  });

  it('app.json 字段类型不匹配时不覆盖默认值', () => {
    writeObsidianConfig('app.json', {
      attachmentFolderPath: 123, // 非 string
      useMarkdownLinks: 'yes',  // 非 boolean
    });

    const config = readVaultConfig(tmpDir);
    expect(config.attachmentFolder).toBe('');
    expect(config.useMarkdownLinks).toBe(false);
  });
});

// ===== templates.json =====

describe('templates config', () => {
  it('读取 templates.json 的 folder', () => {
    writeObsidianConfig('templates.json', { folder: 'my-templates' });

    const config = readVaultConfig(tmpDir);
    expect(config.templateFolder).toBe('my-templates');
  });
});

// ===== 缺失和异常 =====

describe('missing and invalid configs', () => {
  it('缺少 .obsidian 目录 → 使用默认值', () => {
    const config = readVaultConfig(tmpDir);
    expect(config.dailyNotes).toBeNull();
    expect(config.attachmentFolder).toBe('');
    expect(config.templateFolder).toBe('');
    expect(config.useMarkdownLinks).toBe(false);
  });

  it('缺少个别配置文件 → 对应部分使用默认值', () => {
    // 只写 daily-notes.json，不写 app.json 和 templates.json
    writeObsidianConfig('daily-notes.json', { folder: 'daily' });

    const config = readVaultConfig(tmpDir);
    expect(config.dailyNotes).not.toBeNull();
    expect(config.attachmentFolder).toBe('');
    expect(config.templateFolder).toBe('');
  });

  it('无效 JSON → 对应部分使用默认值', () => {
    const dir = path.join(tmpDir, '.obsidian');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.json'), '{ invalid json !!!', 'utf-8');

    const config = readVaultConfig(tmpDir);
    expect(config.attachmentFolder).toBe('');
  });
});

// ===== getExcludedDirs =====

describe('getExcludedDirs', () => {
  it('合并静态排除目录与动态目录', () => {
    const config: ObsidianVaultConfig = {
      dailyNotes: null,
      attachmentFolder: 'assets',
      templateFolder: 'templates',
      useMarkdownLinks: false,
    };

    const dirs = getExcludedDirs(tmpDir, config);
    // 静态目录
    expect(dirs).toContain('.obsidian');
    expect(dirs).toContain('.trash');
    expect(dirs).toContain('.git');
    expect(dirs).toContain('node_modules');
    // 动态目录
    expect(dirs).toContain('assets');
    expect(dirs).toContain('templates');
  });

  it('动态目录为空时不添加', () => {
    const config: ObsidianVaultConfig = {
      dailyNotes: null,
      attachmentFolder: '',
      templateFolder: '',
      useMarkdownLinks: false,
    };

    const dirs = getExcludedDirs(tmpDir, config);
    // 只有静态目录
    expect(dirs).toHaveLength(4);
  });
});
