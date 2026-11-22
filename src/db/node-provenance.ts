import type Database from 'better-sqlite3';

/**
 * Authoritative origin of a memory. `source_tool` on the node is whatever the
 * model typed; this row is derived from the configured Agent identity and the
 * process that actually made the call. Local only: it is not synchronised.
 */
export const NODE_PROVENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS node_provenance (
  node_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  caller_installation_id TEXT,
  caller_level TEXT NOT NULL DEFAULT 'unidentified',
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_provenance_kind ON node_provenance(source_kind);
CREATE TRIGGER IF NOT EXISTS node_provenance_node_deleted AFTER DELETE ON nodes
BEGIN DELETE FROM node_provenance WHERE node_id = OLD.id; END;
`;

export interface DigestCaller {
  installationId: string | null;
  level: 'verified' | 'inferred' | 'unidentified';
}

function hasTable(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_provenance'").get());
}

/** Best effort; the first origin of a node is kept when later digests merge into it. */
export function recordNodeProvenance(
  db: Database.Database, nodeId: string, agentId: string | undefined, caller?: DigestCaller,
): void {
  if (!agentId) return;
  try {
    if (!hasTable(db)) return;
    // Only a verified caller overrides the configured identity as the origin.
    const family = caller?.installationId && caller.level === 'verified'
      ? (db.prepare('SELECT family FROM agent_installations WHERE id=?').get(caller.installationId) as { family: string } | undefined)?.family
      : undefined;
    const kind = family
      ?? (db.prepare('SELECT tool_type FROM agents WHERE id=?').get(agentId) as { tool_type: string } | undefined)?.tool_type
      ?? (db.prepare('SELECT family FROM agent_installations WHERE agent_id=?').get(agentId) as { family: string } | undefined)?.family;
    if (!kind) return;
    db.prepare(`INSERT OR IGNORE INTO node_provenance(node_id,agent_id,source_kind,caller_installation_id,caller_level,created)
      VALUES (?,?,?,?,?,?)`).run(nodeId, agentId, kind, caller?.installationId ?? null, caller?.level ?? 'unidentified', new Date().toISOString());
  } catch { /* accounting never fails a digest */ }
}

/** Product names users filter by that differ from the stored family id. */
const SOURCE_KIND_ALIASES: Readonly<Record<string, readonly string[]>> = { devin: ['windsurf'], 'devin-desktop': ['windsurf'], antigravity: ['antigravity'] };
export function expandSourceKinds(kinds: readonly string[]): string[] {
  return [...new Set(kinds.flatMap(kind => [kind, ...(SOURCE_KIND_ALIASES[kind.toLowerCase()] ?? [])]))];
}

/** Node ids whose recorded origin is one of the requested kinds. */
export function provenanceNodeIds(db: Database.Database, kinds: readonly string[]): Set<string> {
  try {
    if (!kinds.length || !hasTable(db)) return new Set();
    const expanded = expandSourceKinds(kinds);
    return new Set((db.prepare(`SELECT node_id FROM node_provenance WHERE source_kind IN (${expanded.map(() => '?').join(',')})`)
      .all(...expanded) as Array<{ node_id: string }>).map(row => row.node_id));
  } catch {
    return new Set();
  }
}
