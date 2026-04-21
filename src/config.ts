import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { parse as parseToml } from 'smol-toml';
import Database from 'better-sqlite3';
import type { AppConfig } from './types.js';
import { loadStrategies, initFileWatchers } from './strategy/loader.js';
import { syncSkillFiles, createSyncHashStoreFromDb } from './utils/sync-skill-files.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('config');

/**
 * 运行时校验关键配置字段。不用 Zod 避免依赖——手动检查足够。
 * 在 deepMerge 后调用，确保合并后的配置是合理的。
 */
function validateConfig(config: AppConfig): void {
  // gates 必须为正数
  for (const [key, val] of Object.entries(config.gates)) {
    if (typeof val !== 'number' || val < 0) {
      throw new Error(`config.gates.${key} 必须为非负数，当前值: ${val}`);
    }
  }
  // metabolism 必须为正数
  for (const [key, val] of Object.entries(config.metabolism)) {
    if (typeof val !== 'number' || val <= 0) {
      throw new Error(`config.metabolism.${key} 必须为正数，当前值: ${val}`);
    }
  }
  // embedding dimensions 必须为正整数
  if (!Number.isInteger(config.embedding.dimensions) || config.embedding.dimensions <= 0) {
    throw new Error(`config.embedding.dimensions 必须为正整数，当前值: ${config.embedding.dimensions}`);
  }
}

const DEFAULT_CONFIG: AppConfig = {
  general: {
    data_dir: path.join(os.homedir(), '.tidemind'),
    user_name: os.userInfo().username,
  },
  // 服务连接
  anthropic: {
    api_key: process.env.ANTHROPIC_API_KEY ?? '',
  },
  vertex: {
    project_id: '',
    region: 'us-central1',
  },
  ollama: {
    url: 'http://localhost:11434',
  },
  gemini: {
    api_key: '',
  },
  // 功能用途
  llm: {
    provider: 'anthropic' as const,
    light_model: 'claude-haiku-4-5',
    standard_model: 'claude-sonnet-4-6',
    heavy_model: 'claude-opus-4-6',
  },
  embedding: {
    provider: 'vertex' as const,
    model: 'gemini-embedding-001',
    dimensions: 3072,
  },
  /** @deprecated 搜索权重已迁移到 data/strategies/recall-rank.md，此处仅保留向后兼容 */
  search: {
    alpha: 0.3,
    beta: 0.5,
    gamma: 0.1,
    delta: 0.1,
  },
  gates: {
    vector_search: 50,
    graph_expansion: 100,
    graph_expansion_links: 50,
    crystal_generation: 200,
    divergent_scan: 500,
    learning_2_min_nodes: 500,
    learning_2_min_recall_ops: 200,
  },
  metabolism: {
    annotate_interval_minutes: 3,
    daily_check_hours: 24,
    weekly_check_days: 7,
  },
  // cloud.server_url: 客户端连接云服务器的地址。
  // 对应服务端 pro/cloud-server/src/config.ts 中的 baseUrl（从 BASE_URL 环境变量加载）。
  // 两者应指向同一个域名，只是读取方式不同：客户端从 config.toml，服务端从环境变量。
  cloud: {
    enabled: false,
    sync_enabled: false,
    // 本地/云代谢互斥开关。true 时本地 scheduler 跳过所有任务,服务端代谢接管。
    metabolism_enabled: false,
    server_url: 'https://cloud.tidemind.ai',
  },
};

let cachedConfig: AppConfig | null = null;

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath?: string): AppConfig {
  if (cachedConfig) return cachedConfig;

  let userConfig: Record<string, unknown> = {};
  const configFile = configPath ?? path.join(DEFAULT_CONFIG.general.data_dir, 'config.toml');

  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, 'utf-8');
    userConfig = parseToml(raw) as Record<string, unknown>;
  }

  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, userConfig) as unknown as AppConfig;

  // 校验关键配置
  validateConfig(merged);

  // 展开 ~ 为 home 目录
  if (merged.general.data_dir.startsWith('~')) {
    merged.general.data_dir = merged.general.data_dir.replace('~', os.homedir());
  }

  // 环境变量覆盖
  if (process.env.ANTHROPIC_API_KEY && !merged.anthropic.api_key) {
    merged.anthropic.api_key = process.env.ANTHROPIC_API_KEY;
  }

  cachedConfig = merged;
  return merged;
}

