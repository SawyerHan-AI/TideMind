import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { createLogger } from '../utils/logger.js';
import {
  addColumnIfMissing,
  execIgnoringDuplicateColumn,
  execIgnoringErrors,
  tableHasColumn,
} from './migration-helpers.js';

const log = createLogger('schema');

function generateSourceId(): string {
  return 'ns_' + crypto.randomBytes(4).toString('hex');
}

/**
 * 当前 schema 版本。每次新增 migration 时递增。
 */
const CURRENT_SCHEMA_VERSION = 22;

/**
 * 完整建表 SQL — 包含所有字段，新数据库直接创建最新结构。
 */
const SCHEMA_SQL = `
-- 节点表
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('fact','context','preference','idea','crystal','meta')),
    content TEXT NOT NULL,
    title TEXT,

    -- 四维成熟度
    heat REAL DEFAULT 1.0,
    refinement REAL DEFAULT 0.0,
    connectivity REAL DEFAULT 0.0,
    independence REAL DEFAULT 0.0,

    -- 三维内容性质
    specificity REAL DEFAULT 0.5,
    subjectivity REAL DEFAULT 0.5,
    actuality REAL DEFAULT 0.5,

    -- 结构角色 flags
    is_crystal INTEGER DEFAULT 0,
    is_tag INTEGER DEFAULT 0,
    is_meta INTEGER DEFAULT 0,

    -- 来源追溯
    source_tool TEXT,
    source_session TEXT,
    source_stream TEXT,
    source_timestamp TEXT,

    -- 上下文
    tags TEXT,

    -- 生命周期
    created TEXT NOT NULL,
    last_reconsolidated TEXT,
    version INTEGER DEFAULT 1,
    archived INTEGER DEFAULT 0,
    is_keystone INTEGER DEFAULT 0,
    is_superseded INTEGER DEFAULT 0,

    -- 来源设备（云同步用）
    source_device TEXT DEFAULT 'local',

    -- 汇总分
    maturity_score REAL DEFAULT 0.0,

    -- Reconcile LWW 用(和 created 一样是 TEXT ISO 字符串,migration 对齐 v15)
    updated TEXT
);

-- 链接表（relation 存储为 JSON 数组 [{type, confidence}]）
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    note TEXT,
    auto INTEGER DEFAULT 1,
    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending','rejected_by_user')),
    created TEXT NOT NULL,
    updated TEXT
);

-- 节点版本历史
CREATE TABLE IF NOT EXISTS node_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    change_reason TEXT,
    changed_at TEXT NOT NULL
);

-- MCP 操作日志
CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    input_summary TEXT,
    context TEXT,
    output_node_ids TEXT,
    tool TEXT,
    session TEXT,
    agent_id TEXT,
    created TEXT NOT NULL
);

-- 策略评估数据
CREATE TABLE IF NOT EXISTS strategy_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_name TEXT NOT NULL,
    operation_id INTEGER REFERENCES operation_log(id),
    node_id TEXT REFERENCES nodes(id),
    was_used INTEGER,
    feedback_signal REAL,
    created TEXT NOT NULL
);

-- 策略版本历史
CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    change_reason TEXT,
    changed_by TEXT DEFAULT 'user',
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_name ON strategy_versions(strategy_name);

-- 源码→运行时同步哈希（替代文件内 > 版本: N 机制）
CREATE TABLE IF NOT EXISTS sync_hashes (
    file_name TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    synced_at TEXT NOT NULL
);

-- 系统元数据（维护时间戳、schema 版本等）
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 图遍历索引
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_archived ON nodes(archived);
CREATE INDEX IF NOT EXISTS idx_nodes_heat ON nodes(heat);
CREATE INDEX IF NOT EXISTS idx_nodes_keystone ON nodes(is_keystone);
CREATE INDEX IF NOT EXISTS idx_nodes_is_crystal ON nodes(is_crystal);
CREATE INDEX IF NOT EXISTS idx_nodes_is_tag ON nodes(is_tag);
CREATE INDEX IF NOT EXISTS idx_nodes_is_meta ON nodes(is_meta);

-- 复合索引(perf-optimization-2026-05-17 P1-1):
-- 多数 stats / nodes.list 查询过滤组合是 (archived, is_superseded, heat) 或
-- (archived, is_superseded, updated)。单列索引下走全表扫,加复合索引让查询
-- 走覆盖扫描。
CREATE INDEX IF NOT EXISTS idx_nodes_active_heat ON nodes(archived, is_superseded, heat DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_active_updated ON nodes(archived, is_superseded, updated DESC);

-- 标签使用聚合表(perf-optimization-2026-05-17 P1-2):
-- 用于 stats:dashboard / stats:overview / nodes:tags 三个 handler,避免每次
-- SELECT tags FROM nodes WHERE heat > 0.01 + JS 端 JSON.parse 全表聚合
-- (万节点下 500-1000ms)。trigger 实时维护,启动期 rebuildTagUsage 兜底重算。
CREATE TABLE IF NOT EXISTS tag_usage (
    tag TEXT PRIMARY KEY,
    node_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_usage_count ON tag_usage(node_count DESC);

-- 结构洞缓存(perf-optimization-2026-05-17 P2-1):单行表 id=1,
-- daemon 后台 5 分钟跑一次预计算 + 写缓存,IPC handler 直接读。
CREATE TABLE IF NOT EXISTS structure_holes_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    computed_at TEXT NOT NULL
);

-- tag_usage trigger:节点 INSERT / UPDATE(tags|archived|is_superseded)/ DELETE
-- 时增量维护计数。active 定义:archived=0 AND is_superseded=0。
-- 注意 trigger 是行级,OLD/NEW 是当前行的旧/新值;json_each 拆 tags 数组。
-- 防御:历史数据/手工 SQL 可能在 tags 列写入非法 JSON(空字符串、损坏 JSON、
-- 单个字符串非数组)。json_each 直接对非法 JSON 抛 "malformed JSON" 错让
-- 整 UPDATE 失败。统一在 trigger 内用 json_valid() 过滤无效 JSON,治死回退到 '[]'。
CREATE TRIGGER IF NOT EXISTS trg_tag_usage_after_insert
AFTER INSERT ON nodes
WHEN NEW.tags IS NOT NULL
  AND COALESCE(NEW.archived, 0) = 0
  AND COALESCE(NEW.is_superseded, 0) = 0
BEGIN
    INSERT INTO tag_usage(tag, node_count, last_updated)
    SELECT value, 1, datetime('now')
    FROM json_each(CASE WHEN json_valid(NEW.tags) = 1 THEN NEW.tags ELSE '[]' END)
    WHERE typeof(value) = 'text' AND length(value) > 0
    ON CONFLICT(tag) DO UPDATE SET
        node_count = node_count + 1,
        last_updated = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_tag_usage_after_delete
AFTER DELETE ON nodes
WHEN OLD.tags IS NOT NULL
  AND COALESCE(OLD.archived, 0) = 0
  AND COALESCE(OLD.is_superseded, 0) = 0
BEGIN
    UPDATE tag_usage SET
        node_count = node_count - 1,
        last_updated = datetime('now')
    WHERE tag IN (
        SELECT value FROM json_each(CASE WHEN json_valid(OLD.tags) = 1 THEN OLD.tags ELSE '[]' END) WHERE typeof(value) = 'text'
    );
    DELETE FROM tag_usage WHERE node_count <= 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_tag_usage_after_update
AFTER UPDATE OF tags, archived, is_superseded ON nodes
BEGIN
    -- 减去 OLD active 状态下 tags 的贡献
    UPDATE tag_usage SET
        node_count = node_count - 1,
        last_updated = datetime('now')
    WHERE COALESCE(OLD.archived, 0) = 0
      AND COALESCE(OLD.is_superseded, 0) = 0
      AND tag IN (
          SELECT value FROM json_each(CASE WHEN json_valid(COALESCE(OLD.tags, '[]')) = 1 THEN COALESCE(OLD.tags, '[]') ELSE '[]' END)
          WHERE typeof(value) = 'text'
      );
    -- 加上 NEW active 状态下 tags 的贡献
    INSERT INTO tag_usage(tag, node_count, last_updated)
    SELECT value, 1, datetime('now')
    FROM json_each(CASE WHEN json_valid(COALESCE(NEW.tags, '[]')) = 1 THEN COALESCE(NEW.tags, '[]') ELSE '[]' END)
    WHERE typeof(value) = 'text'
      AND length(value) > 0
      AND COALESCE(NEW.archived, 0) = 0
      AND COALESCE(NEW.is_superseded, 0) = 0
    ON CONFLICT(tag) DO UPDATE SET
        node_count = node_count + 1,
        last_updated = datetime('now');
    -- 清理零/负计数
    DELETE FROM tag_usage WHERE node_count <= 0;
END;

-- heat 字段语义守卫(2026-05-19):字段语义统一为 [0,1],trigger 在 INSERT/UPDATE
-- 时把越界值钳回 [0,1]。SQLite ALTER TABLE 不支持 ADD CHECK,只能用 trigger;
-- 行为是"修正"而非"拒绝",防止历史/新增 bug 写入 >1.0 让所有下游计算错位。
-- maturity_score 在被钳前的 heat 上计算,所以一并把它重算(用钳后的 heat)。
CREATE TRIGGER IF NOT EXISTS trg_nodes_heat_clamp_insert
AFTER INSERT ON nodes
WHEN NEW.heat < 0 OR NEW.heat > 1
BEGIN
    UPDATE nodes SET heat = MAX(0, MIN(1, NEW.heat)) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_nodes_heat_clamp_update
AFTER UPDATE OF heat ON nodes
WHEN NEW.heat < 0 OR NEW.heat > 1
BEGIN
    UPDATE nodes SET heat = MAX(0, MIN(1, NEW.heat)) WHERE id = NEW.id;
END;

-- Agent 身份表
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tool_type TEXT NOT NULL,
    archived INTEGER DEFAULT 0,
    last_active TEXT,
    created TEXT NOT NULL
);

-- 笔记源表（多实例支持）
CREATE TABLE IF NOT EXISTS note_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tool_type TEXT NOT NULL,
    path TEXT NOT NULL,
    poll_interval INTEGER DEFAULT 60,
    archived INTEGER DEFAULT 0,
    initialized INTEGER DEFAULT 0,
    created TEXT NOT NULL,
    last_synced TEXT
);

-- LLM 用量日志
CREATE TABLE IF NOT EXISTS llm_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    operation TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    thinking_tokens INTEGER DEFAULT 0,
    estimated_cost REAL DEFAULT 0,
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage_log(created);
CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage_log(model);

-- 时间线事件表
CREATE TABLE IF NOT EXISTS timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    subtype TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    node_ids TEXT,
    important INTEGER DEFAULT 0,
    actor TEXT DEFAULT 'brain',
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline_events(created);
CREATE INDEX IF NOT EXISTS idx_timeline_type ON timeline_events(type);

-- 多段 embedding 支持
CREATE TABLE IF NOT EXISTS node_segments (
    segment_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    UNIQUE(node_id, segment_index)
);

-- Learning II 参数反馈信号
CREATE TABLE IF NOT EXISTS param_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_name TEXT NOT NULL,
    param_name TEXT,
    signal_type TEXT NOT NULL,
    signal_value REAL NOT NULL,
    context TEXT,
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_param_feedback_strategy ON param_feedback(strategy_name, created);

-- Learning II 参数调整记录
CREATE TABLE IF NOT EXISTS param_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_name TEXT NOT NULL,
    param_name TEXT NOT NULL,
    signal_type TEXT,
    old_value REAL NOT NULL,
    new_value REAL NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    pre_avg REAL,
    post_avg REAL,
    monitoring_start TEXT,
    monitoring_end TEXT,
    created TEXT NOT NULL
);

-- 模型连接表（多实例）
CREATE TABLE IF NOT EXISTS model_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    credentials TEXT NOT NULL DEFAULT '{}',
    status TEXT DEFAULT 'unconfigured',
    available_models TEXT,
    last_checked TEXT,
    archived INTEGER DEFAULT 0,
    created TEXT NOT NULL
);

-- Digest 重试队列
CREATE TABLE IF NOT EXISTS pending_digests (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created TEXT NOT NULL,
    next_retry_at TEXT NOT NULL,
    completed_at TEXT,
    processing_started_at TEXT  -- 进入 processing 时写入（stale recovery 用）
);
CREATE INDEX IF NOT EXISTS idx_pending_digests_status ON pending_digests(status, next_retry_at);
`;

