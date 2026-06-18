import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { migrateDataDirIfNeeded } from '@server/utils/migrate-data-dir.js'
import { syncSkillFiles, createSyncHashStoreFromDb } from '@server/utils/sync-skill-files.js'
import { createLogger } from '@server/utils/logger.js'
import { execIgnoringDuplicateColumn } from '@server/db/migration-helpers.js'
import { createOutboxTable } from './cloud/outbox.js'

let db: Database.Database | null = null
let migrationDone = false

const migrationLog = createLogger('client-migrate')

/**
 * 安全地执行 ALTER TABLE ADD COLUMN(幂等迁移)。
 *
 * MEDIUM 6 (audit-10, 2026-05-21): 本函数现在是 `execIgnoringDuplicateColumn`
 * 的 backward-compat 包装,业务逻辑全收敛到 `@server/db/migration-helpers.ts`
 * 一份实现,避免开源 / client 两边各维护一份漂移。新代码直接 import
 * `execIgnoringDuplicateColumn` 即可,无需走本 wrapper。
 *
 * 历史背景:db.ts 老代码 14 处 `try { db.exec('ALTER ...') } catch {}` 把
 * "duplicate column"(合法幂等)和 SQLITE_BUSY/FULL/CORRUPT(真错)一起吞掉,
 * 磁盘满/损坏静默成功 → 后续业务随机崩。helper 只吞含 "duplicate column" /
 * "already exists" 文案的 message,其他抛出 + log。
 */
