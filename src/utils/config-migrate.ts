/**
 * 启动时配置自动迁移
 *
 * 检查 ~/.tidemind/config.toml 中已停用 / 即将停用的模型 ID,自动替换为可用版本。
 *
 * 触发场景:
 *   - claude-sonnet-4-0 → claude-sonnet-4-6 (2026-06-15 停用)
 *   - claude-opus-4-0   → claude-opus-4-6   (2026-06-15 停用)
 *   - claude-haiku-3    → claude-haiku-4-5  (2026-04-20 已停用)
 *
 * 设计原则:
 *   - 仅匹配映射表内的精确字符串,其他模型 ID 一律不动
 *   - 写回前先备份到 config.toml.bak.YYYYMMDD
 *   - 写回失败仅 warn,不抛异常,不阻塞 daemon
 *   - line-based 替换以保留原文件的注释和格式
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Logger } from './logger.js';

const MODEL_RENAMES: Record<string, string> = {
  'claude-sonnet-4-0': 'claude-sonnet-4-6',
  'claude-opus-4-0':   'claude-opus-4-6',
  'claude-haiku-3':    'claude-haiku-4-5',
};

const FIELDS = ['light_model', 'standard_model', 'heavy_model'] as const;

// 预编译每个字段的正则,避免在 lines.map 里 N×3 次重复构造
const FIELD_REGEXES = new Map<string, RegExp>(
  FIELDS.map(f => [f, new RegExp(`^(\\s*${f}\\s*=\\s*)(["'])([^"']+)(["'])(\\s*(?:#.*)?)$`)]),
);

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.tidemind', 'config.toml');
}

/**
 * 检查并迁移 [llm] 节下三个 *_model 字段的过期 ID。
 * @param log 用于输出迁移日志(stderr)
 * @param configPath 可选自定义路径,默认 ~/.tidemind/config.toml
 * @returns 是否实际改写了文件
 */
export function migrateConfigIfNeeded(log: Logger, configPath?: string): boolean {
  const file = configPath ?? defaultConfigPath();
  if (!fs.existsSync(file)) return false;

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    log.warn(`无法读取 config 进行迁移检查: ${(err as Error).message}`);
    return false;
  }

  const renames: Array<{ field: string; from: string; to: string }> = [];

  const newLines = raw.split('\n').map(line => {
    for (const field of FIELDS) {
      const m = FIELD_REGEXES.get(field)!.exec(line);
      if (m && m[2] === m[4]) {
        const oldValue = m[3];
        const newValue = MODEL_RENAMES[oldValue];
        if (newValue) {
          renames.push({ field, from: oldValue, to: newValue });
          return `${m[1]}${m[2]}${newValue}${m[4]}${m[5] ?? ''}`;
        }
      }
    }
    return line;
  });

  if (renames.length === 0) return false;

  // 同日多次启动只备份一次,避免覆盖原始备份
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${file}.bak.${dateStr}`;
  try {
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, raw);
    }
  } catch (err) {
    log.warn(`无法创建 config 备份,已跳过自动迁移: ${(err as Error).message}`);
    return false;
  }

  try {
    fs.writeFileSync(file, newLines.join('\n'));
  } catch (err) {
    log.warn(`无法写回迁移后的 config: ${(err as Error).message}`);
    return false;
  }

  for (const r of renames) {
    log.info(`已自动迁移 ${r.field}: ${r.from} → ${r.to}`);
  }
  log.info(`原 config 已备份至 ${path.basename(backupPath)}`);
  return true;
}
