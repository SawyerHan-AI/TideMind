import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { migrateDataDirIfNeeded } from '@server/utils/migrate-data-dir.js'
import { syncSkillFiles, createSyncHashStoreFromDb } from '@server/utils/sync-skill-files.js'
import { createLogger } from '@server/utils/logger.js'

let db: Database.Database | null = null
let migrationDone = false

const migrationLog = createLogger('client-migrate')

function ensureMigration(): void {
  if (migrationDone) return
  migrateDataDirIfNeeded(migrationLog)
  migrationDone = true
}

function getDataDir(): string {
  ensureMigration()
  const defaultDir = path.join(os.homedir(), '.tidemind')
  const configPath = path.join(defaultDir, 'config.toml')

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const config = parseToml(raw) as Record<string, unknown>
      const general = config.general as Record<string, string> | undefined
      if (general?.data_dir) {
        return general.data_dir.replace('~', os.homedir())
      }
    } catch {}
  }

  return defaultDir
}

/**
 * 确保数据目录结构存在
 */
function ensureDataDirs(dataDir: string): void {
  const dirs = [
    dataDir,
    path.join(dataDir, 'stream'),
    path.join(dataDir, 'graph'),
    path.join(dataDir, 'crystal'),
    path.join(dataDir, 'strategies'),
    path.join(dataDir, 'skill'),
    path.join(dataDir, 'exports'),
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 从项目 data/ 目录复制默认策略和 Skill 文件
 */
function copyDefaultFiles(dataDir: string): void {
  // 查找 data/ 源目录（相对于 electron/out/main/）
  const candidates = [
    // Electron 打包后：data/ 位于 Contents/Resources/data/
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'data')] : []),
    path.join(__dirname, '..', '..', 'data'),         // dev 模式
    path.join(__dirname, '..', '..', '..', 'data'),   // 其他
    path.join(process.cwd(), 'data'),                  // 从项目根运行
    path.join(process.cwd(), '..', 'data'),            // 从 client/ 运行
  ]

  let sourceDir: string | null = null
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'strategies'))) {
      sourceDir = c
      break
    }
  }
  if (!sourceDir) return

  // 复制策略文件
  const strategiesDir = path.join(dataDir, 'strategies')
  const sourceStrategies = path.join(sourceDir, 'strategies')
  if (fs.existsSync(sourceStrategies)) {
    for (const file of fs.readdirSync(sourceStrategies).filter(f => f.endsWith('.md'))) {
      const src = path.join(sourceStrategies, file)
      const dest = path.join(strategiesDir, file)
      if (!fs.existsSync(dest)) {
        // 新文件，直接复制
        fs.copyFileSync(src, dest)
      } else {
        // 格式迁移：源文件是纯 prompt 格式（无 ## System Prompt），
        // 但目标文件还是旧格式（有 ## System Prompt）→ 覆盖
        const sourceContent = fs.readFileSync(src, 'utf-8')
        const targetContent = fs.readFileSync(dest, 'utf-8')
        const sourceIsNew = !/##\s+.*System\s*Prompt/i.test(sourceContent)
        const targetIsOld = /##\s+.*System\s*Prompt/i.test(targetContent)
        if (sourceIsNew && targetIsOld) {
          fs.copyFileSync(src, dest)
        }
      }
    }
  }

  // 复制 MCP 描述文件（仅补缺失）
  const mcpDescSrc = path.join(sourceDir, 'mcp-descriptions.json')
  const mcpDescDst = path.join(dataDir, 'mcp-descriptions.json')
  if (fs.existsSync(mcpDescSrc) && !fs.existsSync(mcpDescDst)) {
    fs.copyFileSync(mcpDescSrc, mcpDescDst)
  }

  // 同步 Skill 文件：hash-based 同步 + 旧品牌过渡清理
  // 详见 src/utils/sync-skill-files.ts
  // 传入 dbPath 以启用 hash 模式；如果 DB 还没建（首次运行）则退化为 legacy marker 检测
  const skillDir = path.join(dataDir, 'skill')
  const sourceSkill = path.join(sourceDir, 'skill')
  const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')
  let skillDb: Database.Database | null = null
  let hashStore: ReturnType<typeof createSyncHashStoreFromDb> | undefined
  try {
    if (fs.existsSync(dbPath)) {
      skillDb = new Database(dbPath)
      skillDb.pragma('journal_mode = WAL')
      skillDb.pragma('busy_timeout = 5000')
      // createSyncHashStoreFromDb 会执行 CREATE TABLE IF NOT EXISTS，
      // 必须和 new Database 在同一 try 里以便整体降级
      hashStore = createSyncHashStoreFromDb(skillDb)
    }
  } catch {
    // DB 不可用或建表/prepare 失败 → 降级为 legacy marker 模式
    if (skillDb) { try { skillDb.close() } catch { /* ignore */ } }
    skillDb = null
    hashStore = undefined
  }
  const syncResult = syncSkillFiles(sourceSkill, skillDir, { hashStore })
  if (skillDb) {
    try { skillDb.close() } catch { /* ignore */ }
  }
  if (syncResult.refreshed.length > 0) {
    migrationLog.info(`[skill-sync] refreshed: ${syncResult.refreshed.join(', ')}`)
  }
  if (syncResult.userModified.length > 0) {
    migrationLog.info(`[skill-sync] user-modified (preserved): ${syncResult.userModified.join(', ')}`)
  }
}