export function getConfig(): AppConfig {
  return loadConfig();
}

/** 清除 config 缓存，下次 getConfig() 会重新读取 TOML 文件 */
export function reloadConfig(): void {
  cachedConfig = null;
}

export function getDataDir(): string {
  return getConfig().general.data_dir;
}

/**
 * 判断 LLM 是否已配置（根据当前 provider 检查对应凭证）
 */
export function isLlmConfigured(): boolean {
  const config = getConfig();

  // 新路径：有 connection_id 说明已通过 UI 配置过
  if (config.llm.standard_connection || config.llm.light_connection || config.llm.heavy_connection) {
    return true;
  }

  // 旧路径：按 provider 检查凭证
  if (config.llm.provider === 'vertex') {
    // Vertex 需要凭证文件 + project_id（凭证文件中可含 project_id）
    const credPath = path.join(getDataDir(), 'vertex-credentials.json');
    if (!fs.existsSync(credPath)) return false;
    if (config.vertex.project_id) return true;
    // 尝试从凭证文件读 project_id
    try {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      return !!cred.project_id;
    } catch {
      return false;
    }
  }
  if (config.llm.provider === 'gemini') {
    return !!config.gemini.api_key;
  }
  if (config.llm.provider === 'ollama') {
    return !!config.ollama.url;
  }
  if (config.llm.provider === 'openai-compatible') {
    // openai-compatible 通过 connection 配置，走不到这里
    // 但如果手动编辑 config.toml 也能用
    return true;
  }
  // Anthropic 直连需要 api_key
  return !!config.anthropic.api_key;
}

