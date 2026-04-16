import type Database from 'better-sqlite3';
import { createLogger } from '../../../src/utils/logger.js';
import { generateId } from '../../../src/utils/id.js';

const log = createLogger('cloud-outbox');

export interface OutboxItem {
  id: string;
  operation: string;
  payload: string; // JSON
  source: string | null;
  created: string;
  retry_count: number;
}

export function createOutboxTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_outbox (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER DEFAULT 0
  )`);
}

export function enqueueOutbox(db: Database.Database, operation: string, payload: object, source?: string): string {
  const id = generateId();
  db.prepare('INSERT INTO local_outbox (id, operation, payload, source) VALUES (?, ?, ?, ?)').run(id, operation, JSON.stringify(payload), source ?? null);
  log.info(`enqueued ${operation} id=${id}`);
  return id;
}

export function getOutboxItems(db: Database.Database, limit: number = 50): OutboxItem[] {
  return db.prepare('SELECT * FROM local_outbox ORDER BY created ASC LIMIT ?').all(limit) as OutboxItem[];
}

export function removeOutboxItem(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM local_outbox WHERE id = ?').run(id);
}

export function getOutboxCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as cnt FROM local_outbox').get() as { cnt: number }).cnt;
}
