import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('strategy');

// --- 类型 ---

export interface ParsedStrategy {
  name: string;
  version: number;
  status: string;
  systemPrompt: string | null;
  userPrompt: string | null;
  params: Record<string, number | string | boolean>;
  rawContent: string;
}

interface CacheEntry {
  strategy: ParsedStrategy;
  mtime: number;
  filePath: string;
  paramsFilePath?: string;
  paramsMtime?: number;
  paramsContent?: string;
  userPromptFilePath?: string;
  userPromptMtime?: number;
  userPromptContent?: string;
}

// --- 缓存 ---

let cache: Map<string, CacheEntry> | null = null;
let lastMtimeCheck = 0;
const MTIME_CHECK_INTERVAL = 5000; // 每 5 秒最多检查一次文件变更

// --- 解析逻辑 ---

/**
 * 从策略文件 Markdown 内容中解析参数表格
 *
 * 匹配格式: | param_name | value | description |
 * 跳过表头分隔行 (|------|-----|------|)
 */
function parseParams(content: string): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    // 跳过分隔行
    if (/^\|\s*-+/.test(line)) continue;
    // 跳过表头行（包含"参数"或"param"）
    if (/^\|\s*(参数|param)/i.test(line)) continue;

    let key: string | undefined;
    let rawValue: string | undefined;

    // 格式 1: 表格 | key | value | description |
    const tableMatch = line.match(/^\|\s*([\w_]+)\s*\|\s*([^|]+?)\s*\|/);
    if (tableMatch) {
      key = tableMatch[1];
      rawValue = tableMatch[2].trim();
    }

    // 格式 2: 列表 - key: value
    if (!key) {
      const listMatch = line.match(/^\s*-\s+([\w_]+)\s*:\s*(.+)$/);
      if (listMatch) {
        key = listMatch[1];
        rawValue = listMatch[2].trim();
      }
    }

    if (!key || rawValue === undefined) continue;

    // 类型转换
    if (rawValue === 'true') {
      params[key] = true;
    } else if (rawValue === 'false') {
      params[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      params[key] = Number(rawValue);
    } else {
      params[key] = rawValue;
    }
  }

  return params;
}

/**
 * 从 Markdown 中提取 System Prompt 段落
 *
 * 优先取 "## System Prompt" (或包含 "System Prompt" 的 ## 标题) 到下一个 ## 之间的内容。
 * 如果没有 ## System Prompt 标记且文件不含参数表格，则整个文件内容就是 prompt。
 */
