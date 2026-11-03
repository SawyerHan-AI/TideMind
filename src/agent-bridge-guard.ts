import { getSharedAgentConsumers, type SharedAgentConsumers } from './db/agent-identity-binding.js';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Tide Mind bridge generation guard (adaptive compatibility design §3.5).
 *
 * Applies only to entries that carry both an Agent identity and an activity
 * generation token — i.e. entries written by a Tide Mind version that binds them
 * to a managed Installation. Such an entry stops receiving memory when its
 * Installation was removed/tombstoned, when the Tide Mind side of the bridge was
 * stopped, when the host's source was definitively rejected, or when its exact
 * component projection generation was replaced. Admission database failures
 * stop bound entries; they never imply a legacy installation.
 *
 * Deliberately NOT guarded: entries without EB_AGENT_ID or without a generation
 * token (older scripts cannot be claimed protected by a guard they never call),
 * unknown agents (the legacy `agents` table), and `desired_state = 'unmanaged'`
 * Installations (legacy_callable_unmanaged keeps working). A paused Installation
 * (`disabled`) keeps its bridge: pausing maintenance is not deactivation.
 */

export type BridgeRejectionReason =
  | 'installation_removed'
  | 'installation_tombstoned'
  | 'bridge_stopped'
  | 'source_rejected'
  | 'guard_unavailable'
  | 'activity_generation_mismatch';

export type BridgeAdmission =
  | { allowed: true }
  | { allowed: false; reason: BridgeRejectionReason };

/** Mirrors `isDefinitiveSourceRejection` in the Electron runtime compatibility module. */
const DEFINITIVE_SOURCE_REJECTIONS: ReadonlySet<string> = new Set([
  'release_entry_missing',
  'release_mode_detect_only',
  'release_distribution_not_accepted',
  'source_not_official',
]);

interface GuardRow {
  id: string;
  desired_state: string;
  tombstoned_at: string | null;
  bridge_state?: string | null;
  eligibility_reason: string | null;
}

function readGuardRow(db: Database.Database, agentId: string): GuardRow | undefined {
  const eligibility = `json_extract(
    CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
    '$.managementEligibility.reason'
  ) AS eligibility_reason`;
  // An absent ledger is a known legacy database, not a failed admission query.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_installations'").get()) return undefined;
  const columns = db.prepare('PRAGMA table_info(agent_installations)').all() as Array<{ name: string }>;
  const bridgeColumn = columns.some(column => column.name === 'bridge_state') ? 'bridge_state,' : '';
  return db.prepare(`
    SELECT id, desired_state, tombstoned_at, ${bridgeColumn} ${eligibility}
    FROM agent_installations WHERE agent_id = ? LIMIT 1
  `).get(agentId) as GuardRow | undefined;
}

export function evaluateBridgeAdmission(
  db: Database.Database,
  input: { agentId: string | null | undefined; activityGenerationToken: string | null | undefined; componentKey?: 'memory_tools' | 'lifecycle' },
): BridgeAdmission {
  const agentId = input.agentId?.trim();
  const token = input.activityGenerationToken?.trim();
  if (!agentId || !token) return { allowed: true };
  let row: GuardRow | undefined;
  try {
    const shared = getSharedAgentConsumers(db, agentId);
    if (shared) return evaluateSharedBridgeAdmission(db, shared, token, input.componentKey ?? 'memory_tools');
    row = readGuardRow(db, agentId);
  } catch {
    // Locked, closed or malformed managed ledgers cannot prove admission.
    return { allowed: false, reason: 'guard_unavailable' };
  }
  if (!row || row.desired_state === 'unmanaged') return { allowed: true };
  if (row.desired_state === 'removed') return { allowed: false, reason: 'installation_removed' };
  if (row.tombstoned_at !== null) return { allowed: false, reason: 'installation_tombstoned' };
  if (row.bridge_state === 'stopped') return { allowed: false, reason: 'bridge_stopped' };
  if (row.eligibility_reason && DEFINITIVE_SOURCE_REJECTIONS.has(row.eligibility_reason)) {
    return { allowed: false, reason: 'source_rejected' };
  }
  try {
    // Mirror the projection generation selection used by the coordinator. A
    // pending preview must not revoke the last applied carrier; a successful
    // replacement does. Bind the component as hooks and MCP may upgrade apart.
    const generation = db.prepare(`
      SELECT json_extract(prepared_plan_json, '$.activityGenerationToken') AS token,
             json_extract(prepared_plan_json, '$.executionPlan.activityGenerationTokenHash') AS hash
      FROM reconcile_runs
      WHERE installation_id = ? AND operation_type != 'disconnect'
        AND state IN ('applied_unverified','verified','committed')
        -- A confirmed disconnect revokes earlier carriers even while reconnect
        -- has reopened the Installation but has not applied its new projection.
        AND rowid > COALESCE((
          SELECT MAX(disconnected.rowid) FROM reconcile_runs disconnected
          WHERE disconnected.installation_id = ? AND disconnected.operation_type = 'disconnect'
        ), 0)
        AND EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(prepared_plan_json) THEN prepared_plan_json ELSE '{}' END,
            '$.componentKeys'
          ) component WHERE component.value = ?
        )
      ORDER BY rowid DESC LIMIT 1
    `).get(row.id, row.id, input.componentKey ?? 'memory_tools') as { token: string; hash: string } | undefined;
    const expectedHash = createHash('sha256').update(JSON.stringify(token)).digest('hex');
    if (!generation || generation.token !== token || generation.hash !== expectedHash) {
      return { allowed: false, reason: 'activity_generation_mismatch' };
    }
  } catch {
    return { allowed: false, reason: 'guard_unavailable' };
  }
  return { allowed: true };
}

