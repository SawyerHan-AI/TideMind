/**
 * db/schema.ts 单元测试
 *
 * Schema 版本管理、幂等性、表结构验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_s: string, _p: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}));

import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';

function freshDb(): Database.Database {
  return new Database(':memory:');
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : -1;
  } catch {
    return -1;
  }
}

function getTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

function getIndexNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

// ===== ensureSchema 基础 =====

describe('ensureSchema 基础', () => {
  it('全新数据库创建所有表', () => {
    const db = freshDb();
    ensureSchema(db);

    const tables = getTableNames(db);

    const expectedTables = [
      'nodes',
      'links',
      'node_versions',
      'operation_log',
      'strategy_feedback',
      'strategy_versions',
      'sync_hashes',
      'metadata',
      'agents',
      'note_sources',
      'llm_usage_log',
      'timeline_events',
      'node_segments',
      'param_feedback',
      'param_adjustments',
      'model_connections',
      'pending_digests',
    ];

    for (const name of expectedTables) {
      expect(tables, `缺少表: ${name}`).toContain(name);
    }
  });

  it('幂等：连续运行两次不报错', () => {
    const db = freshDb();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  it('两次调用后 schema 版本不变', () => {
    const db = freshDb();
    ensureSchema(db);
    const v1 = getSchemaVersion(db);

    ensureSchema(db);
    const v2 = getSchemaVersion(db);

    expect(v1).toBe(v2);
    expect(v1).toBeGreaterThan(0);
  });
});

// ===== 旧空库判定（schema.ts:1866 修复回归测试）=====

/**
 * 模拟"迁移框架引入前安装、但从未写入任何节点"的旧空库：
 * - 有旧版 nodes 表（缺 updated 等后续列）
 * - nodes 行数为 0
 * - metadata 表没有 schema_version
 *
 * 旧实现按 nodes 行数判定会把它误当作全新库直接盖戳 v28，跳过全部 migration，
 * 旧表缺列 → 后续写入永久失败。修复后应识别为旧库并跑全量幂等 migration。
 */
function makeLegacyEmptyDb(): Database.Database {
  const db = new Database(':memory:');
  // 复刻迁移框架引入前（commit 1eb92ad）的最早期 schema：
  // nodes 缺 updated/title/specificity/is_tag/is_superseded 等后续列；
  // links 带已被 v3 删除的 semtype 列；metadata 表存在但没写 schema_version。
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('fact','context','preference','idea','crystal','meta')),
      content TEXT NOT NULL,
      heat REAL DEFAULT 1.0,
      refinement REAL DEFAULT 0.0,
      connectivity REAL DEFAULT 0.0,
      independence REAL DEFAULT 0.0,
      source_tool TEXT,
      source_session TEXT,
      source_stream TEXT,
      source_timestamp TEXT,
      project TEXT,
      tags TEXT,
      created TEXT NOT NULL,
      last_reconsolidated TEXT,
      version INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      is_keystone INTEGER DEFAULT 0,
      maturity_score REAL DEFAULT 0.0
    );
    CREATE TABLE links (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES nodes(id),
      to_id TEXT NOT NULL REFERENCES nodes(id),
      relation TEXT NOT NULL,
      semtype TEXT,
      strength REAL DEFAULT 0.5,
      note TEXT,
      auto INTEGER DEFAULT 1,
      status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','pending')),
      created TEXT NOT NULL
    );
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 注意：metadata 表存在但没有 schema_version 行 → getSchemaVersion 返回 -1
  return db;
}