export function ensureDataDirs(): void {
  const dataDir = getDataDir();
  const dirs = [
    dataDir,
    path.join(dataDir, 'stream'),
    path.join(dataDir, 'graph'),
    path.join(dataDir, 'crystal'),
    path.join(dataDir, 'strategies'),
    path.join(dataDir, 'skill'),
    path.join(dataDir, 'exports'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 首次运行：复制默认策略和 Skill 文件
  copyDefaultFiles(dataDir);

  // 加载策略文件到内存
  loadStrategies(path.join(dataDir, 'strategies'));

  // 初始化 Skill 和 MCP 描述文件的变更监控
  initFileWatchers(dataDir);
}

/**
 * 查找项目 data/ 目录的位置
 */
function findSourceDataDir(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'data'),           // 从 dist/ 运行时
    path.join(__dirname, '..', '..', 'data'),     // 其他情况
    ...('resourcesPath' in process ? [path.join((process as unknown as { resourcesPath: string }).resourcesPath, 'data')] : []),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 如果目标目录为空，从项目 data/ 目录复制默认文件
 */
function copyDefaultFiles(dataDir: string): void {
  const sourceDir = findSourceDataDir();
  if (!sourceDir) return;

  // 复制策略文件（首次）+ 同步缺失参数（每次）
  const strategiesDir = path.join(dataDir, 'strategies');
  const sourceStrategies = path.join(sourceDir, 'strategies');
  if (fs.existsSync(sourceStrategies)) {
    const existingFiles = fs.readdirSync(strategiesDir);
    if (existingFiles.length === 0) {
      // 首次运行：全量复制
      for (const file of fs.readdirSync(sourceStrategies)) {
        fs.copyFileSync(path.join(sourceStrategies, file), path.join(strategiesDir, file));
      }
    } else {
      // 非首次：补全缺失的策略文件 + 同步缺失参数
      syncStrategyParams(sourceStrategies, strategiesDir);
    }
  }

  // 同步 Skill 文件：hash-based 同步 + 旧品牌过渡清理。
  // 详见 src/utils/sync-skill-files.ts。
  // DB 可能还没建（首次运行），此时 hashStore 为 undefined，会退化为 legacy marker 检测。
  const skillDir = path.join(dataDir, 'skill');
  const sourceSkill = path.join(sourceDir, 'skill');
  let skillDb: Database.Database | null = null;
  let hashStore: ReturnType<typeof createSyncHashStoreFromDb> | undefined;
  try {
    const dbPath = path.join(dataDir, 'graph', 'brain.sqlite');
    if (fs.existsSync(dbPath)) {
      skillDb = new Database(dbPath);
      skillDb.pragma('journal_mode = WAL');
      skillDb.pragma('busy_timeout = 5000');
      // createSyncHashStoreFromDb 会执行 CREATE TABLE IF NOT EXISTS，
      // 必须在同一个 try 里以便表创建/prepare 失败时能整体降级
      hashStore = createSyncHashStoreFromDb(skillDb);
    }
  } catch {
    // DB 不可用或建表/prepare 失败 → 降级为 legacy marker 模式
    if (skillDb) { try { skillDb.close(); } catch { /* ignore */ } }
    skillDb = null;
    hashStore = undefined;
  }
  syncSkillFiles(sourceSkill, skillDir, { hashStore });
  if (skillDb) {
    try { skillDb.close(); } catch { /* ignore */ }
  }
}

/**
 * 同步策略文件：
 * 1. 源码有但运行时没有的文件 → 复制
 * 2. 两边都有的文件 → 把源码中有但运行时缺失的参数追加到运行时文件的参数表末尾
 *
 * 不会覆盖用户已修改的参数值或 prompt 内容。
 */
function fileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function syncStrategyParams(sourceDir: string, targetDir: string): void {
  // 打开 DB 获取/写入 sync_hashes（尽力而为）
  let db: Database.Database | null = null;
  try {
    const dbPath = path.join(getDataDir(), 'graph', 'brain.sqlite');
    if (fs.existsSync(dbPath)) {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec('CREATE TABLE IF NOT EXISTS sync_hashes (file_name TEXT PRIMARY KEY, source_hash TEXT NOT NULL, synced_at TEXT NOT NULL)');
    }
  } catch (err) { log.debug('sync_hashes DB 初始化失败，退化为全量覆盖', err); }

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.md')) continue;
    const targetPath = path.join(targetDir, file);
    const sourcePath = path.join(sourceDir, file);
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceHash = fileHash(sourceContent);

    if (!fs.existsSync(targetPath)) {
      // 新策略文件，直接复制
      fs.copyFileSync(sourcePath, targetPath);
      if (db) {
        try { db.prepare('INSERT OR REPLACE INTO sync_hashes (file_name, source_hash, synced_at) VALUES (?, ?, datetime(\'now\'))').run(file, sourceHash); } catch (err) { log.debug('写入 sync_hashes 失败', err); }
      }
      continue;
    }

    // 哈希比较：源码内容变了 → 覆盖运行时文件
    let needsOverwrite = false;
    if (db) {
      try {
        const row = db.prepare('SELECT source_hash FROM sync_hashes WHERE file_name = ?').get(file) as { source_hash: string } | undefined;
        needsOverwrite = !row || row.source_hash !== sourceHash;
      } catch (err) { log.debug('读取 sync_hashes 失败', err); needsOverwrite = true; }
    } else {
      // DB 不可用时，比较文件内容判断是否需要覆盖
      const targetContent = fs.readFileSync(targetPath, 'utf-8');
      needsOverwrite = sourceContent !== targetContent;
    }

    if (needsOverwrite) {
      fs.copyFileSync(sourcePath, targetPath);
      // 记录升级到 strategy_versions 表
      try {
        const strategyName = file.replace('.md', '');
        recordStrategyUpgrade(strategyName, sourceContent);
      } catch (err) { log.debug('记录策略版本失败', err); }
      // 更新 sync hash
      if (db) {
        try { db.prepare('INSERT OR REPLACE INTO sync_hashes (file_name, source_hash, synced_at) VALUES (?, ?, datetime(\'now\'))').run(file, sourceHash); } catch (err) { log.debug('更新 sync_hashes 失败', err); }
      }
      continue;
    }

    // 源码未变：只补缺失参数
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const sourceParams = parseMarkdownParams(sourceContent);
    const targetParams = parseMarkdownParams(targetContent);

    const missing: Array<{ key: string; line: string }> = [];
    for (const [key, line] of Object.entries(sourceParams)) {
      if (!(key in targetParams)) {
        missing.push({ key, line });
      }
    }

    if (missing.length === 0) continue;

    // 找到最后一个参数行的位置，在其后追加
    const lines = targetContent.split('\n');
    let lastParamLineIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('|') && !lines[i].match(/^\|\s*-+/) && !lines[i].match(/^\|\s*参数/)) {
        lastParamLineIdx = i;
        break;
      }
      if (lines[i].match(/^\s*-\s+[\w_]+\s*:/)) {
        lastParamLineIdx = i;
        break;
      }
    }

    if (lastParamLineIdx >= 0) {
      const insertLines = missing.map(m => m.line);
      lines.splice(lastParamLineIdx + 1, 0, ...insertLines);
      fs.writeFileSync(targetPath, lines.join('\n'));
    }
  }

  if (db) try { (db as { close(): void }).close(); } catch (err) { log.debug('关闭 sync_hashes DB 失败', err); }
}