const FTS_SQL = `
-- 全文搜索（FTS5 外部内容表）
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    title,
    content,
    tags,
    content=nodes,
    content_rowid=rowid
);
`;

const FTS_TRIGGERS_SQL = `
-- FTS 同步触发器
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, tags)
    VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;

-- 必须用 OF 子句限定到 FTS 索引的字段(title/content/tags),否则任何字段 UPDATE
-- 都重写 FTS:bumpHeat / synaptic 衰减 / refreshMaturityScore / archived 标记
-- 等高频 update 触发无意义的 delete+insert 双写,FTS 索引膨胀 + WAL 暴涨。
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF title, content, tags ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, tags)
    VALUES('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO nodes_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;
`;

// ── Migration 系统 ──────────────────────────────────────────────

type Migration = {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
};

/**
 * 从 config.toml 迁移旧的单实例笔记源配置到 note_sources 表。
 * 仅在 note_sources 表为空时执行（避免重复迁移）。
 */
function migrateLegacyNoteSources(db: Database.Database): void {
  // 检查是否已有数据（避免重复迁移）
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM note_sources').get() as { cnt: number }).cnt;
  if (count > 0) return;

  // 直接读 config.toml 文件（不依赖 config 模块，避免 ESM 循环依赖）
  const defaultDir = path.join(os.homedir(), '.tidemind');
  const configPath = path.join(defaultDir, 'config.toml');
  if (!fs.existsSync(configPath)) {
    log.info('迁移 v7: config.toml 不存在，跳过旧配置迁移');
    return;
  }

  let config: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn('迁移 v7: 解析 config.toml 失败:', (err as Error).message);
    return;
  }

  const sources = config.sources as Record<string, Record<string, unknown>> | undefined;
  if (!sources) return;

  const now = new Date().toISOString();
  const insertStmt = db.prepare(
    'INSERT INTO note_sources (id, name, tool_type, path, poll_interval, initialized, created) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );

  const tableExists = (name: string) => {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!row;
  };

  // 迁移 Logseq
  if (typeof sources.logseq?.path === 'string' && sources.logseq.path) {
    const id = generateSourceId();
    const rawInterval = sources.logseq.poll_interval;
    const pollInterval = typeof rawInterval === 'number' ? rawInterval : 60;
    insertStmt.run(id, 'Logseq', 'logseq', sources.logseq.path, pollInterval, now);
    if (tableExists('logseq_sync')) {
      db.prepare("UPDATE logseq_sync SET source_id = ? WHERE source_id = ''").run(id);
    }
    log.info(`迁移 v7: Logseq 笔记源已迁移 → ${id}`);
  } else if (sources.logseq?.path) {
    log.warn(`迁移 v7: Logseq path 非字符串,跳过 (type=${typeof sources.logseq.path})`);
  }

  // 迁移 Obsidian
  if (typeof sources.obsidian?.path === 'string' && sources.obsidian.path) {
    const id = generateSourceId();
    insertStmt.run(id, 'Obsidian', 'obsidian', sources.obsidian.path, 60, now);
    if (tableExists('obsidian_sync')) {
      db.prepare("UPDATE obsidian_sync SET source_id = ? WHERE source_id = ''").run(id);
    }
    log.info(`迁移 v7: Obsidian 笔记源已迁移 → ${id}`);
  } else if (sources.obsidian?.path) {
    log.warn(`迁移 v7: Obsidian path 非字符串,跳过 (type=${typeof sources.obsidian.path})`);
  }
}

/**
 * 从 config.toml 迁移旧的单实例模型服务配置到 model_connections 表。
 * 仅在 model_connections 表为空时执行。
 */