describe('ensureSchema 旧空库判定', () => {
  it('旧空库（缺 updated 列、0 行、无 schema_version）会跑全量 migration 而非被盖戳', () => {
    const db = makeLegacyEmptyDb();
    expect(getSchemaVersion(db)).toBe(-1);

    ensureSchema(db);

    // 应升级到最新版本
    expect(getSchemaVersion(db)).toBeGreaterThan(0);
    // 旧表缺失的关键列被 migration 补齐
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols, 'nodes.updated 应被 migration 补齐').toContain('updated');
    expect(cols, 'nodes.is_tag 应被 migration 补齐').toContain('is_tag');
    expect(cols, 'nodes.is_superseded 应被 migration 补齐').toContain('is_superseded');
  });

  it('旧空库迁移后可正常写入显式带 updated 列的 INSERT', () => {
    const db = makeLegacyEmptyDb();
    ensureSchema(db);

    expect(() => {
      db.prepare(
        "INSERT INTO nodes (id, type, content, heat, created, updated) VALUES ('n1', 'fact', 'hello world', 1.0, '2024-01-01', '2024-01-01')",
      ).run();
    }).not.toThrow();
  });

  it('全量 migration 后含全新库的所有表（表集合为超集）', () => {
    // 注意：不能要求"完全相等"。notion_sync / notion_pending_relations 由
    // migration v11 创建但从未进 SCHEMA_SQL、也无后续 migration DROP，所以任何
    // 走过全量 migration 的库(含真实老用户升级库)都比全新库多这两张表——这是
    // 框架既有的 fresh-vs-migrated 漂移,与本修复无关。这里只断言"超集 + 版本对齐"。
    const legacy = makeLegacyEmptyDb();
    ensureSchema(legacy);
    const fresh = freshDb();
    ensureSchema(fresh);

    const legacyTables = new Set(getTableNames(legacy));
    for (const t of getTableNames(fresh)) {
      expect(legacyTables, `migration 后缺少全新库的表: ${t}`).toContain(t);
    }
    expect(getSchemaVersion(legacy)).toBe(getSchemaVersion(fresh));
  });

  it('全新库不会被误跑 migration（直接盖戳最新版本）', () => {
    const db = freshDb();
    ensureSchema(db);
    // 全新库被直接标记为最新版本
    const v = getSchemaVersion(db);
    expect(v).toBeGreaterThan(0);
    // 再次运行幂等，不变
    ensureSchema(db);
    expect(getSchemaVersion(db)).toBe(v);
  });
});

// ===== Schema 版本 =====

describe('schema 版本', () => {
  it('新数据库版本 >= 1', () => {
    const db = freshDb();
    ensureSchema(db);
    const version = getSchemaVersion(db);
    expect(version).toBeGreaterThanOrEqual(1);
  });

  it('版本号存储在 metadata 表中', () => {
    const db = freshDb();
    ensureSchema(db);
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
    expect(row).toBeDefined();
    expect(parseInt(row.value, 10)).toBeGreaterThan(0);
  });
});

// ===== 外键约束 =====

describe('外键约束', () => {
  it('links 表的 from_id 外键约束生效', () => {
    const db = freshDb();
    ensureSchema(db);

    expect(() => {
      db.prepare(
        "INSERT INTO links (id, from_id, to_id, relation, created) VALUES ('lk_test', 'nonexistent_from', 'nonexistent_to', '[]', '2024-01-01')",
      ).run();
    }).toThrow(); // FOREIGN KEY constraint failed
  });

  it('node_versions 表的 node_id 外键约束生效', () => {
    const db = freshDb();
    ensureSchema(db);

    expect(() => {
      db.prepare(
        "INSERT INTO node_versions (node_id, version, content, changed_at) VALUES ('nonexistent', 1, 'test', '2024-01-01')",
      ).run();
    }).toThrow();
  });
});

// ===== 索引 =====

describe('索引', () => {
  it('关键索引存在', () => {
    const db = freshDb();
    ensureSchema(db);

    const indexes = getIndexNames(db);

    const expectedIndexes = [
      'idx_links_from',
      'idx_links_to',
      'idx_links_status',
      'idx_nodes_type',
      'idx_nodes_archived',
      'idx_nodes_heat',
      'idx_nodes_keystone',
      'idx_nodes_is_crystal',
      'idx_nodes_is_tag',
      'idx_nodes_is_meta',
      'idx_llm_usage_created',
      'idx_llm_usage_model',
      'idx_timeline_created',
      'idx_timeline_type',
      'idx_strategy_versions_name',
      'idx_param_feedback_strategy',
      'idx_pending_digests_status',
    ];

    for (const name of expectedIndexes) {
      expect(indexes, `缺少索引: ${name}`).toContain(name);
    }
  });
});

// ===== FTS =====

describe('FTS5', () => {
  it('nodes_fts 虚拟表存在', () => {
    const db = freshDb();
    ensureSchema(db);

    // FTS5 虚拟表不在 sqlite_master type='table' 中直接出现，
    // 但可以通过查询验证
    expect(() => {
      db.prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'test' LIMIT 1").all();
    }).not.toThrow();
  });
});
