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