/**
 * 获取客户端数据库连接（读写模式）
 *
 * 统一使用单一连接，写操作通过 digest 通道保证副作用完整性
 */
export function getClientDb(): Database.Database {
  if (db) return db

  const dataDir = getDataDir()

  // 确保目录存在
  ensureDataDirs(dataDir)

  const dbPath = path.join(dataDir, 'graph', 'brain.sqlite')

  // 如果数据库不存在，创建一个空的（带 schema）
  if (!fs.existsSync(dbPath)) {
    const newDb = new Database(dbPath)
    newDb.pragma('journal_mode = WAL')
    newDb.pragma('foreign_keys = ON')
    // 创建完整表结构（与 daemon 的 SCHEMA_SQL 保持一致）
    // 若客户端先建库，daemon 启动时会检测到已有 schema 并跳过迁移
    newDb.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('fact','context','preference','idea','crystal','meta')),
        content TEXT NOT NULL,
        title TEXT,
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
        source_tool TEXT, source_session TEXT, source_stream TEXT, source_timestamp TEXT,
        tags TEXT,
        created TEXT NOT NULL,
        last_reconsolidated TEXT,
        version INTEGER DEFAULT 1,
        archived INTEGER DEFAULT 0,
        is_keystone INTEGER DEFAULT 0,
        is_superseded INTEGER DEFAULT 0,
        source_device TEXT DEFAULT 'local',
        maturity_score REAL DEFAULT 0.0,
        updated TEXT
      );
      CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES nodes(id),
        to_id TEXT NOT NULL REFERENCES nodes(id),
        relation TEXT NOT NULL,
        strength REAL DEFAULT 0.5,
        note TEXT,
        auto INTEGER DEFAULT 1,
        status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending')),
        created TEXT NOT NULL,
        updated TEXT
      );
      CREATE TABLE IF NOT EXISTS node_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        change_reason TEXT,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        input_summary TEXT, context TEXT, output_node_ids TEXT,
        tool TEXT, session TEXT, agent_id TEXT,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_name TEXT NOT NULL,
        operation_id INTEGER REFERENCES operation_log(id),
        node_id TEXT REFERENCES nodes(id),
        was_used INTEGER,
        feedback_signal REAL,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS sync_hashes (
        file_name TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
      CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
      CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_archived ON nodes(archived);
      CREATE INDEX IF NOT EXISTS idx_nodes_heat ON nodes(heat);
      CREATE INDEX IF NOT EXISTS idx_nodes_keystone ON nodes(is_keystone);
      CREATE INDEX IF NOT EXISTS idx_nodes_is_crystal ON nodes(is_crystal);
      CREATE INDEX IF NOT EXISTS idx_nodes_is_tag ON nodes(is_tag);
      CREATE INDEX IF NOT EXISTS idx_nodes_is_meta ON nodes(is_meta);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        archived INTEGER DEFAULT 0,
        last_active TEXT,
        created TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS node_segments (
        segment_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        UNIQUE(node_id, segment_index)
      );
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
    `)
    newDb.close()
  }

  // 复制默认文件
  copyDefaultFiles(dataDir)

  // 确保所有表在已有数据库上也存在（与 daemon SCHEMA_SQL 保持一致）
  const tmpDb = new Database(dbPath)
  tmpDb.pragma('journal_mode = WAL')
  tmpDb.pragma('busy_timeout = 5000')
  tmpDb.pragma('foreign_keys = ON')
  tmpDb.exec(`
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

    CREATE TABLE IF NOT EXISTS sync_hashes (
      file_name TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tool_type TEXT NOT NULL,
      archived INTEGER DEFAULT 0,
      last_active TEXT,
      created TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS node_segments (
      segment_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      UNIQUE(node_id, segment_index)
    );

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
  `)
  // 迁移：补齐可能缺失的列（幂等，已存在则忽略）
  try { tmpDb.exec('ALTER TABLE operation_log ADD COLUMN agent_id TEXT') } catch {}
  try { tmpDb.exec("ALTER TABLE timeline_events ADD COLUMN actor TEXT DEFAULT 'brain'") } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN title TEXT') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN specificity REAL DEFAULT 0.5') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN subjectivity REAL DEFAULT 0.5') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN actuality REAL DEFAULT 0.5') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN is_crystal INTEGER DEFAULT 0') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN is_tag INTEGER DEFAULT 0') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN is_meta INTEGER DEFAULT 0') } catch {}
  try { tmpDb.exec('ALTER TABLE nodes ADD COLUMN is_superseded INTEGER DEFAULT 0') } catch {}
  try { tmpDb.exec("ALTER TABLE nodes ADD COLUMN source_device TEXT DEFAULT 'local'") } catch {}
  try { tmpDb.exec('ALTER TABLE links ADD COLUMN refined INTEGER DEFAULT 0') } catch {}
  try { tmpDb.exec('ALTER TABLE llm_usage_log ADD COLUMN estimated_cost REAL DEFAULT 0') } catch {}

  // Reconcile LWW: nodes/links 加 `updated` 时间戳(两端都有,冲突时 LWW)。
  // 老数据默认 updated = created(表示从未修改过),backfill 一次。
  try { tmpDb.exec("ALTER TABLE nodes ADD COLUMN updated TEXT") } catch {}
  try { tmpDb.exec("UPDATE nodes SET updated = created WHERE updated IS NULL") } catch {}
  try { tmpDb.exec("ALTER TABLE links ADD COLUMN updated TEXT") } catch {}
  try { tmpDb.exec("UPDATE links SET updated = created WHERE updated IS NULL") } catch {}

  tmpDb.close()

  // 统一的读写连接
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')

  // Cloud sync 的本地 outbox 表。历史遗留 bug:outbox.ts 定义了
  // createOutboxTable,但除了测试外没有任何生产路径调用它。结果是
  // 所有用户的本地 DB 都缺这张表,mcp-router 离线场景和 sync-client
  // 首次 pushOutbox 都会报 `no such table: local_outbox`,让云同步完全
  // 不可用。在此统一建表(IF NOT EXISTS 幂等,对已有用户也安全)。
  // 放在核心 schema 之后而不是 core schema 里,是因为 outbox 属于
  // 客户端 sync 基础设施,不污染 src/db/ 的 core 表定义。
  db.exec(`CREATE TABLE IF NOT EXISTS local_outbox (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER DEFAULT 0
  )`)

  return db
}

export function closeClientDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export { getDataDir }