export const BRIDGE_REJECTED_MESSAGE =
  'Tide Mind 已停止为此 Agent 提供记忆（连接已断开、桥接已停止或宿主来源未通过确认）。请在宿主中移除 Tide Mind 组件，或在 Tide Mind 中重新连接。';


/** Admit the actual shared carrier, not whichever Installation owns an old ID. */
function evaluateSharedBridgeAdmission(db: Database.Database, shared: SharedAgentConsumers, token: string, componentKey: 'memory_tools' | 'lifecycle'): BridgeAdmission {
  const canonical = db.prepare('SELECT a.archived FROM agent_identity_bindings b JOIN agents a ON a.id=b.canonical_agent_id WHERE b.id=?').get(shared.bindingId) as { archived:number } | undefined;
  if (!canonical || canonical.archived !== 0) return { allowed: false, reason: 'installation_removed' };
  const active = shared.consumers.filter(row => row.desired_state !== 'removed' && !row.tombstoned_at);
  if (!active.length) return { allowed: false, reason: 'installation_removed' };
  const hash = createHash('sha256').update(JSON.stringify(token)).digest('hex');
  for (const member of active) {
    const row = readGuardRow(db, member.agent_id!);
    if (!row || row.bridge_state === 'stopped' || (row.eligibility_reason && DEFINITIVE_SOURCE_REJECTIONS.has(row.eligibility_reason))) continue;
    const artifacts = db.prepare(`SELECT a.id, a.owned_fragment_hash FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id=c.artifact_id
      JOIN installation_components component ON component.installation_id=c.installation_id
        AND component.component_key=c.component_key AND component.artifact_id=a.id
      JOIN agent_consents consent ON consent.id=c.consent_envelope_id AND consent.installation_id=c.installation_id
      WHERE c.installation_id=? AND c.component_key=? AND c.state='active' AND c.tombstoned_at IS NULL
        AND c.desired_state IN ('managed','disabled') AND component.desired_state IN ('managed','disabled')
        AND component.tombstoned_at IS NULL AND consent.status='active'
        AND component.consent_envelope_id=consent.id
        AND consent.id=(SELECT consent_envelope_id FROM agent_installations WHERE id=c.installation_id)
        AND a.state IN ('healthy','paused')`).all(member.id, componentKey) as Array<{id:string;owned_fragment_hash:string|null}>;
    for (const artifact of artifacts) {
      // Read the latest committed physical write across ALL consumers. Filtering
      // by member first would incorrectly resurrect an older shared token.
      const carrier = db.prepare(`SELECT p.after_hash, r.installation_id, r.operation_type, r.state AS run_state, r.failure_code,
          json_extract(r.prepared_plan_json,'$.activityGenerationToken') AS token,
          json_extract(r.prepared_plan_json,'$.executionPlan.activityGenerationTokenHash') AS hash
        FROM projection_mutations p JOIN reconcile_runs r ON r.id=p.run_id
        WHERE p.artifact_id=? AND p.state='committed' AND p.idempotency_strategy != 'consumer_detach_only'
        ORDER BY p.committed_at DESC, p.rowid DESC LIMIT 1`).get(artifact.id) as
        {after_hash:string|null;installation_id:string;operation_type:string;run_state:string;failure_code:string|null;token:string;hash:string}|undefined;
      if (carrier && carrier.operation_type !== 'disconnect' && (['applied_unverified','verified','committed'].includes(carrier.run_state) || (carrier.run_state === 'cancelled' && ['superseded_by_shared_disconnect','superseded_by_same_generation_connect'].includes(carrier.failure_code ?? ''))) && carrier.after_hash !== null
        && carrier.after_hash === artifact.owned_fragment_hash && carrier.token === token && carrier.hash === hash
        && shared.consumers.some(c => c.id === carrier.installation_id)) return { allowed: true };
    }
  }
  return { allowed: false, reason: 'activity_generation_mismatch' };
}
