import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

/** Durable raw data is separate from the replaceable sqlite-vec search projection. */
export function ensureVectorCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_legacy_archive (
      segment_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      node_id TEXT,
      segment_index INTEGER,
      original_input_hash TEXT,
      preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (segment_id, dimensions, vector_hash)
    );
    CREATE TABLE IF NOT EXISTS vector_bundles (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      checksum TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      shareable INTEGER NOT NULL CHECK(shareable IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(node_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS vector_upload_queue (
      account_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL DEFAULT '',
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      checksum TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_after INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id,endpoint_id,node_id,profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vector_upload_due ON vector_upload_queue(account_id,endpoint_id,retry_after);
    CREATE INDEX IF NOT EXISTS idx_vector_remote_receipt_node ON metadata(json_extract(value,'$.nodeId'))
      WHERE key GLOB 'vector.remote_receipt:*' AND json_valid(value);
    CREATE TRIGGER IF NOT EXISTS vector_node_proof_insert AFTER INSERT ON nodes BEGIN
      DELETE FROM metadata WHERE key GLOB 'vector.remote_receipt:*' AND json_valid(value) AND json_extract(value,'$.nodeId')=NEW.id;
      INSERT INTO metadata(key,value) VALUES ('vector.proof_generation:' || NEW.id,lower(hex(randomblob(16))))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    END;
    CREATE TRIGGER IF NOT EXISTS vector_node_proof_update AFTER UPDATE ON nodes
      WHEN OLD.content IS NOT NEW.content OR OLD.title IS NOT NEW.title OR OLD.archived IS NOT NEW.archived
        OR OLD.is_superseded IS NOT NEW.is_superseded OR OLD.edit_seq IS NOT NEW.edit_seq OR OLD.updated IS NOT NEW.updated
    BEGIN
      DELETE FROM metadata WHERE key GLOB 'vector.remote_receipt:*' AND json_valid(value) AND json_extract(value,'$.nodeId')=NEW.id;
      INSERT INTO metadata(key,value) VALUES ('vector.proof_generation:' || NEW.id,lower(hex(randomblob(16))))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    END;
    CREATE TRIGGER IF NOT EXISTS vector_node_proof_delete AFTER DELETE ON nodes BEGIN
      DELETE FROM metadata WHERE key GLOB 'vector.remote_receipt:*' AND json_valid(value) AND json_extract(value,'$.nodeId')=OLD.id;
      DELETE FROM metadata WHERE key='vector.proof_generation:' || OLD.id;
    END;
  `);
  if (!db.prepare("SELECT 1 FROM metadata WHERE key='vector.proof_generations_initialized'").get()) db.transaction(()=>{
    db.exec(`INSERT INTO metadata(key,value) SELECT 'vector.proof_generation:' || id,lower(hex(randomblob(16))) FROM nodes WHERE true ON CONFLICT(key) DO NOTHING`);
    db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('vector.proof_generations_initialized','1')").run();
  }).immediate();
}

/** Requires sqlite-vec loaded. Never assert provenance for these legacy bytes. */
export function preserveLegacyVectorData(db: Database.Database, force = false): number {
  ensureVectorCacheSchema(db);
  const marker = db.prepare("SELECT value FROM metadata WHERE key='vector.legacy_archive_version'").get();
  if (marker && !force) return 0;
  return db.transaction(() => {
    let count = 0;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='nodes_vec'").get()) {
      const rows = db.prepare(`SELECT v.id,v.embedding,s.node_id,s.segment_index,m.value AS original_input_hash
        FROM nodes_vec v LEFT JOIN node_segments s ON s.segment_id=v.id
        LEFT JOIN metadata m ON m.key='vector.input:' || s.node_id
        WHERE (? IS NULL OR v.id > ?) ORDER BY v.id LIMIT 250`);
      const save = db.prepare(`INSERT OR IGNORE INTO vector_legacy_archive
        (segment_id,dimensions,vector_hash,embedding,node_id,segment_index,original_input_hash)
        VALUES (?,?,?,?,?,?,?)`);
      let after: string | null = null;
      while (true) {
        // Finish each bounded read before writing on this SQLite connection.
        const batch = rows.all(after,after) as Array<{ id: string; embedding: Buffer; node_id: string | null; segment_index: number | null; original_input_hash: string | null }>;
        if (!batch.length) break;
        for (const row of batch) {
          if (!Buffer.isBuffer(row.embedding) || row.embedding.length % 4 !== 0) throw new Error('Legacy vector bytes cannot be preserved');
          count += save.run(row.id,row.embedding.length / 4,createHash('sha256').update(row.embedding).digest('hex'),
            row.embedding,row.node_id,row.segment_index,row.original_input_hash).changes;
        }
        after = batch.at(-1)!.id;
      }
    }
    db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('vector.legacy_archive_version','1')").run();
    return count;
  })();
}
