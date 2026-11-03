import { sanitizeAgentIntegrationEventPersistence } from './agent-integration-event-sanitizer.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const AGENT_IDENTITY_BINDING_SQL = `
CREATE TABLE IF NOT EXISTS agent_identity_bindings (
  id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL UNIQUE,
  canonical_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_identity_binding_members (
  installation_id TEXT PRIMARY KEY REFERENCES agent_installations(id),
  binding_id TEXT NOT NULL REFERENCES agent_identity_bindings(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_identity_binding_members_binding
  ON agent_identity_binding_members(binding_id);
`;

interface Installation {
  id: string; agent_id: string | null; family: string; host_variant: string;
  runtime_realm: string; config_root: string | null; profile_id: string;
  os_user_identity: string | null; install_key: string;
  desired_state: string; tombstoned_at: string | null; bridge_state?: string | null;
}
export interface ResolvedAgentIdentity {
  installationAgentId: string;
  canonicalAgentId: string;
  bindingId: string | null;
  bindingGeneration: number | null;
}

function installation(db: Database.Database, id: string): Installation {
  const row = db.prepare('SELECT * FROM agent_installations WHERE id = ?').get(id) as Installation | undefined;
  if (!row?.agent_id) throw new Error('Installation identity is missing');
  return row;
}

/** Config roots must already be canonicalized by discovery; no filesystem writes. */
export function agentIdentityDomainKey(row: Installation): string {
  if (row.family !== 'codex' || !['codex-cli', 'codex-desktop'].includes(row.host_variant) || !row.config_root) {
    throw new Error('Shared identity requires a discovered Codex configuration domain');
  }
  return createHash('sha256').update(JSON.stringify([
    row.family, row.runtime_realm, row.os_user_identity, row.config_root, row.profile_id || 'default',
  ])).digest('hex');
}

export function resolveInstallationAgentIdentity(db: Database.Database, installationId: string): ResolvedAgentIdentity {
  const row = installation(db, installationId);
  const binding = db.prepare(`SELECT b.* FROM agent_identity_binding_members m
    JOIN agent_identity_bindings b ON b.id = m.binding_id WHERE m.installation_id = ?`).get(installationId) as
    { id: string; domain_key: string; canonical_agent_id: string; generation: number } | undefined;
  if (binding && binding.domain_key !== agentIdentityDomainKey(row)) throw new Error('Shared identity domain changed; re-confirm the binding');
  return { installationAgentId: row.agent_id!, canonicalAgentId: binding?.canonical_agent_id ?? row.agent_id!,
    bindingId: binding?.id ?? null, bindingGeneration: binding?.generation ?? null };
}

/** Frozen input for a trusted adoption/confirmation flow, not a public IPC setter. */
export interface ConfirmSharedIdentityInput {
  id: string;
  canonicalAgentId: string;
  evidenceHash: string;
  members: readonly { installationId: string; installationAgentId: string; installKey: string; domainKey: string }[];
  confirmedAt: string;
}

export function confirmSharedAgentIdentity(db: Database.Database, input: ConfirmSharedIdentityInput): void {
  if (!/^[a-f0-9]{64}$/i.test(input.evidenceHash) || input.members.length !== 2
    || new Set(input.members.map(m => m.installationId)).size !== 2) throw new Error('Shared identity evidence or members are invalid');
  db.transaction(() => {
    const agent = db.prepare('SELECT archived FROM agents WHERE id = ?').get(input.canonicalAgentId) as { archived: number } | undefined;
    if (!agent || agent.archived !== 0) throw new Error('Canonical Agent is not active');
    const rows = input.members.map(member => {
      const row = installation(db, member.installationId);
      if (row.agent_id !== member.installationAgentId || row.install_key !== member.installKey
        || agentIdentityDomainKey(row) !== member.domainKey || row.tombstoned_at) {
        throw new Error('Shared identity confirmation is stale or requires managed migration');
      }
      return row;
    });
    if (new Set(rows.map(r => r.host_variant)).size !== 2
      || new Set(rows.map(agentIdentityDomainKey)).size !== 1) throw new Error('Installations do not share one Codex domain');
    const outsideOwner = db.prepare('SELECT id FROM agent_installations WHERE agent_id=? AND id NOT IN (?,?)')
      .get(input.canonicalAgentId, rows[0].id, rows[1].id);
    const outsideAlias = db.prepare("SELECT installation_id FROM agent_aliases WHERE alias_type='legacy_agent_id' AND alias_value=? AND runtime_realm=? AND installation_id NOT IN (?,?)")
      .get(input.canonicalAgentId, rows[0].runtime_realm, rows[0].id, rows[1].id);
    if (outsideOwner || outsideAlias) throw new Error('Canonical identity is already owned by another Installation');
    const domainKey = agentIdentityDomainKey(rows[0]);
    const previous = db.prepare('SELECT * FROM agent_identity_bindings WHERE domain_key = ?').get(domainKey) as
      { id: string; canonical_agent_id: string; evidence_hash: string } | undefined;
    if (previous) {
      const members = db.prepare('SELECT installation_id FROM agent_identity_binding_members WHERE binding_id = ? ORDER BY installation_id').all(previous.id) as Array<{ installation_id: string }>;
      if (previous.id !== input.id || previous.canonical_agent_id !== input.canonicalAgentId || previous.evidence_hash !== input.evidenceHash
        || JSON.stringify(members.map(m => m.installation_id)) !== JSON.stringify(input.members.map(m => m.installationId).sort())) {
        throw new Error('Shared identity already exists with different evidence');
      }
      return;
    }
    if (rows.some(row => row.desired_state !== 'unmanaged')) throw new Error('Managed identity requires a coordinated migration');
    db.prepare(`INSERT INTO agent_identity_bindings(id,domain_key,canonical_agent_id,generation,evidence_hash,created_at,updated_at)
      VALUES (?,?,?,1,?,?,?)`).run(input.id, domainKey, input.canonicalAgentId, input.evidenceHash, input.confirmedAt, input.confirmedAt);
    for (const row of rows) db.prepare('INSERT INTO agent_identity_binding_members(installation_id,binding_id) VALUES (?,?)').run(row.id, input.id);
    // Installation IDs, old Agent IDs, ownership, consent and verified status are
    // intentionally unchanged. The caller must subsequently reconcile artifacts.
  }).immediate();
}


export interface SharedAgentConsumers {
  bindingId: string;
  generation: number;
  consumers: Installation[];
}

export function getSharedAgentConsumers(db: Database.Database, canonicalAgentId: string): SharedAgentConsumers | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_identity_bindings'").get()) return null;
  const binding = db.prepare('SELECT * FROM agent_identity_bindings WHERE canonical_agent_id = ?').get(canonicalAgentId) as
    { id: string; generation: number; domain_key: string } | undefined;
  if (!binding) return null;
  const rows = db.prepare(`SELECT i.* FROM agent_identity_binding_members m
    JOIN agent_installations i ON i.id=m.installation_id WHERE m.binding_id=? ORDER BY i.id`).all(binding.id) as Installation[];
  for (const row of rows) {
    if (row.desired_state !== 'removed' && !row.tombstoned_at && agentIdentityDomainKey(row) !== binding.domain_key) {
      throw new Error('Shared identity domain changed');
    }
  }
  return { bindingId: binding.id, generation: binding.generation, consumers: rows };
}


/** Domain-only receipt key; never identifies a particular consuming host. */
export function sharedAgentActivityKey(bindingId: string, generation: number, component: string, signal: string, token: string): string {
  return sanitizeAgentIntegrationEventPersistence({
    kind: 'shared_agent_activity',
    dedupeKey: `shared:${bindingId}:${generation}:${component}:${signal}:${createHash('sha256').update(token).digest('hex')}`,
    payload: {},
  }).dedupeKey!;
}