function parseSystemPrompt(content: string): string | null {
  // 优先：传统格式，有 ## System Prompt 标记
  const match = content.match(/##\s+.*System\s*Prompt[^\n]*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/i);
  if (match) {
    const prompt = match[1].trim();
    return prompt.length > 0 ? prompt : null;
  }

  // 新格式：整个文件就是 prompt（无 ## System Prompt 标记且无参数表格行）
  const hasParamTable = content.split('\n').some(line =>
    /^\|\s*[\w_]+\s*\|/.test(line) && !/^\|\s*-+/.test(line),
  );
  if (!hasParamTable) {
    const prompt = content.trim();
    return prompt.length > 0 ? prompt : null;
  }

  return null;
}

/**
 * 解析状态（版本号已迁移到 DB 管理，不再从文件解析）
 */
function parseVersionStatus(_content: string): { version: number; status: string } {
  return { version: 1, status: 'active' };
}

/**
 * 解析单个策略文件
 */
function parseStrategyFile(name: string, content: string): ParsedStrategy {
  const { version, status } = parseVersionStatus(content);
  return {
    name,
    version,
    status,
    systemPrompt: parseSystemPrompt(content),
    userPrompt: null,
    params: parseParams(content),
    rawContent: content,
  };
}

/**
 * 检查缓存中的策略文件是否已被外部修改，如有变更则重新加载
 * 并将变更记录到 strategy_versions 表
 *
 * 每 MTIME_CHECK_INTERVAL 毫秒最多检查一次，避免频繁 stat 调用
 */
function checkMtimeInvalidation(): void {
  if (!cache) return;

  const now = Date.now();
  if (now - lastMtimeCheck < MTIME_CHECK_INTERVAL) return;
  lastMtimeCheck = now;

  for (const [name, entry] of cache) {
    try {
      let needsReload = false;

      // 检查主文件变更
      const stat = fs.statSync(entry.filePath);
      if (stat.mtimeMs !== entry.mtime) needsReload = true;

      // 检查 params 文件变更
      if (entry.paramsFilePath) {
        try {
          const paramsStat = fs.statSync(entry.paramsFilePath);
          if (paramsStat.mtimeMs !== entry.paramsMtime) needsReload = true;
        } catch {
          // params 文件被删除
          needsReload = true;
        }
      } else {
        // 检查是否新增了 params 文件
        const paramsFilePath = entry.filePath.replace(/\.system\.md$/, '.params.md');
        if (fs.existsSync(paramsFilePath)) needsReload = true;
      }

      // 检查 user prompt 文件变更
      if (entry.userPromptFilePath) {
        try {
          const userStat = fs.statSync(entry.userPromptFilePath);
          if (userStat.mtimeMs !== entry.userPromptMtime) needsReload = true;
        } catch {
          needsReload = true;
        }
      } else {
        const userPromptFilePath = entry.filePath.replace(/\.system\.md$/, '.user.md');
        if (fs.existsSync(userPromptFilePath)) needsReload = true;
      }

      if (needsReload) {
        const newContent = fs.readFileSync(entry.filePath, 'utf-8');
        const oldContent = entry.strategy.rawContent;
        const parsed = parseStrategyFile(name, newContent);

        // 加载 params 文件
        const paramsFilePath = entry.filePath.replace(/\.system\.md$/, '.params.md');
        let newParamsMtime: number | undefined;
        let newParamsFilePath: string | undefined;
        let newParamsContent: string | undefined;
        if (fs.existsSync(paramsFilePath)) {
          try {
            const paramsContent = fs.readFileSync(paramsFilePath, 'utf-8');
            const paramsStat = fs.statSync(paramsFilePath);
            const paramsFromFile = parseParams(paramsContent);
            Object.assign(parsed.params, paramsFromFile);
            newParamsMtime = paramsStat.mtimeMs;
            newParamsFilePath = paramsFilePath;
            newParamsContent = paramsContent;
            // params 内容变化时记录版本
            if (paramsContent !== entry.paramsContent) {
              recordFileChangeVersion(`${name}.params`, newContent.length > 0 ? paramsContent : '');
            }
          } catch { /* */ }
        }

        // 加载 user prompt 文件
        const userPromptFilePath = entry.filePath.replace(/\.system\.md$/, '.user.md');
        let newUserPromptMtime: number | undefined;
        let newUserPromptFilePath: string | undefined;
        let newUserPromptContent: string | undefined;
        if (fs.existsSync(userPromptFilePath)) {
          try {
            const userContent = fs.readFileSync(userPromptFilePath, 'utf-8');
            const userStat = fs.statSync(userPromptFilePath);
            parsed.userPrompt = userContent.trim() || null;
            newUserPromptMtime = userStat.mtimeMs;
            newUserPromptFilePath = userPromptFilePath;
            newUserPromptContent = userContent;
            // user prompt 内容变化时记录版本
            if (userContent !== entry.userPromptContent) {
              recordFileChangeVersion(`${name}:user`, userContent);
            }
          } catch { /* */ }
        }

        // system prompt 内容变化时记录版本
        if (newContent !== oldContent) {
          recordFileChangeVersion(name, newContent);
        }

        cache.set(name, {
          strategy: parsed,
          mtime: stat.mtimeMs,
          filePath: entry.filePath,
          paramsFilePath: newParamsFilePath,
          paramsMtime: newParamsMtime,
          paramsContent: newParamsContent,
          userPromptFilePath: newUserPromptFilePath,
          userPromptMtime: newUserPromptMtime,
          userPromptContent: newUserPromptContent,
        });
      }
    } catch {
      // 文件可能被删除，从缓存中移除
      cache.delete(name);
    }
  }
}

/**
 * 文件变化时自动记录版本到 DB（尽力而为，失败静默）
 * 统一入口：策略 system/user/params、skill、MCP 描述变更都经此记录
 */
function recordFileChangeVersion(strategyName: string, content: string): void {
  if (!content) return; // 不记录空内容
  try {
    const dbPath = path.join(getDataDir(), 'graph', 'brain.sqlite');
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // 检查最近一条记录内容是否相同（去重）
    const existing = db.prepare(
      'SELECT content FROM strategy_versions WHERE strategy_name = ? ORDER BY id DESC LIMIT 1',
    ).get(strategyName) as { content: string } | undefined;

    if (existing && existing.content === content) {
      db.close();
      return;
    }

    const maxVersion = (db.prepare(
      'SELECT MAX(version) as mv FROM strategy_versions WHERE strategy_name = ?',
    ).get(strategyName) as { mv: number | null })?.mv ?? 0;

    db.prepare(
      "INSERT INTO strategy_versions (strategy_name, version, content, change_reason, changed_by, created) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    ).run(strategyName, maxVersion + 1, content, '文件变更自动记录', 'file_edit');

    log.info(`${strategyName} 文件变更，记录 v${maxVersion + 1}`);
    db.close();
  } catch {
    // DB 不可用时静默
  }
}

// --- 公开 API ---

/**
 * 加载所有策略文件到内存缓存（带 mtime 记录）
 */
export function loadStrategies(strategiesDir?: string): void {
  const dir = strategiesDir ?? path.join(getDataDir(), 'strategies');
  const map = new Map<string, CacheEntry>();

  if (!fs.existsSync(dir)) {
    cache = map;
    return;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.system.md'));
  for (const file of files) {
    const name = file.replace('.system.md', '');
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      const strategy = parseStrategyFile(name, content);

      // 检查是否有对应的 .params.md 文件
      const paramsFilePath = path.join(dir, `${name}.params.md`);
      let paramsMtime: number | undefined;
      let paramsContent: string | undefined;
      if (fs.existsSync(paramsFilePath)) {
        try {
          paramsContent = fs.readFileSync(paramsFilePath, 'utf-8');
          const paramsStat = fs.statSync(paramsFilePath);
          const paramsFromFile = parseParams(paramsContent);
          Object.assign(strategy.params, paramsFromFile);
          paramsMtime = paramsStat.mtimeMs;
        } catch {
          log.error(`参数文件解析失败: ${name}.params.md`);
        }
      }

      // 检查是否有对应的 .user.md 文件（User Prompt 模板）
      const userPromptFilePath = path.join(dir, `${name}.user.md`);
      let userPromptMtime: number | undefined;
      let userPromptContent: string | undefined;
      if (fs.existsSync(userPromptFilePath)) {
        try {
          userPromptContent = fs.readFileSync(userPromptFilePath, 'utf-8');
          const userStat = fs.statSync(userPromptFilePath);
          strategy.userPrompt = userPromptContent.trim() || null;
          userPromptMtime = userStat.mtimeMs;
        } catch {
          log.error(`User Prompt 文件解析失败: ${name}.user.md`);
        }
      }

      map.set(name, {
        strategy,
        mtime: stat.mtimeMs,
        filePath,
        paramsFilePath: fs.existsSync(paramsFilePath) ? paramsFilePath : undefined,
        paramsMtime,
        paramsContent,
        userPromptFilePath: fs.existsSync(userPromptFilePath) ? userPromptFilePath : undefined,
        userPromptMtime,
        userPromptContent,
      });
    } catch {
      // 解析失败不影响系统运行，跳过该策略
      log.error(`策略文件解析失败: ${file}`);
    }
  }

  cache = map;
  lastMtimeCheck = Date.now();
}

/**
 * 获取已解析的策略（带 mtime 失效检查）
 */
export function getStrategy(name: string): ParsedStrategy | null {
  if (!cache) loadStrategies();
  checkMtimeInvalidation();
  return cache!.get(name)?.strategy ?? null;
}

/**
 * 获取策略参数值，不存在时返回 fallback
 */
export function getParam<T extends number | string | boolean>(
  strategyName: string,
  paramName: string,
  fallback: T,
): T {
  const strategy = getStrategy(strategyName);
  if (!strategy) return fallback;
  const value = strategy.params[paramName];
  if (value === undefined) return fallback;
  // 类型一致性检查
  if (typeof value !== typeof fallback) return fallback;
  return value as T;
}

/**
 * 获取策略的 System Prompt，不存在时返回 fallback
 */
export function getPrompt(strategyName: string, fallback: string): string {
  const strategy = getStrategy(strategyName);
  return strategy?.systemPrompt ?? fallback;
}

/**
 * 获取策略的 User Prompt 模板，不存在时返回 fallback
 */
export function getUserPrompt(strategyName: string, fallback: string): string {
  const strategy = getStrategy(strategyName);
  return strategy?.userPrompt ?? fallback;
}

/**
 * 渲染 User Prompt 模板，将 {{变量名}} 替换为实际值
 * 未提供的变量保留原占位符
 */
export function renderUserPrompt(
  strategyName: string,
  variables: Record<string, string>,
  fallback: string,
): string {
  const template = getUserPrompt(strategyName, fallback);
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}

/**
 * 重新加载所有策略（热重载）
 */
export function reloadStrategies(): void {
  cache = null;
  loadStrategies();
}

/**
 * 获取所有已加载策略的名称列表
 */
export function getStrategyNames(): string[] {
  if (!cache) loadStrategies();
  return [...cache!.keys()];
}

/**
 * 从策略文件获取 LLM 调用选项（模型档位 + thinking 配置）
 *
 * 策略文件中通过以下参数控制：
 * - llm_tier: light / standard / heavy（默认 standard）
 * - thinking: true / false（默认 false）
 * - thinking_budget: number（默认 0）
 */
export function getLLMOptions(strategyName: string): {
  model: 'light' | 'standard' | 'heavy';
  thinking?: { budget: number };
} {
  const tier = getParam(strategyName, 'llm_tier', 'standard') as string;
  const thinkingEnabled = getParam(strategyName, 'thinking', false);
  const budget = getParam(strategyName, 'thinking_budget', 0) as number;

  const validTiers = ['light', 'standard', 'heavy'] as const;
  const model = validTiers.includes(tier as 'light' | 'standard' | 'heavy') ? (tier as 'light' | 'standard' | 'heavy') : 'standard';

  return {
    model,
    ...(thinkingEnabled && budget > 0 ? { thinking: { budget } } : {}),
  };
}

// --- Skill 和 MCP 描述文件监控 ---

interface FileWatchEntry {
  filePath: string;
  strategyName: string;
  mtime: number;
  content: string;
}

let watchedFiles: FileWatchEntry[] = [];
let lastWatchCheck = 0;
const WATCH_CHECK_INTERVAL = 5000;

/**
 * 初始化 Skill 和 MCP 描述文件的变更监控
 */
export function initFileWatchers(dataDir: string): void {
  watchedFiles = [];

  // 监控 skill 文件
  const skillDir = path.join(dataDir, 'skill');
  if (fs.existsSync(skillDir)) {
    for (const file of fs.readdirSync(skillDir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(skillDir, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        watchedFiles.push({
          filePath,
          strategyName: `skill:${file.replace('.md', '')}`,
          mtime: stat.mtimeMs,
          content,
        });
      } catch { /* */ }
    }
  }

  // 监控 MCP 描述文件
  const mcpDescPath = path.join(dataDir, 'mcp-descriptions.json');
  if (fs.existsSync(mcpDescPath)) {
    try {
      const stat = fs.statSync(mcpDescPath);
      const content = fs.readFileSync(mcpDescPath, 'utf-8');
      watchedFiles.push({
        filePath: mcpDescPath,
        strategyName: 'mcp-descriptions',
        mtime: stat.mtimeMs,
        content,
      });
    } catch { /* */ }
  }

  lastWatchCheck = Date.now();
}

/**
 * 检查 Skill 和 MCP 描述文件是否有变更（由 daemon 定期调用）
 */
export function checkFileWatchers(): void {
  const now = Date.now();
  if (now - lastWatchCheck < WATCH_CHECK_INTERVAL) return;
  lastWatchCheck = now;

  for (const entry of watchedFiles) {
    try {
      const stat = fs.statSync(entry.filePath);
      if (stat.mtimeMs === entry.mtime) continue;

      const newContent = fs.readFileSync(entry.filePath, 'utf-8');
      if (newContent === entry.content) {
        entry.mtime = stat.mtimeMs;
        continue;
      }

      // MCP 描述文件特殊处理：按工具名分别记录版本
      if (entry.strategyName === 'mcp-descriptions') {
        try {
          const oldDescs = JSON.parse(entry.content) as Record<string, string>;
          const newDescs = JSON.parse(newContent) as Record<string, string>;
          for (const [tool, desc] of Object.entries(newDescs)) {
            if (desc !== oldDescs[tool]) {
              recordFileChangeVersion(`mcp-desc:${tool}`, desc);
            }
          }
        } catch {
          recordFileChangeVersion(entry.strategyName, newContent);
        }
      } else {
        recordFileChangeVersion(entry.strategyName, newContent);
      }

      entry.mtime = stat.mtimeMs;
      entry.content = newContent;
    } catch {
      // 文件被删除等异常，静默跳过
    }
  }

  // 检查新增的 skill 文件
  const dataDir = getDataDir();
  const skillDir = path.join(dataDir, 'skill');
  if (fs.existsSync(skillDir)) {
    const trackedPaths = new Set(watchedFiles.map(e => e.filePath));
    for (const file of fs.readdirSync(skillDir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(skillDir, file);
      if (trackedPaths.has(filePath)) continue;
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        watchedFiles.push({
          filePath,
          strategyName: `skill:${file.replace('.md', '')}`,
          mtime: stat.mtimeMs,
          content,
        });
      } catch { /* */ }
    }
  }
}