function migrateModelConnections(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM model_connections').get() as { cnt: number }).cnt;
  if (count > 0) return;

  const defaultDir = path.join(os.homedir(), '.tidemind');
  const configPath = path.join(defaultDir, 'config.toml');
  if (!fs.existsSync(configPath)) {
    log.info('迁移 v9: config.toml 不存在，跳过旧模型配置迁移');
    return;
  }

  let config: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn('迁移 v9: 解析 config.toml 失败:', (err as Error).message);
    return;
  }

  const nowStr = new Date().toISOString();
  const insertStmt = db.prepare(
    'INSERT INTO model_connections (id, name, provider_type, credentials, status, created) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const connectionIdMap: Record<string, string> = {}; // provider → connection_id

  // Anthropic
  const anthropic = config.anthropic as Record<string, unknown> | undefined;
  if (typeof anthropic?.api_key === 'string' && anthropic.api_key) {
    const id = 'mc_' + crypto.randomBytes(4).toString('hex');
    insertStmt.run(id, 'Anthropic', 'anthropic', JSON.stringify({ api_key: anthropic.api_key }), 'unconfigured', nowStr);
    connectionIdMap.anthropic = id;
    log.info(`迁移 v9: Anthropic 配置已迁移 → ${id}`);
  }

  // Vertex AI
  const vertex = config.vertex as Record<string, unknown> | undefined;
  if (typeof vertex?.project_id === 'string' && vertex.project_id) {
    const id = 'mc_' + crypto.randomBytes(4).toString('hex');
    const region = typeof vertex.region === 'string' ? vertex.region : 'us-central1';
    insertStmt.run(id, 'Vertex AI', 'vertex', JSON.stringify({ project_id: vertex.project_id, region }), 'unconfigured', nowStr);
    connectionIdMap.vertex = id;
    log.info(`迁移 v9: Vertex AI 配置已迁移 → ${id}`);
  }

  // Gemini
  const gemini = config.gemini as Record<string, unknown> | undefined;
  if (typeof gemini?.api_key === 'string' && gemini.api_key) {
    const id = 'mc_' + crypto.randomBytes(4).toString('hex');
    insertStmt.run(id, 'Gemini API', 'gemini', JSON.stringify({ api_key: gemini.api_key }), 'unconfigured', nowStr);
    connectionIdMap.gemini = id;
    log.info(`迁移 v9: Gemini 配置已迁移 → ${id}`);
  }

  // Ollama
  const ollama = config.ollama as Record<string, unknown> | undefined;
  if (typeof ollama?.url === 'string' && ollama.url && ollama.url !== 'http://localhost:11434') {
    // 只迁移非默认配置的 Ollama
    const id = 'mc_' + crypto.randomBytes(4).toString('hex');
    insertStmt.run(id, 'Ollama', 'ollama', JSON.stringify({ url: ollama.url }), 'unconfigured', nowStr);
    connectionIdMap.ollama = id;
    log.info(`迁移 v9: Ollama 配置已迁移 → ${id}`);
  }

  // 更新 config.toml 中的 llm/embedding 段，把 provider 引用改为 connection_id
  if (Object.keys(connectionIdMap).length > 0) {
    try {
      const llm = config.llm as Record<string, unknown> | undefined;
      const embedding = config.embedding as Record<string, unknown> | undefined;

      if (llm) {
        const defaultProvider = (llm.provider as string) ?? 'anthropic';
        const lightProv = (llm.light_provider as string) ?? defaultProvider;
        const stdProv = (llm.standard_provider as string) ?? defaultProvider;
        const heavyProv = (llm.heavy_provider as string) ?? defaultProvider;

        if (connectionIdMap[lightProv]) llm.light_connection = connectionIdMap[lightProv];
        if (connectionIdMap[stdProv]) llm.standard_connection = connectionIdMap[stdProv];
        if (connectionIdMap[heavyProv]) llm.heavy_connection = connectionIdMap[heavyProv];
      }

      if (embedding) {
        const embProv = (embedding.provider as string) ?? 'vertex';
        if (connectionIdMap[embProv]) embedding.connection = connectionIdMap[embProv];
      }

      fs.writeFileSync(configPath, stringifyToml(config), 'utf-8');
      log.info('迁移 v9: config.toml 已更新 connection 引用');
    } catch (err) {
      // config.toml 更新失败不阻塞迁移
      log.warn('迁移 v9: 更新 config.toml 失败（不影响数据库迁移）:', (err as Error).message);
    }
  }
}

