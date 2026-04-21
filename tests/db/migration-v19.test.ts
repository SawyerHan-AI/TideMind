/**
 * Migration v19 单测：links.status CHECK 约束扩展允许 rejected_by_user
 *
 * 策略：makeDb 建最新 schema（v19 CHECK 已扩展）。对于"已经是 v19"的库，
 * 迁移 probe 应识别并跳过。对于"旧 CHECK"的库，模拟方法是手动 DROP + 重建
 * 旧 schema，然后降级版本重跑 ensureSchema。
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

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

/** 把 links 表重建为 v17 时的 CHECK 约束（仅 confirmed/pending） */
function downgradeLinksToV17Check(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS links');
  db.exec(`
    CREATE TABLE links (
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
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status)');
  db.prepare("UPDATE metadata SET value = '17' WHERE key = 'schema_version'").run();
}

function seedLink(
  db: Database.Database,
  id: string,
  fromId: string,
  toId: string,
  status: 'confirmed' | 'pending',
): void {
  db.prepare(`
    INSERT INTO links (id, from_id, to_id, relation, strength, status, created)
    VALUES (?, ?, ?, ?, 0.5, ?, datetime('now'))
  `).run(id, fromId, toId, JSON.stringify([{ type: 'tagged', confidence: 0.9 }]), status);
}

function seedNode(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO nodes (id, type, content, created) VALUES (?, 'fact', ?, datetime('now'))
  `).run(id, `content ${id}`);
}

describe('Migration v19 — links.status CHECK 扩展 rejected_by_user', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('新库直接建 v19，rejected_by_user 可直接插入', () => {
    seedNode(db, 'n1');
    seedNode(db, 'n2');
    expect(() => {
      db.prepare(`
        INSERT INTO links (id, from_id, to_id, relation, strength, status, created)
        VALUES ('l1', 'n1', 'n2', ?, 0, 'rejected_by_user', datetime('now'))
      `).run(JSON.stringify([{ type: 'tagged', confidence: 0.9 }]));
    }).not.toThrow();
  });

  it('从 v17 升级：老 CHECK 被重建，老数据保留，新 status 可插入', () => {
    seedNode(db, 'n1');
    seedNode(db, 'n2');
    seedNode(db, 'n3');
    downgradeLinksToV17Check(db);
    seedLink(db, 'l_confirmed', 'n1', 'n2', 'confirmed');
    seedLink(db, 'l_pending', 'n2', 'n3', 'pending');

    // 此时尝试插 rejected_by_user 应失败（仍是 v17 CHECK）
    expect(() => {
      db.prepare(`
        INSERT INTO links (id, from_id, to_id, relation, strength, status, created)
        VALUES ('l_reject_pre', 'n1', 'n3', '[]', 0, 'rejected_by_user', datetime('now'))
      `).run();
    }).toThrow();

    // 触发迁移
    ensureSchema(db);

    // 老数据保留
    const confirmedRow = db.prepare("SELECT status FROM links WHERE id = 'l_confirmed'").get() as { status: string } | undefined;
    const pendingRow = db.prepare("SELECT status FROM links WHERE id = 'l_pending'").get() as { status: string } | undefined;
    expect(confirmedRow?.status).toBe('confirmed');
    expect(pendingRow?.status).toBe('pending');

    // rejected_by_user 现在可插入
    expect(() => {
      db.prepare(`
        INSERT INTO links (id, from_id, to_id, relation, strength, status, created)
        VALUES ('l_reject', 'n1', 'n3', ?, 0, 'rejected_by_user', datetime('now'))
      `).run(JSON.stringify([{ type: 'tagged', confidence: 0.9 }]));
    }).not.toThrow();

    // 索引仍然存在
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='links'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_links_from');
    expect(names).toContain('idx_links_to');
    expect(names).toContain('idx_links_status');
  });

  it('幂等：二次触发 v19 识别已扩展的 CHECK 并跳过重建', () => {
    // 第一次触发（new DB 本身已是 v19，probe 直接跳过）
    const linksSqlBefore = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='links'",
    ).get() as { sql: string }).sql;

    // 人为把版本降回 17，再跑 ensureSchema
    db.prepare("UPDATE metadata SET value = '17' WHERE key = 'schema_version'").run();
    ensureSchema(db);

    const linksSqlAfter = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='links'",
    ).get() as { sql: string }).sql;

    // SQL 定义不变（probe 已识别为跳过）
    expect(linksSqlAfter).toBe(linksSqlBefore);

    // 版本已刷新到最新
    const version = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
    expect(parseInt(version.value, 10)).toBeGreaterThanOrEqual(18);
  });
});
