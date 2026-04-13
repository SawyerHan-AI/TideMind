// ============================================================
// Obsidian Vault 配置读取
//
// 从 .obsidian/ 目录读取 vault 级配置文件，
// 包括 daily notes、附件目录、模板目录等设置。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { ObsidianVaultConfig } from './types.js';
import { OBSIDIAN_EXCLUDED_DIRS } from './types.js';

const log = createLogger('obsidian:config');

/**
 * 读取 vault 配置
 *
 * 从 .obsidian/ 下的 JSON 配置文件提取关键设置。
 * 任何文件缺失或解析失败时使用默认值，不中断流程。
 */
export function readVaultConfig(vaultRoot: string): ObsidianVaultConfig {
  const config: ObsidianVaultConfig = {
    dailyNotes: null,
    attachmentFolder: '',
    templateFolder: '',
    useMarkdownLinks: false,
  };

  // --- Daily Notes 配置 ---
  const dailyNotesConfig = readJsonFile(vaultRoot, 'daily-notes.json');
  if (dailyNotesConfig) {
    config.dailyNotes = {
      folder: String(dailyNotesConfig.folder ?? ''),
      format: String(dailyNotesConfig.format ?? 'YYYY-MM-DD'),
      template: String(dailyNotesConfig.template ?? ''),
    };
    log.debug('读取 daily-notes 配置:', config.dailyNotes);
  }

  // --- App 全局配置 ---
  const appConfig = readJsonFile(vaultRoot, 'app.json');
  if (appConfig) {
    if (typeof appConfig.attachmentFolderPath === 'string') {
      config.attachmentFolder = appConfig.attachmentFolderPath;
    }
    if (typeof appConfig.useMarkdownLinks === 'boolean') {
      config.useMarkdownLinks = appConfig.useMarkdownLinks;
    }
    log.debug('读取 app 配置: attachmentFolder=%s, useMarkdownLinks=%s',
      config.attachmentFolder, config.useMarkdownLinks);
  }

  // --- Templates 配置 ---
  const templatesConfig = readJsonFile(vaultRoot, 'templates.json');
  if (templatesConfig) {
    if (typeof templatesConfig.folder === 'string') {
      config.templateFolder = templatesConfig.folder;
    }
    log.debug('读取 templates 配置: folder=%s', config.templateFolder);
  }

  return config;
}

/**
 * 获取需要排除的目录列表
 *
 * 合并静态排除目录与动态目录（模板、附件）。
 */
export function getExcludedDirs(vaultRoot: string, config: ObsidianVaultConfig): string[] {
  const dirs = [...OBSIDIAN_EXCLUDED_DIRS];

  // 模板目录：内容是模板占位符，不含有效笔记内容
  if (config.templateFolder) {
    dirs.push(config.templateFolder);
  }

  // 附件目录：图片/PDF 等二进制文件，不需要文本处理
  if (config.attachmentFolder) {
    dirs.push(config.attachmentFolder);
  }

  return dirs;
}

// --- 工具函数 ---

/**
 * 安全读取 .obsidian/ 下的 JSON 配置文件
 */
function readJsonFile(vaultRoot: string, filename: string): Record<string, unknown> | null {
  const filePath = path.join(vaultRoot, '.obsidian', filename);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 文件不存在或解析失败，静默返回 null
    log.debug('配置文件不可读: %s', filePath);
    return null;
  }
}