/**
 * 迁移列表。每个 migration 将 DB 从 version-1 升级到 version。
 *
 * 注意：这些迁移是为了升级已有数据库。新数据库通过 SCHEMA_SQL 直接创建最新结构，
 * 不需要走 migration 路径。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: '整合历史迁移：agent_id, refined, 节点维度化, actor, node_segments',
    up: (db) => {
      // 这些是之前用 try-catch 做的迁移，整合到 v1
      // 对于已有数据库，这些列可能已存在（仅忽略 "duplicate column" 错误）
      execIgnoringDuplicateColumn(db, 'ALTER TABLE operation_log ADD COLUMN agent_id TEXT');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE links ADD COLUMN refined INTEGER DEFAULT 0');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN specificity REAL DEFAULT 0.5');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN subjectivity REAL DEFAULT 0.5');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN actuality REAL DEFAULT 0.5');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN is_crystal INTEGER DEFAULT 0');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN is_tag INTEGER DEFAULT 0');
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN is_meta INTEGER DEFAULT 0');
      execIgnoringDuplicateColumn(db, "ALTER TABLE timeline_events ADD COLUMN actor TEXT DEFAULT 'brain'");

      // 回填结构角色 flags
      db.exec(`UPDATE nodes SET is_crystal = 1 WHERE type = 'crystal' AND is_crystal = 0`);
      db.exec(`UPDATE nodes SET is_meta = 1 WHERE type = 'meta' AND is_meta = 0`);
      try { db.exec(`UPDATE nodes SET is_tag = 1 WHERE type = 'tag' AND is_tag = 0`); } catch { /* type may not exist */ }

      // 回填维度
      db.exec(`UPDATE nodes SET specificity=0.5, subjectivity=0.1, actuality=0.9 WHERE type='fact' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);
      db.exec(`UPDATE nodes SET specificity=0.3, subjectivity=0.2, actuality=0.8 WHERE type='context' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);
      db.exec(`UPDATE nodes SET specificity=0.3, subjectivity=0.8, actuality=0.8 WHERE type='preference' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);
      db.exec(`UPDATE nodes SET specificity=0.5, subjectivity=0.5, actuality=0.2 WHERE type='idea' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);
      db.exec(`UPDATE nodes SET specificity=0.2, subjectivity=0.5, actuality=0.8 WHERE type='crystal' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);
      db.exec(`UPDATE nodes SET specificity=0.5, subjectivity=0.1, actuality=0.9 WHERE type='meta' AND specificity=0.5 AND subjectivity=0.5 AND actuality=0.5`);

      // 维度索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_crystal ON nodes(is_crystal)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_tag ON nodes(is_tag)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_meta ON nodes(is_meta)');

      // node_segments 表
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_segments (
          segment_id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          segment_index INTEGER NOT NULL,
          UNIQUE(node_id, segment_index)
        )
      `);
    },
  },
  {
    version: 2,
    description: 'llm_usage_log 新增 estimated_cost 列 + 历史数据回填',
    up: (db) => {
      execIgnoringDuplicateColumn(db, 'ALTER TABLE llm_usage_log ADD COLUMN estimated_cost REAL DEFAULT 0');

      // 回填历史数据的预估费用
      // 动态导入 pricing 会增加复杂度，这里用内联的简化定价表回填
      const pricingRules: Array<{ pattern: string; input: number; output: number; thinking: number }> = [
        { pattern: 'claude-opus-4-7',   input: 5.00,  output: 25.00, thinking: 25.00 },
        { pattern: 'claude-opus-4-6',   input: 5.00,  output: 25.00, thinking: 25.00 },
        { pattern: 'claude-opus-4-5',   input: 5.00,  output: 25.00, thinking: 25.00 },
        { pattern: 'claude-opus-4-1',   input: 15.00, output: 75.00, thinking: 75.00 },
        { pattern: 'claude-sonnet-4-6', input: 3.00,  output: 15.00, thinking: 15.00 },
        { pattern: 'claude-sonnet-4-5', input: 3.00,  output: 15.00, thinking: 15.00 },
        { pattern: 'claude-haiku-4-5',  input: 1.00,  output: 5.00,  thinking: 5.00 },
        { pattern: 'claude-3-5-sonnet', input: 3.00,  output: 15.00, thinking: 15.00 },
        { pattern: 'claude-3-5-haiku',  input: 0.80,  output: 4.00,  thinking: 4.00 },
        { pattern: 'claude-3-opus',     input: 15.00, output: 75.00, thinking: 75.00 },
        { pattern: 'claude-3-haiku',    input: 0.25,  output: 1.25,  thinking: 1.25 },
      ];
      for (const rule of pricingRules) {
        db.prepare(`
          UPDATE llm_usage_log SET estimated_cost = (
            input_tokens * ? + output_tokens * ? + thinking_tokens * ?
          ) / 1000000.0
          WHERE LOWER(model) LIKE ? AND estimated_cost = 0
        `).run(rule.input, rule.output, rule.thinking, `%${rule.pattern}%`);
      }
    },
  },
  {
    version: 3,
    description: '链接模型重设计：relation 改为 JSON 数组，移除 semtype/refined 列，关系类型映射',
    up: (db) => {
      // 1. 关系类型映射表
      const RELATION_MAP: Record<string, string | null> = {
        same_project: null,       // 删除（项目归属改为节点属性）
        reminds: 'analogous',     // 模糊类比 → analogous
        branches: 'part_of',     // 分支从属 → part_of
      };

      // 2. 重建 links 表（SQLite 不支持 DROP COLUMN）
      db.exec(`
        CREATE TABLE links_new (
          id TEXT PRIMARY KEY,
          from_id TEXT NOT NULL REFERENCES nodes(id),
          to_id TEXT NOT NULL REFERENCES nodes(id),
          relation TEXT NOT NULL,
          strength REAL DEFAULT 0.5,
          note TEXT,
          auto INTEGER DEFAULT 1,
          status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending')),
          created TEXT NOT NULL
        )
      `);

      // 3. 迁移数据：逐行转换 relation 为 JSON 格式
      const oldLinks = db.prepare('SELECT * FROM links').all() as Array<{
        id: string; from_id: string; to_id: string;
        relation: string; semtype: string | null;
        strength: number; note: string | null;
        auto: number; status: string; refined: number; created: string;
      }>;

      const insertStmt = db.prepare(`
        INSERT INTO links_new (id, from_id, to_id, relation, strength, note, auto, status, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const link of oldLinks) {
        const oldRelation = link.relation;

        // 映射旧关系类型
        if (oldRelation in RELATION_MAP) {
          const mapped = RELATION_MAP[oldRelation];
          if (mapped === null) continue; // same_project → 删除该链接
          // reminds/branches → 映射到新类型
          const jsonRelation = JSON.stringify([{ type: mapped, confidence: 0.7 }]);
          insertStmt.run(link.id, link.from_id, link.to_id, jsonRelation, link.strength, link.note, link.auto, link.status, link.created);
        } else {
          // 保留的关系类型，包装为 JSON 数组
          const jsonRelation = JSON.stringify([{ type: oldRelation, confidence: 0.7 }]);
          insertStmt.run(link.id, link.from_id, link.to_id, jsonRelation, link.strength, link.note, link.auto, link.status, link.created);
        }
      }

      // 4. 替换旧表
      db.exec('DROP TABLE links');
      db.exec('ALTER TABLE links_new RENAME TO links');

      // 5. 重建索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)');

      // 6. archived 节点 → heat 降低（不再使用 archived 字段）
      db.exec('UPDATE nodes SET heat = 0.02 WHERE archived = 1');

      log.info(`迁移 v3 完成: ${oldLinks.length} 条链接已转换`);
    },
  },
  {
    version: 4,
    description: 'Learning II 重设计：新增 param_feedback 和 param_adjustments 表',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS param_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_name TEXT NOT NULL,
            param_name TEXT,
            signal_type TEXT NOT NULL,
            signal_value REAL NOT NULL,
            context TEXT,
            created TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_param_feedback_strategy ON param_feedback(strategy_name, created);

        CREATE TABLE IF NOT EXISTS param_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_name TEXT NOT NULL,
            param_name TEXT NOT NULL,
            signal_type TEXT,
            old_value REAL NOT NULL,
            new_value REAL NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            pre_avg REAL,
            post_avg REAL,
            monitoring_start TEXT,
            monitoring_end TEXT,
            created TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    description: 'Digest 重试队列：新增 pending_digests 表',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_digests (
            id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL,
            input_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed')),
            error_message TEXT,
            retry_count INTEGER DEFAULT 0,
            created TEXT NOT NULL,
            next_retry_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_digests_status ON pending_digests(status, next_retry_at);
      `);
    },
  },
  {
    version: 6,
    description: '移除 project 字段：数据迁移到 tags，重建表和 FTS',
    up: (db) => {
      // 崩溃恢复 (2026-05-09): v6 因 PRAGMA foreign_keys=OFF 走非事务路径,
      // 先 DROP TABLE nodes 再 RENAME nodes_new。中途断电 / 进程被 kill 会
      // 留下 "nodes 不存在但 nodes_new 存在" 的半完成状态,setSchemaVersion
      // 没跑过 → 重启后 v6 重跑,但开头 SELECT id, project, tags FROM nodes
      // 直接抛 "no such table: nodes",数据库永远不可启动。
      // 这里在最开头检测此状态:若发现,直接 RENAME 回去再走完整流程
      // (nodes_new 已含正确 schema + 用户数据,RENAME 即等价于走完一次 v6)。
      const tableInfo = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('nodes', 'nodes_new')
      `).all() as Array<{ name: string }>;
      const tableNames = new Set(tableInfo.map(r => r.name));
      if (!tableNames.has('nodes') && tableNames.has('nodes_new')) {
        log.warn('迁移 v6: 检测到上次中断后的半完成状态(nodes 缺失,nodes_new 存在),恢复 RENAME');
        db.exec('ALTER TABLE nodes_new RENAME TO nodes');
        // 索引/触发器/FTS 由后续步骤的 IF NOT EXISTS 兜底,这里只补 RENAME。
        // 继续走完正常流程,后续 INSERT INTO nodes_new 因为 nodes_new 已不存在
        // 会跳过(下面会重建);但 project 列已被移除,所以前面的数据迁移要 skip。
      }

      // 1. 将 project 值迁移到 tags 数组(只在 nodes 仍含 project 列时跑)
      const projectColExists = (db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>)
        .some(c => c.name === 'project');
      const nodesWithProject = projectColExists
        ? (db.prepare(
            "SELECT id, project, tags FROM nodes WHERE project IS NOT NULL"
          ).all() as Array<{ id: string; project: string; tags: string | null }>)
        : [];

      const updateTags = db.prepare('UPDATE nodes SET tags = ? WHERE id = ?');
      for (const node of nodesWithProject) {
        let tags: string[] = [];
        if (node.tags) {
          try { tags = JSON.parse(node.tags); } catch { tags = []; }
        }
        if (!tags.includes(node.project)) {
          tags.push(node.project);
          updateTags.run(JSON.stringify(tags), node.id);
        }
      }
      log.info(`迁移 v6: ${nodesWithProject.length} 个节点的 project 值已迁移到 tags`);

      // 2. 重建 nodes 表(去掉 project 列)
      //
      // 临时关闭外键检查以允许 DROP TABLE(links 引用 nodes)。注意这整段
      // 不能放在事务里(PRAGMA foreign_keys 在事务中无效),所以 migration
      // runner 对 v6 单独走非事务路径。
      //
      // 幂等性:如果 setSchemaVersion 前崩溃再启动,v6 会被重跑。老代码
      // `CREATE TABLE nodes_new` 就会报 "table nodes_new already exists"。
      // 先 DROP IF EXISTS 兜底,让重跑也能完成。
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TABLE IF EXISTS nodes_new');
      db.exec(`
        CREATE TABLE nodes_new (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('fact','context','preference','idea','crystal','meta')),
            content TEXT NOT NULL,
            heat REAL DEFAULT 1.0,
            refinement REAL DEFAULT 0.0,
            connectivity REAL DEFAULT 0.0,
            independence REAL DEFAULT 0.0,
            specificity REAL DEFAULT 0.5,
            subjectivity REAL DEFAULT 0.5,
            actuality REAL DEFAULT 0.5,
            is_crystal INTEGER DEFAULT 0,
            is_tag INTEGER DEFAULT 0,
            is_meta INTEGER DEFAULT 0,
            source_tool TEXT,
            source_session TEXT,
            source_stream TEXT,
            source_timestamp TEXT,
            tags TEXT,
            created TEXT NOT NULL,
            last_reconsolidated TEXT,
            version INTEGER DEFAULT 1,
            archived INTEGER DEFAULT 0,
            is_keystone INTEGER DEFAULT 0,
            maturity_score REAL DEFAULT 0.0
        )
      `);

      db.exec(`
        INSERT INTO nodes_new SELECT
            id, type, content,
            heat, refinement, connectivity, independence,
            specificity, subjectivity, actuality,
            is_crystal, is_tag, is_meta,
            source_tool, source_session, source_stream, source_timestamp,
            tags,
            created, last_reconsolidated, version, archived, is_keystone,
            maturity_score
        FROM nodes
      `);

      db.exec('DROP TABLE nodes');
      db.exec('ALTER TABLE nodes_new RENAME TO nodes');

      // 3. 重建索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_archived ON nodes(archived)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_heat ON nodes(heat)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_keystone ON nodes(is_keystone)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_crystal ON nodes(is_crystal)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_tag ON nodes(is_tag)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_is_meta ON nodes(is_meta)');

      // 4. 重建 FTS（删除旧 FTS 及触发器，重建不含 project 列的版本）
      db.exec('DROP TRIGGER IF EXISTS nodes_ai');
      db.exec('DROP TRIGGER IF EXISTS nodes_ad');
      db.exec('DROP TRIGGER IF EXISTS nodes_au');
      db.exec('DROP TABLE IF EXISTS nodes_fts');

      db.exec(`
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
            content, tags,
            content=nodes, content_rowid=rowid
        )
      `);

      // 同样加 IF NOT EXISTS — 避免 setSchemaVersion 前崩溃再重跑时撞上
      // "trigger already exists"
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
            INSERT INTO nodes_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END
      `);

      // 5. 回填 FTS 索引
      db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");

      // 6. 恢复外键检查并验证完整性
      db.pragma('foreign_keys = ON');
      const fkErrors = db.pragma('foreign_key_check') as unknown[];
      if (fkErrors.length > 0) {
        log.warn(`外键检查发现 ${fkErrors.length} 个问题，但不影响迁移`);
      }

      log.info('迁移 v6 完成: project 列已移除，FTS 已重建');
    },
  },
  {
    version: 7,
    description: '新增 is_superseded 字段（被取代的旧版本节点标记）',
    up(db: Database.Database) {
      addColumnIfMissing(db, 'nodes', 'is_superseded', 'ALTER TABLE nodes ADD COLUMN is_superseded INTEGER DEFAULT 0');
    },
  },
  {
    version: 8,
    description: '笔记源多实例：新增 note_sources 表，logseq_sync/obsidian_sync 添加 source_id 列',
    up: (db) => {
      // 1. 创建 note_sources 表
      db.exec(`
        CREATE TABLE IF NOT EXISTS note_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            tool_type TEXT NOT NULL,
            path TEXT NOT NULL,
            poll_interval INTEGER DEFAULT 60,
            archived INTEGER DEFAULT 0,
            initialized INTEGER DEFAULT 0,
            created TEXT NOT NULL,
            last_synced TEXT
        )
      `);

      // 2. 为 logseq_sync 和 obsidian_sync 添加 source_id 列（表可能不存在，跳过即可）
      execIgnoringErrors(db, "ALTER TABLE logseq_sync ADD COLUMN source_id TEXT DEFAULT ''", ['duplicate column', 'no such table']);
      execIgnoringErrors(db, "ALTER TABLE obsidian_sync ADD COLUMN source_id TEXT DEFAULT ''", ['duplicate column', 'no such table']);

      // 3. 迁移旧配置：从 config.toml 读取已有笔记源并创建记录
      migrateLegacyNoteSources(db);

      log.info('迁移 v8 完成: note_sources 表已创建，旧配置已迁移');
    },
  },
  {
    version: 9,
    description: '模型连接多实例：新增 model_connections 表，迁移 config.toml 中的已有服务配置',
    up: (db) => {
      // 1. 建表
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            credentials TEXT NOT NULL DEFAULT '{}',
            status TEXT DEFAULT 'unconfigured',
            available_models TEXT,
            last_checked TEXT,
            archived INTEGER DEFAULT 0,
            created TEXT NOT NULL
        )
      `);

      // 2. 从 config.toml 迁移已有的服务配置
      migrateModelConnections(db);

      log.info('迁移 v9 完成: model_connections 表已创建');
    },
  },
  {
    version: 10,
    description: '节点标题字段：新增 title 列',
    up: (db) => {
      execIgnoringDuplicateColumn(db, 'ALTER TABLE nodes ADD COLUMN title TEXT');
      log.info('迁移 v10 完成: nodes.title 列已添加');
    },
  },
  {
    version: 11,
    description: 'Notion 集成：添加 notion_sync 和 notion_pending_relations 表',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notion_sync (
          page_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          last_edited_time TEXT NOT NULL,
          page_type TEXT NOT NULL DEFAULT 'page',
          last_synced TEXT NOT NULL,
          node_ids TEXT,
          source_id TEXT DEFAULT '',
          PRIMARY KEY (page_id, source_id)
        );

        CREATE TABLE IF NOT EXISTS notion_pending_relations (
          source_page_id TEXT NOT NULL,
          target_page_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          property_name TEXT NOT NULL,
          source_id TEXT NOT NULL DEFAULT '',
          created TEXT NOT NULL,
          PRIMARY KEY (source_page_id, target_page_id, property_name, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_notion_pending_target
          ON notion_pending_relations(target_page_id, source_id);
      `);
      log.info('迁移 v11 完成: Notion 集成表已创建');
    },
  },
  {
    version: 12,
    description: '云同步准备：新增 source_device 列',
    up: (db) => {
      execIgnoringDuplicateColumn(db, "ALTER TABLE nodes ADD COLUMN source_device TEXT DEFAULT 'local'");
      log.info('迁移 v12 完成: nodes.source_device 列已添加');
    },
  },
  {
    version: 13,
    description: '回填标题：从同步表反推 Logseq/Obsidian 节点的真实标题',
    up: (db) => {
      // 从文件路径推导标题（与 preprocessor.ts inferTitle 逻辑一致）
      function inferTitleFromPath(filePath: string): string | null {
        const parts = filePath.split('/');
        const basename = parts[parts.length - 1]?.replace(/\.md$/, '');
        if (!basename) return null;
        const isJournal = filePath.startsWith('journals/');
        if (isJournal) return basename.replace(/_/g, '-'); // 日记页标题是日期
        try {
          return decodeURIComponent(basename.replace(/___/g, '/').replace(/%2F/gi, '/'));
        } catch {
          return basename;
        }
      }

      let backfilledLogseq = 0;
      let backfilledObsidian = 0;

      // ---- Logseq 回填 ----
      try {
        const logseqRows = db.prepare(
          "SELECT file_path, node_ids FROM logseq_sync WHERE node_ids IS NOT NULL",
        ).all() as Array<{ file_path: string; node_ids: string }>;

        const updateStmt = db.prepare(
          "UPDATE nodes SET title = ? WHERE id = ? AND title IS NULL",
        );

        for (const row of logseqRows) {
          // 跳过日记页——日记子节点标题都是同一个日期，不如留 NULL 让 annotate 生成有意义标题
          if (row.file_path.startsWith('journals/')) continue;
          const title = inferTitleFromPath(row.file_path);
          if (!title) continue;
          let nodeIds: string[];
          try { nodeIds = JSON.parse(row.node_ids); } catch { continue; }
          if (!Array.isArray(nodeIds)) continue;
          for (const nid of nodeIds) {
            const changes = updateStmt.run(title, nid);
            if (changes.changes > 0) backfilledLogseq++;
          }
        }
      } catch { /* logseq_sync 表可能不存在 */ }

      // ---- Obsidian 回填 ----
      try {
        const obsidianRows = db.prepare(
          "SELECT file_path, node_ids FROM obsidian_sync WHERE node_ids IS NOT NULL",
        ).all() as Array<{ file_path: string; node_ids: string }>;

        const updateStmt = db.prepare(
          "UPDATE nodes SET title = ? WHERE id = ? AND title IS NULL",
        );

        for (const row of obsidianRows) {
          const title = inferTitleFromPath(row.file_path);
          if (!title) continue;
          let nodeIds: string[];
          try { nodeIds = JSON.parse(row.node_ids); } catch { continue; }
          if (!Array.isArray(nodeIds)) continue;
          for (const nid of nodeIds) {
            const changes = updateStmt.run(title, nid);
            if (changes.changes > 0) backfilledObsidian++;
          }
        }
      } catch { /* obsidian_sync 表可能不存在 */ }

      // ---- 修复被 annotate 覆盖的标题 ----
      // 对 refinement = 0.1（恰好被标注过一次）且 title 看起来是 AI 生成的节点，
      // 用同步表的真实标题覆盖回去
      try {
        const logseqRows = db.prepare(
          "SELECT file_path, node_ids FROM logseq_sync WHERE node_ids IS NOT NULL",
        ).all() as Array<{ file_path: string; node_ids: string }>;

        const overwriteStmt = db.prepare(
          "UPDATE nodes SET title = ? WHERE id = ? AND source_tool = 'logseq' AND title IS NOT NULL AND refinement > 0",
        );

        for (const row of logseqRows) {
          const title = inferTitleFromPath(row.file_path);
          if (!title) continue;
          // 跳过日记页——日记的标题是日期，不如 AI 标题有意义
          if (row.file_path.startsWith('journals/')) continue;
          let nodeIds: string[];
          try { nodeIds = JSON.parse(row.node_ids); } catch { continue; }
          if (!Array.isArray(nodeIds)) continue;
          for (const nid of nodeIds) {
            // 只有当节点当前标题与真实标题不同时才覆盖
            const node = db.prepare("SELECT title FROM nodes WHERE id = ?").get(nid) as { title: string | null } | undefined;
            if (node?.title && node.title !== title) {
              overwriteStmt.run(title, nid);
            }
          }
        }
      } catch { /* 忽略 */ }

      // 同样处理 Obsidian
      try {
        const obsidianRows = db.prepare(
          "SELECT file_path, node_ids FROM obsidian_sync WHERE node_ids IS NOT NULL",
        ).all() as Array<{ file_path: string; node_ids: string }>;

        const overwriteStmt = db.prepare(
          "UPDATE nodes SET title = ? WHERE id = ? AND source_tool = 'obsidian' AND title IS NOT NULL AND refinement > 0",
        );

        for (const row of obsidianRows) {
          const title = inferTitleFromPath(row.file_path);
          if (!title) continue;
          let nodeIds: string[];
          try { nodeIds = JSON.parse(row.node_ids); } catch { continue; }
          if (!Array.isArray(nodeIds)) continue;
          for (const nid of nodeIds) {
            const node = db.prepare("SELECT title FROM nodes WHERE id = ?").get(nid) as { title: string | null } | undefined;
            if (node?.title && node.title !== title) {
              overwriteStmt.run(title, nid);
            }
          }
        }
      } catch { /* 忽略 */ }

      log.info(`迁移 v13 完成: 回填标题 logseq=${backfilledLogseq} obsidian=${backfilledObsidian}`);
    },
  },
  {
    version: 14,
    description: 'FTS 索引加入 title 字段，重建索引和触发器',
    up: (db) => {
      // 删除旧的 FTS 表和触发器
      db.exec("DROP TRIGGER IF EXISTS nodes_ai");
      db.exec("DROP TRIGGER IF EXISTS nodes_ad");
      db.exec("DROP TRIGGER IF EXISTS nodes_au");
      db.exec("DROP TABLE IF EXISTS nodes_fts");

      // 重建包含 title 的 FTS 表
      db.exec(`
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
          title,
          content,
          tags,
          content=nodes,
          content_rowid=rowid
        )
      `);

      // 重建触发器。**必须用 IF NOT EXISTS** — ensureSchema 每次启动先
      // `db.exec(FTS_TRIGGERS_SQL)`(同样 IF NOT EXISTS 创建),再跑 migrations。
      // 如果 v14 的 CREATE TRIGGER 不加 IF NOT EXISTS,schema_version 没写就
      // 重启时,触发器在前一步已建过 → v14 migration 会 "trigger already exists"
      // 抛异常 → daemon 启动失败。事务回滚能救,但错误干扰排查。
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, title, content, tags)
          VALUES('delete', old.rowid, old.title, old.content, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, title, content, tags)
          VALUES('delete', old.rowid, old.title, old.content, old.tags);
          INSERT INTO nodes_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
        END;
      `);

      // 全量重建索引
      db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");

      log.info('迁移 v14 完成: FTS 索引已加入 title 字段并重建');
    },
  },
  {
    version: 15,
    description: '清理外部笔记来源节点被错误向量归并的历史数据',
    up: (db) => {
      // 背景：在早期版本中，logseq/obsidian/notion/apple-notes 同步路径上
      // 的 digest 调用会走 landing merge 分支——相似度 ≥ 0.92 时把新段内
      // 容合并进某个历史相似节点，导致 target 被反复覆盖、heat 虚高、版本
      // 历史畸形堆积。修复已将这些路径改为 skipDedupMerge: true，但历史
      // 脏数据需要单独清理。
      //
      // 识别条件：
      //   - 来源是外部笔记工具
      //   - node_versions 里至少有一条 change_reason 包含"去重合并"
      //   - 仍然活跃（archived = 0, is_superseded = 0）
      //
      // 处理：archive 掉（heat=0.02），清掉 nodes_vec 和 node_segments，
      // 避免继续污染搜索和 landing 结果。保留 node_versions 做历史审计，
      // 用户如有需要可通过"已归档节点"界面恢复（unarchiveNode）。
      //
      // 下次外部笔记同步该文件时，因为 oldNodeIds 里的这些节点仍然存在
      // （只是 archived），supersedeNode 仍可正常迁移链接；但如果脏节点
      // 对应的文件用户不再编辑，它们就永久 archived，符合预期。

      const victims = db.prepare(`
        SELECT DISTINCT n.id
        FROM nodes n
        WHERE n.source_tool IN ('logseq', 'obsidian', 'notion', 'apple-notes')
          AND n.archived = 0
          AND n.is_superseded = 0
          AND EXISTS (
            SELECT 1 FROM node_versions v
            WHERE v.node_id = n.id AND v.change_reason LIKE '%去重合并%'
          )
      `).all() as Array<{ id: string }>;

      if (victims.length === 0) {
        log.info('迁移 v15: 无需清理，未检测到错误归并节点');
        return;
      }

      log.info(`迁移 v15: 检测到 ${victims.length} 个外部笔记来源的错误归并节点，开始归档`);

      const archiveStmt = db.prepare(
        'UPDATE nodes SET archived = 1, heat = 0.02 WHERE id = ? AND archived = 0',
      );
      const delSegStmt = db.prepare('DELETE FROM node_segments WHERE node_id = ?');
      // nodes_vec 依赖 sqlite-vec 扩展，在某些环境下可能未加载，单独 try
      // WARN: v15/v16 的 DELETE 条件错误（id vs segment_id），v18 做补救清理
      // nodes_vec.id 存的是 `${nodeId}#${index}`（见 src/db/vectors.ts:85），
      // 这里传 node_id 永远匹配不到，等于没删。v18 通过 node_segments 查出
      // 真正的 segment_id 再删，全量兜底清理所有已归档节点的残留向量。
      let delVecStmt: ReturnType<typeof db.prepare> | null = null;
      try {
        delVecStmt = db.prepare('DELETE FROM nodes_vec WHERE id = ?');
      } catch { /* nodes_vec 未加载，跳过向量清理 */ }

      let archivedCount = 0;
      for (const { id } of victims) {
        const res = archiveStmt.run(id);
        if (res.changes > 0) archivedCount++;
        delSegStmt.run(id);
        if (delVecStmt) {
          try { delVecStmt.run(id); } catch { /* skip */ }
        }
      }

      log.info(`迁移 v15 完成: 已归档 ${archivedCount} 个错误归并节点（可在"已归档节点"中恢复）`);
    },
  },
  {
    version: 16,
    description: '补漏 v15：清理已被 supersede 但仍有错误归并历史的外部笔记节点',
    up: (db) => {
      // v15 的条件 is_superseded = 0 漏掉了一类节点：节点本身是脏的（有"去重合并"
      // 版本历史），但在 v15 跑之前已经被某次 logseq watcher 同步 supersede 过，
      // `is_superseded = 1` 使 v15 的 WHERE 跳过它们。这些节点：
      //   - archived = 0 → 仍出现在默认 UI 查询里（尤其当 heat 没降到 0.01）
      //   - content 仍是被反复覆盖的脏内容
      //   - heat 可能因 dedup 累加到 2.x
      //
      // v16 对 v15 用同样的归档操作，条件反过来（is_superseded = 1）。新用户
      // 从 v0-v14 升上来会依次跑 v15 + v16，合计等价于一次性全覆盖。

      const victims = db.prepare(`
        SELECT DISTINCT n.id
        FROM nodes n
        WHERE n.source_tool IN ('logseq', 'obsidian', 'notion', 'apple-notes')
          AND n.archived = 0
          AND n.is_superseded = 1
          AND EXISTS (
            SELECT 1 FROM node_versions v
            WHERE v.node_id = n.id AND v.change_reason LIKE '%去重合并%'
          )
      `).all() as Array<{ id: string }>;

      if (victims.length === 0) {
        log.info('迁移 v16: 无需清理，未检测到 v15 遗漏的节点');
        return;
      }

      log.info(`迁移 v16: 检测到 ${victims.length} 个 v15 遗漏的错误归并节点（已被 supersede），开始归档`);

      const archiveStmt = db.prepare(
        'UPDATE nodes SET archived = 1, heat = 0.02 WHERE id = ? AND archived = 0',
      );
      const delSegStmt = db.prepare('DELETE FROM node_segments WHERE node_id = ?');
      // WARN: v15/v16 的 DELETE 条件错误（id vs segment_id），v18 做补救清理
      // （原意清 nodes_vec 残留向量，但传的是 node_id 而非 segment_id，一行没删）
      let delVecStmt: ReturnType<typeof db.prepare> | null = null;
      try {
        delVecStmt = db.prepare('DELETE FROM nodes_vec WHERE id = ?');
      } catch { /* nodes_vec 未加载，跳过向量清理 */ }

      let archivedCount = 0;
      for (const { id } of victims) {
        const res = archiveStmt.run(id);
        if (res.changes > 0) archivedCount++;
        delSegStmt.run(id);
        if (delVecStmt) {
          try { delVecStmt.run(id); } catch { /* skip */ }
        }
      }

      log.info(`迁移 v16 完成: 已归档 ${archivedCount} 个 v15 遗漏的错误归并节点`);
    },
  },
  {
    version: 17,
    description: 'Reconcile LWW: nodes/links 加 updated 字段(双端 LWW 冲突检测)',
    up: (db) => {
      const nodesUpdatedWasMissing = !tableHasColumn(db, 'nodes', 'updated');
      addColumnIfMissing(db, 'nodes', 'updated', 'ALTER TABLE nodes ADD COLUMN updated TEXT');
      if (nodesUpdatedWasMissing) {
        db.exec('UPDATE nodes SET updated = created WHERE updated IS NULL');
      }

      const linksUpdatedWasMissing = !tableHasColumn(db, 'links', 'updated');
      addColumnIfMissing(db, 'links', 'updated', 'ALTER TABLE links ADD COLUMN updated TEXT');
      if (linksUpdatedWasMissing) {
        db.exec('UPDATE links SET updated = created WHERE updated IS NULL');
      }

      log.info('迁移 v17 完成: nodes/links.updated 字段已添加并 backfill');
    },
  },
  {
    version: 18,
    description: '补救 v15/v16 的向量清理 bug：兜底清除所有已归档节点的 nodes_vec + node_segments 残留',
    up: (db) => {
      // 背景：v15/v16 本意是归档错误归并节点后清掉 nodes_vec 与 node_segments，
      // 但写成了 `DELETE FROM nodes_vec WHERE id = ?` 并传 node_id；而
      // nodes_vec.id 实际存的是 segment_id（格式 `${nodeId}#${index}`，
      // 见 src/db/vectors.ts:85）。结果 v15/v16 一行 nodes_vec 都没删。
      //
      // 另外 archiveNode / 各 integration 的归档路径（src/db/nodes.ts:155
      // 及 src/integrations/{apple-notes,notion,logseq,obsidian}）都不清
      // 向量索引，凡是历史上被归档过的节点，其 embedding 都还在 nodes_vec
      // 里继续被 landing/recall 返回。
      //
      // v18 做一次性全量兜底：对**所有** nodes.archived = 1 的节点，用
      // node_segments.segment_id 作为正确 key，清掉 nodes_vec 行，再清
      // node_segments 自身。新安装数据库此时 nodes 表为空，查询返回 0 行，
      // 不受影响。
      //
      // 幂等：重复执行无副作用——被清过的节点在 node_segments 里已查不到
      // segment_id，SELECT ... IN (...) 子查询就返回空集，DELETE 不会误伤
      // 任何活跃节点的向量数据。

      // nodes_vec 依赖 sqlite-vec 扩展（initVec 在 ensureSchema 之后才跑）。
      // ensureSchema 阶段 nodes_vec 可能还不存在，prepare 会抛。单独 try。
      let vecCleaned = 0;
      try {
        const delVecRes = db.prepare(`
          DELETE FROM nodes_vec
          WHERE id IN (
            SELECT segment_id FROM node_segments
            WHERE node_id IN (SELECT id FROM nodes WHERE archived = 1)
          )
        `).run();
        vecCleaned = delVecRes.changes;
      } catch {
        // nodes_vec 未加载或不存在，跳过向量清理；下次 reembed 兜底
      }

      const delSegRes = db.prepare(`
        DELETE FROM node_segments
        WHERE node_id IN (SELECT id FROM nodes WHERE archived = 1)
      `).run();
      const segCleaned = delSegRes.changes;

      log.info(
        `迁移 v18 完成: cleaned ${vecCleaned} rows from nodes_vec, ${segCleaned} rows from node_segments for archived nodes`,
      );
    },
  },
  {
    version: 19,
    description: 'links.status 扩展 CHECK 约束，允许 rejected_by_user（标签纠错反馈循环）',
    up: (db) => {
      // 幂等检查：读 sqlite_master 里的原始建表 SQL，看 CHECK 是否已包含新值
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='links'",
      ).get() as { sql: string } | undefined;
      if (row?.sql && row.sql.includes("'rejected_by_user'")) {
        log.info('迁移 v19 跳过: links CHECK 已支持 rejected_by_user');
        return;
      }

      // 重建 links 表（SQLite 不支持 ALTER CHECK）。
      // 沿用 v3 的 pattern：不需 FK OFF，因为 links 不被其他表引用。
      //
      // 显式 db.transaction 包裹整个 rebuild：runMigrations 本身已经把每个
      // migration 放在事务里，所以 better-sqlite3 会在此处自动使用 SAVEPOINT。
      // 作为防御写法保留，若以后有人把此 migration 抽到非事务路径（像 v6），
      // DROP→RENAME 之间 crash 仍不会永久损坏 DB。
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS links_new');
        db.exec(`
          CREATE TABLE links_new (
              id TEXT PRIMARY KEY,
              from_id TEXT NOT NULL REFERENCES nodes(id),
              to_id TEXT NOT NULL REFERENCES nodes(id),
              relation TEXT NOT NULL,
              strength REAL DEFAULT 0.5,
              note TEXT,
              auto INTEGER DEFAULT 1,
              status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending','rejected_by_user')),
              created TEXT NOT NULL,
              updated TEXT
          )
        `);

        db.exec(`
          INSERT INTO links_new (id, from_id, to_id, relation, strength, note, auto, status, created, updated)
          SELECT id, from_id, to_id, relation, strength, note, auto, status, created, updated FROM links
        `);

        db.exec('DROP TABLE links');
        db.exec('ALTER TABLE links_new RENAME TO links');

        // 重建索引
        db.exec('CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)');
      })();

      log.info('迁移 v19 完成: links.status CHECK 已扩展为支持 rejected_by_user');
    },
  },
  {
    version: 20,
    description: 'pending_digests 新增 processing_started_at 字段（stale recovery 语义修正）',
    up: (db) => {
      // 背景：claimNextPendingDigest 的 stale recovery 原先用
      // `next_retry_at < now() - 10min` 判定卡死的 processing 行，但
      // next_retry_at 只在 pending 态设置，进入 processing 不会刷新，
      // 导致超时阈值变成"最后一次调度时间 + 10 min"而非"processing 开始后 10 min"。
      // 新增 processing_started_at 专门记录进入 processing 的时刻。
      //
      // 幂等：用 PRAGMA table_info 检测列是否存在。
      addColumnIfMissing(
        db,
        'pending_digests',
        'processing_started_at',
        'ALTER TABLE pending_digests ADD COLUMN processing_started_at TEXT',
      );
      log.info('迁移 v20 完成: pending_digests.processing_started_at 已添加');
    },
  },
  {
    version: 21,
    description: 'P1: 复合索引 (archived,is_superseded,heat|updated) + tag_usage 物化表与 trigger',
    up: (db) => {
      // 1. 复合索引(perf-optimization-2026-05-17 P1-1)
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_active_heat ON nodes(archived, is_superseded, heat DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_active_updated ON nodes(archived, is_superseded, updated DESC)');

      // 2. tag_usage 物化表 + trigger(perf-optimization-2026-05-17 P1-2)。
      // SCHEMA_SQL 在 ensureSchema 入口已 IF NOT EXISTS 建好,这里只跑首次
      // backfill。同时显式 CREATE 一份兜底——老 DB 跑 ensureSchema 时 SCHEMA_SQL
      // 已经把它们建上,这里幂等再建一次保险(避免任何执行顺序边角)。
      db.exec(`
        CREATE TABLE IF NOT EXISTS tag_usage (
            tag TEXT PRIMARY KEY,
            node_count INTEGER NOT NULL DEFAULT 0,
            last_updated TEXT
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_tag_usage_count ON tag_usage(node_count DESC)');

      // 3. 首次 backfill:从 nodes 全量重算 tag_usage(此时 trigger 已就位,
      // 但 backfill 直接写 tag_usage,不通过 nodes 触发,避免双计)。
      backfillTagUsage(db);

      log.info('迁移 v21 完成: 复合索引 + tag_usage 已建,首次 backfill 已跑');
    },
  },
  {
    version: 22,
    description: 'P2: structure_holes_cache 单行表(后台预计算结构洞,IPC 直读)',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS structure_holes_cache (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL,
            computed_at TEXT NOT NULL
        );
      `);
      log.info('迁移 v22 完成: structure_holes_cache 已建(首次填充由 daemon 任务异步进行)');
    },
  },
  {
    version: 23,
    description: 'FTS trigger 加 OF (title, content, tags) 限定,防止无关字段 UPDATE 触发写放大',
    up: (db) => {
      // 现有 nodes_au trigger 无 OF 子句,bumpHeat / synaptic 衰减等高频 UPDATE 都
      // 重写 FTS。drop 后重建带 OF 子句版本(SCHEMA_SQL 里同步更新)。
      db.exec(`
        DROP TRIGGER IF EXISTS nodes_au;
        CREATE TRIGGER nodes_au AFTER UPDATE OF title, content, tags ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, title, content, tags)
            VALUES('delete', old.rowid, old.title, old.content, old.tags);
            INSERT INTO nodes_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;
      `);
      log.info('迁移 v23 完成: nodes_au trigger 已加 OF 子句,FTS 写放大已修');
    },
  },
  {
    version: 24,
    description: 'tag_usage triggers 加 json_valid 防御,损坏 JSON 不再让 UPDATE 失败',
    up: (db) => {
      // 旧 triggers 直接 json_each(NEW.tags),遇到非法 JSON 抛 malformed JSON 让
      // 整 UPDATE 失败,污染所有 UPDATE nodes 的事务。重建带 json_valid 守卫的版本。
      db.exec(`
        DROP TRIGGER IF EXISTS trg_tag_usage_after_insert;
        DROP TRIGGER IF EXISTS trg_tag_usage_after_delete;
        DROP TRIGGER IF EXISTS trg_tag_usage_after_update;
        CREATE TRIGGER trg_tag_usage_after_insert
        AFTER INSERT ON nodes
        WHEN NEW.tags IS NOT NULL
          AND COALESCE(NEW.archived, 0) = 0
          AND COALESCE(NEW.is_superseded, 0) = 0
        BEGIN
            INSERT INTO tag_usage(tag, node_count, last_updated)
            SELECT value, 1, datetime('now')
            FROM json_each(CASE WHEN json_valid(NEW.tags) = 1 THEN NEW.tags ELSE '[]' END)
            WHERE typeof(value) = 'text' AND length(value) > 0
            ON CONFLICT(tag) DO UPDATE SET
                node_count = node_count + 1,
                last_updated = datetime('now');
        END;
        CREATE TRIGGER trg_tag_usage_after_delete
        AFTER DELETE ON nodes
        WHEN OLD.tags IS NOT NULL
          AND COALESCE(OLD.archived, 0) = 0
          AND COALESCE(OLD.is_superseded, 0) = 0
        BEGIN
            UPDATE tag_usage SET
                node_count = node_count - 1,
                last_updated = datetime('now')
            WHERE tag IN (
                SELECT value FROM json_each(CASE WHEN json_valid(OLD.tags) = 1 THEN OLD.tags ELSE '[]' END) WHERE typeof(value) = 'text'
            );
            DELETE FROM tag_usage WHERE node_count <= 0;
        END;
        CREATE TRIGGER trg_tag_usage_after_update
        AFTER UPDATE OF tags, archived, is_superseded ON nodes
        BEGIN
            UPDATE tag_usage SET
                node_count = node_count - 1,
                last_updated = datetime('now')
            WHERE COALESCE(OLD.archived, 0) = 0
              AND COALESCE(OLD.is_superseded, 0) = 0
              AND tag IN (
                  SELECT value FROM json_each(CASE WHEN json_valid(COALESCE(OLD.tags, '[]')) = 1 THEN COALESCE(OLD.tags, '[]') ELSE '[]' END)
                  WHERE typeof(value) = 'text'
              );
            INSERT INTO tag_usage(tag, node_count, last_updated)
            SELECT value, 1, datetime('now')
            FROM json_each(CASE WHEN json_valid(COALESCE(NEW.tags, '[]')) = 1 THEN COALESCE(NEW.tags, '[]') ELSE '[]' END)
            WHERE typeof(value) = 'text'
              AND length(value) > 0
              AND COALESCE(NEW.archived, 0) = 0
              AND COALESCE(NEW.is_superseded, 0) = 0
            ON CONFLICT(tag) DO UPDATE SET
                node_count = node_count + 1,
                last_updated = datetime('now');
            DELETE FROM tag_usage WHERE node_count <= 0;
        END;
      `);
      log.info('迁移 v24 完成: tag_usage triggers 已加 json_valid 守卫');
    },
  },
  {
    version: 25,
    description: 'heat 字段语义守卫:钳现有越界数据 + trigger 拦未来越界写入',
    up: (db) => {
      // 1. 修历史脏数据:之前 bumpHeat / dedup 钳到 10.0,旧 DB 里可能有 heat=1.5/9.x 的节点。
      const fixed = db.prepare('UPDATE nodes SET heat = MAX(0, MIN(1, heat)) WHERE heat < 0 OR heat > 1').run();
      if (fixed.changes > 0) {
        log.info(`迁移 v25: 钳 ${fixed.changes} 个节点的 heat 到 [0,1]`);
      }
      // 2. 部署 trigger 到现有 DB(SCHEMA_SQL 已同步,新建 DB 直接带)。
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_nodes_heat_clamp_insert
        AFTER INSERT ON nodes
        WHEN NEW.heat < 0 OR NEW.heat > 1
        BEGIN
            UPDATE nodes SET heat = MAX(0, MIN(1, NEW.heat)) WHERE id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_nodes_heat_clamp_update
        AFTER UPDATE OF heat ON nodes
        WHEN NEW.heat < 0 OR NEW.heat > 1
        BEGIN
            UPDATE nodes SET heat = MAX(0, MIN(1, NEW.heat)) WHERE id = NEW.id;
        END;
      `);
      log.info('迁移 v25 完成: heat 越界守卫 trigger 已就位');
    },
  },
];

/**
 * 全量重算 tag_usage 表(perf-optimization-2026-05-17 P1-2)。
 *
 * 用途:
 * 1. migration v21 首次 backfill
 * 2. trigger 漂移修复(若发现 tag_usage 与全表聚合不一致,主动重建)
 * 3. 测试时基准重算
 *
 * 注意:本函数 TRUNCATE + 重建,在事务里跑保证原子性。直接写 tag_usage 表,
 * 不通过 UPDATE nodes 触发 trigger,避免在自身 trigger 上下文里重入。
 */
export function backfillTagUsage(db: Database.Database): { tagCount: number; rowsScanned: number } {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM tag_usage');

    // SQL 级聚合:json_each 拆 tags + GROUP BY 计数,一次完成,不走 JS 端
    // JSON.parse。万节点下亦在几十 ms 量级。
    const result = db.prepare(`
      INSERT INTO tag_usage(tag, node_count, last_updated)
      SELECT je.value AS tag, COUNT(*) AS cnt, datetime('now')
      FROM nodes n, json_each(COALESCE(n.tags, '[]')) je
      WHERE COALESCE(n.archived, 0) = 0
        AND COALESCE(n.is_superseded, 0) = 0
        AND typeof(je.value) = 'text'
        AND length(je.value) > 0
      GROUP BY je.value
    `).run();

    const rowsScanned = (db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE COALESCE(archived,0)=0 AND COALESCE(is_superseded,0)=0').get() as { cnt: number }).cnt;
    return { tagCount: Number(result.changes), rowsScanned };
  });
  return tx();
}

/**
 * 读取当前 schema 版本。返回 -1 表示 metadata 表不存在或无版本记录。
 */
function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : -1;
  } catch {
    return -1; // metadata 表不存在
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)"
  ).run(String(version));
}

/**
 * 执行待运行的 migrations。每个 migration 在事务中执行。
 */
function runMigrations(db: Database.Database, fromVersion: number): void {
  const pending = MIGRATIONS.filter(m => m.version > fromVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    log.info(`执行迁移 v${migration.version}: ${migration.description}`);
    if (migration.version === 6) {
      // v6 需要 PRAGMA foreign_keys = OFF，不能在事务中执行
      migration.up(db);
      setSchemaVersion(db, migration.version);
    } else {
      const txn = db.transaction(() => {
        migration.up(db);
        setSchemaVersion(db, migration.version);
      });
      txn();
    }
    log.info(`迁移 v${migration.version} 完成`);
  }
}

// ── 公开 API ────────────────────────────────────────────────────

export function ensureSchema(db: Database.Database): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // 建表（IF NOT EXISTS 保证幂等）
  db.exec(SCHEMA_SQL);

  // FTS5
  db.exec(FTS_SQL);
  db.exec(FTS_TRIGGERS_SQL);

  // 检查 schema 版本并执行迁移
  const currentVersion = getSchemaVersion(db);

  if (currentVersion === -1) {
    // 两种情况：
    // 1. 全新数据库 → SCHEMA_SQL 已创建最新结构，直接标记为最新版本
    // 2. 旧数据库（没有 schema_version）→ 需要跑所有 migration
    // 通过检查 nodes 表是否有数据来区分
    const hasData = (db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number }).cnt > 0;

    if (hasData) {
      // 旧数据库，从 v0 开始跑 migration
      log.info('检测到旧数据库，开始执行迁移...');
      runMigrations(db, 0);
    } else {
      // 全新数据库，直接标记最新版本
      setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
      log.info(`新数据库，schema 版本: v${CURRENT_SCHEMA_VERSION}`);
    }
  } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
    // 需要升级
    log.info(`数据库 schema v${currentVersion} → v${CURRENT_SCHEMA_VERSION}，执行迁移...`);
    runMigrations(db, currentVersion);
  }
  // else: 已是最新版本，无需操作
}

export function ensureVectorTable(db: Database.Database, dimensions: number = 3072): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
    );
  `);
}