/**
 * 记录策略文件版本升级到 DB（尽力而为，DB 不可用时静默跳过）
 */
function recordStrategyUpgrade(strategyName: string, content: string): void {
  let db: Database.Database | null = null;
  try {
    const dbPath = path.join(getDataDir(), 'graph', 'brain.sqlite');
    if (!fs.existsSync(dbPath)) return;
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_versions'"
    ).get();
    if (!tableExists) return;
    const maxVersion = (db.prepare(
      'SELECT MAX(version) as v FROM strategy_versions WHERE strategy_name = ?'
    ).get(strategyName) as { v: number | null })?.v ?? 0;
    db.prepare(
      'INSERT INTO strategy_versions (strategy_name, version, content, change_reason, changed_by, created) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
    ).run(strategyName, maxVersion + 1, content, '源码同步更新', 'system');
  } catch (err) { log.debug('recordStrategyUpgrade DB 操作失败', err); } finally {
    if (db) try { db.close(); } catch (err) { log.debug('关闭 strategy_versions DB 失败', err); }
  }
}

/**
 * 定期从源码目录同步策略文件到运行时目录。
 * daemon tick 中调用，无需重启即可让源码变更生效。
 */
export function syncStrategiesFromSource(): void {
  const sourceDir = findSourceDataDir();
  if (!sourceDir) return;
  const dataDir = getDataDir();
  const strategiesDir = path.join(dataDir, 'strategies');
  const sourceStrategies = path.join(sourceDir, 'strategies');
  if (!fs.existsSync(sourceStrategies) || !fs.existsSync(strategiesDir)) return;
  // 运行时目录为空说明还没初始化过，应走 ensureDataDirs
  if (fs.readdirSync(strategiesDir).length === 0) return;
  syncStrategyParams(sourceStrategies, strategiesDir);
}

/**
 * 补填 sync_hashes：ensureDataDirs 时 DB 可能还不存在，
 * daemon 在 getDb() 之后调用此函数补填已同步文件的哈希。
 */
export function backfillSyncHashes(): void {
  try {
    const dbPath = path.join(getDataDir(), 'graph', 'brain.sqlite');
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS sync_hashes (file_name TEXT PRIMARY KEY, source_hash TEXT NOT NULL, synced_at TEXT NOT NULL)');

    const existing = (db.prepare('SELECT count(*) as c FROM sync_hashes').get() as { c: number }).c;
    if (existing > 0) { db.close(); return; }

    const sourceDir = findSourceDataDir();
    if (!sourceDir) { db.close(); return; }
    const sourceStrategies = path.join(sourceDir, 'strategies');
    if (!fs.existsSync(sourceStrategies)) { db.close(); return; }

    const insert = db.prepare('INSERT OR REPLACE INTO sync_hashes (file_name, source_hash, synced_at) VALUES (?, ?, datetime(\'now\'))');
    const tx = db.transaction(() => {
      for (const file of fs.readdirSync(sourceStrategies).filter(f => f.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(sourceStrategies, file), 'utf-8');
        insert.run(file, fileHash(content));
      }
    });
    tx();
    db.close();
  } catch { /* 静默 */ }
}

/**
 * 从 markdown 参数表中提取 { key: 完整行 } 映射
 */
function parseMarkdownParams(content: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of content.split('\n')) {
    // 格式 1: 表格 | key | value | description |
    if (line.startsWith('|') && !line.match(/^\|\s*-+/) && !line.match(/^\|\s*参数/)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2 && cells[0] !== 'param' && cells[0] !== 'key') {
        params[cells[0]] = line;
      }
    }
    // 格式 2: 列表 - key: value
    else if (line.match(/^\s*-\s+\w[\w_]*\s*:/)) {
      const m = line.match(/^\s*-\s+([\w_]+)\s*:\s*(.+)$/);
      if (m) {
        params[m[1]] = line;
      }
    }
  }
  return params;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
