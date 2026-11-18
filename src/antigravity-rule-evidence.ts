import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getSharedAgentConsumers } from './db/agent-identity-binding.js';

/** A configuration-domain observation, never an App/CLI authentication claim. */
export interface AntigravityRuleState {
  artifactId: string;
  hash: string;
  appliedAt: string;
}

export function isAntigravitySharedAgent(db: Database.Database, agentId: string): boolean {
  const shared = getSharedAgentConsumers(db, agentId);
  return Boolean(shared?.consumers.length && shared.consumers.every(member => member.family === 'antigravity'));
}

/** Read only the exact managed rule, not arbitrary host/user files. */
export function currentAntigravityRule(db: Database.Database, agentId: string): AntigravityRuleState | null {
  const shared = getSharedAgentConsumers(db, agentId);
  if (!shared?.consumers.length || !shared.consumers.every(member => member.family === 'antigravity')) return null;
  const rows = db.prepare(`SELECT DISTINCT a.id, a.target_path, a.owned_fragment_hash, i.config_root,
      (SELECT MAX(p.committed_at) FROM projection_mutations p WHERE p.artifact_id=a.id
        AND p.state='committed' AND p.idempotency_strategy!='consumer_detach_only') AS applied_at
    FROM agent_identity_binding_members member
    JOIN agent_installations i ON i.id=member.installation_id
    JOIN installation_components component ON component.installation_id=i.id AND component.component_key='instruction'
    JOIN artifact_consumers c ON c.installation_id=i.id AND c.component_key='instruction' AND c.artifact_id=component.artifact_id
    JOIN managed_artifacts a ON a.id=c.artifact_id
    JOIN agent_consents consent ON consent.id=i.consent_envelope_id
    WHERE member.binding_id=? AND i.family='antigravity' AND i.tombstoned_at IS NULL
      AND i.desired_state IN ('managed','disabled') AND COALESCE(i.bridge_state,'serving')!='stopped'
      AND consent.status='active' AND component.consent_envelope_id=consent.id AND c.consent_envelope_id=consent.id
      AND component.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
      AND c.state IN ('active','disabled') AND c.desired_state IN ('managed','disabled')
      AND a.state IN ('healthy','paused','needs_recovery') AND a.owned_fragment_hash=a.observed_fragment_hash
  `).all(shared.bindingId) as Array<{id:string;target_path:string;owned_fragment_hash:string;config_root:string;applied_at:string|null}>;
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row.applied_at || !Number.isFinite(Date.parse(row.applied_at))) return null;
  try {
    const expected = path.join(row.config_root, 'rules', 'tidemind.md');
    if (row.target_path !== expected || fs.realpathSync(expected) !== expected) return null;
    const stat = fs.lstatSync(expected);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    // This is TideMind's managed configuration, not a vault/graph note.
    const bytes = fs.readFileSync(expected);
    const after = fs.lstatSync(expected);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return null;
    const hash = createHash('sha256').update(bytes).digest('hex');
    return hash === row.owned_fragment_hash ? { artifactId:row.id, hash, appliedAt:row.applied_at } : null;
  } catch { return null; }
}