export function safeAlterAddColumn(db: Database.Database, sql: string): void {
  try {
    execIgnoringDuplicateColumn(db, sql)
  } catch (err) {
    migrationLog.error(`migration ALTER failed: ${sql} — ${(err as Error).message}`)
    throw err
  }
}

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
        // 锚定正则:只展开开头的 `~`(后跟 `/` 或字符串结束),不替换路径中间的 `~`。
        // 裸 replace('~', ...) 会把 `/data/my~notes` 误展成 `/data/my<home>notes` →
        // 数据目录错位、DB/配置在错误位置重建。与 _schemas.ts parseNoteSourcePath 一致。
        return general.data_dir.replace(/^~(?=$|\/)/, os.homedir())
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
        updated TEXT,
        -- CRITICAL 修复(审计二轮):内联 schema 必须与 SCHEMA_SQL 同含 edit_seq(M3 因果版本)
        -- + decay_gen(M8 衰减锚点)。否则全新安装 getClientDb 内联建表缺列 → daemon ensureSchema
        -- 因 hasData=0 跳 migration → createNode INSERT edit_seq/decay_gen 崩(no such column)。
        edit_seq INTEGER NOT NULL DEFAULT 0,
        decay_gen INTEGER NOT NULL DEFAULT 0
      );
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
        updated TEXT,
        edit_seq INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0
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
        created TEXT NOT NULL,
        -- CRITICAL 修复(审计三轮):logOperation(recall/digest 必经)INSERT 这 4 列,内联漏了会让
        -- 全新安装首次 brain_recall/digest 崩(同 nodes/links 的内联漏列机制)。
        exact_count INTEGER, related_count INTEGER, fallback_chain TEXT, vector_unavailable INTEGER
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
        completed_at TEXT,
        processing_started_at TEXT
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

    -- B-2: Notion 失败页持久化重试 (与 daemon SCHEMA_SQL / migration v27 对齐)
    CREATE TABLE IF NOT EXISTS notion_pending_retry (
      page_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt TEXT NOT NULL,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dead_letter')),
      PRIMARY KEY (page_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notion_pending_retry_source
      ON notion_pending_retry(source_id, status);
  `)
  // 迁移：补齐可能缺失的列(幂等)。
  // **不要**写成 `try { ALTER } catch {}` —— 空 catch 会同时吞 "duplicate column"
  // (合法)和 SQLITE_BUSY / SQLITE_FULL / SQLITE_CORRUPT(真错),导致磁盘满 / 数据
  // 损坏被静默吞掉。走 safeAlterAddColumn:只吞 "列已存在" 类,其余抛出。
  safeAlterAddColumn(tmpDb, 'ALTER TABLE operation_log ADD COLUMN agent_id TEXT')
  safeAlterAddColumn(tmpDb, "ALTER TABLE timeline_events ADD COLUMN actor TEXT DEFAULT 'brain'")
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN title TEXT')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN specificity REAL DEFAULT 0.5')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN subjectivity REAL DEFAULT 0.5')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN actuality REAL DEFAULT 0.5')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN is_crystal INTEGER DEFAULT 0')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN is_tag INTEGER DEFAULT 0')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN is_meta INTEGER DEFAULT 0')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE nodes ADD COLUMN is_superseded INTEGER DEFAULT 0')
  safeAlterAddColumn(tmpDb, "ALTER TABLE nodes ADD COLUMN source_device TEXT DEFAULT 'local'")
  safeAlterAddColumn(tmpDb, 'ALTER TABLE links ADD COLUMN refined INTEGER DEFAULT 0')
  safeAlterAddColumn(tmpDb, 'ALTER TABLE llm_usage_log ADD COLUMN estimated_cost REAL DEFAULT 0')

  // Reconcile LWW: nodes/links 加 `updated` 时间戳(两端都有,冲突时 LWW)。
  // 老数据默认 updated = created(表示从未修改过),backfill 一次。
  // 注:UPDATE ... WHERE updated IS NULL 是数据 backfill 而非 schema 迁移,
  // 此 helper 仅对 ALTER 有意义,UPDATE 仍走原来的 try/catch — 失败时静默
  // (backfill 失败不阻塞启动,值为 NULL 时业务有 fallback)。
  safeAlterAddColumn(tmpDb, "ALTER TABLE nodes ADD COLUMN updated TEXT")
  try { tmpDb.exec("UPDATE nodes SET updated = created WHERE updated IS NULL") } catch (err) {
    migrationLog.warn(`backfill nodes.updated failed: ${(err as Error).message}`)
  }
  safeAlterAddColumn(tmpDb, "ALTER TABLE links ADD COLUMN updated TEXT")
  try { tmpDb.exec("UPDATE links SET updated = created WHERE updated IS NULL") } catch (err) {
    migrationLog.warn(`backfill links.updated failed: ${(err as Error).message}`)
  }

  // 审计二轮:edit_seq(M3 因果版本)+ decay_gen(M8 衰减锚点)兜底。防"旧版 db.ts 内联建空库
  // → hasData=0 跳 ensureSchema migration → 缺列"的窄边界。有数据的库走 v29 migration 补,
  // 此处是 getClientDb 路径与内联 schema 的双保险。
  safeAlterAddColumn(tmpDb, "ALTER TABLE nodes ADD COLUMN edit_seq INTEGER NOT NULL DEFAULT 0")
  safeAlterAddColumn(tmpDb, "ALTER TABLE nodes ADD COLUMN decay_gen INTEGER NOT NULL DEFAULT 0")
  safeAlterAddColumn(tmpDb, "ALTER TABLE links ADD COLUMN edit_seq INTEGER NOT NULL DEFAULT 0")
  safeAlterAddColumn(tmpDb, "ALTER TABLE links ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")

  // 审计三轮:operation_log(v28)+ pending_digests(v20)的内联漏列兜底,防"旧版内联建空库 →
  // hasData=0 跳 migration"缺列导致 recall/digest/stale-recovery 崩。
  safeAlterAddColumn(tmpDb, "ALTER TABLE operation_log ADD COLUMN exact_count INTEGER")
  safeAlterAddColumn(tmpDb, "ALTER TABLE operation_log ADD COLUMN related_count INTEGER")
  safeAlterAddColumn(tmpDb, "ALTER TABLE operation_log ADD COLUMN fallback_chain TEXT")
  safeAlterAddColumn(tmpDb, "ALTER TABLE operation_log ADD COLUMN vector_unavailable INTEGER")
  safeAlterAddColumn(tmpDb, "ALTER TABLE pending_digests ADD COLUMN processing_started_at TEXT")

  tmpDb.close()

  // 统一的读写连接
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')

  // Cloud sync 的本地 outbox/dead-letter 表。放在核心 schema 之后而不是
  // core schema 里,是因为 outbox 属于客户端 sync 基础设施。
  createOutboxTable(db)

  return db
}

export function closeClientDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export { getDataDir }
