import { latestPhysicalBridgeWrite, readAnchoredAdmission, currentBridgeFileIdentity, codexSourceBlockApplies } from './db/codex-bridge-continuity.js';
import { getSharedAgentConsumers, type SharedAgentConsumers } from './db/agent-identity-binding.js';
import { readServiceProofAdmission } from './db/agent-service-proof.js';
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
  | 'bridge_revalidation_pending'
  | 'managed_fragment_changed'
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
        AND (state IN ('applied_unverified','verified','committed') OR (state='cancelled' AND failure_code='superseded_by_same_generation_repair'))
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
    if ((!generation || generation.token !== token || generation.hash !== expectedHash)
      && !readServiceProofAdmission(db, row.id, input.componentKey ?? 'memory_tools', expectedHash)) {
      return { allowed: false, reason: 'activity_generation_mismatch' };
    }
  } catch {
    return { allowed: false, reason: 'guard_unavailable' };
  }
  return { allowed: true };
}

export function describeBridgeRejection(reason: BridgeRejectionReason): string {
  switch (reason) {
    case 'bridge_revalidation_pending': return 'Tide Mind 正在重新核验当前 Codex 配置和来源，请稍后重试。';
    case 'managed_fragment_changed': return '宿主配置文件自上次核验后发生变化，请等待 Tide Mind 重新读取配置。';
    case 'source_rejected': return 'Tide Mind 无法信任可读取此共享配置的宿主来源，请检查 Agent 对接里的来源信息。';
    case 'installation_removed':
    case 'installation_tombstoned': return 'Tide Mind 与此 Agent 的连接已断开。如需继续使用记忆，请在 Tide Mind 的 Agent 对接中重新连接。';
    case 'bridge_stopped': return 'Tide Mind 已停止为此 Agent 提供记忆。如需恢复，请在 Tide Mind 的 Agent 对接中重新连接。';
    case 'guard_unavailable': return 'Tide Mind 暂时无法读取连接状态，请稍后重试。';
    case 'activity_generation_mismatch': return 'Tide Mind 正在自动恢复此连接，或配置已更新。请稍后重试；若仍不可用，请新开一个会话。';
    default: return BRIDGE_REJECTED_MESSAGE;
  }
}

export const BRIDGE_REJECTED_MESSAGE =
  'Tide Mind 已停止为此 Agent 提供记忆（连接已断开、桥接已停止或宿主来源未通过确认）。请在宿主中移除 Tide Mind 组件，或在 Tide Mind 中重新连接。';


/** Admit the actual shared carrier, not whichever Installation owns an old ID. */
function evaluateSharedBridgeAdmission(db: Database.Database, shared: SharedAgentConsumers, token: string, componentKey: 'memory_tools' | 'lifecycle'): BridgeAdmission {
  const canonical = db.prepare('SELECT a.archived FROM agent_identity_bindings b JOIN agents a ON a.id=b.canonical_agent_id WHERE b.id=?').get(shared.bindingId) as { archived:number } | undefined;
  if (!canonical || canonical.archived !== 0) return { allowed: false, reason: 'installation_removed' };
  const active = shared.consumers.filter(row => row.desired_state !== 'removed' && !row.tombstoned_at);
  if (!active.length) return { allowed: false, reason: 'installation_removed' };
  // These consumers can read the same physical configuration. The caller's
  // shared token cannot distinguish a rejected host from an authorized peer.
  const stillVisible = db.prepare(`SELECT 1 FROM installation_components
    WHERE installation_id = ? AND component_key = ? AND visibility_state = 'shared_visible' LIMIT 1`);
  const rejected = shared.consumers.some(member => {
    const row = readGuardRow(db, member.agent_id!);
    if (!row?.eligibility_reason || !DEFINITIVE_SOURCE_REJECTIONS.has(row.eligibility_reason)) return false;
    return (member.desired_state !== 'removed' && !member.tombstoned_at)
      || Boolean(stillVisible.get(member.id, componentKey));
  });
  if (rejected) {
    return { allowed: false, reason: 'source_rejected' };
  }
  const hash = createHash('sha256').update(JSON.stringify(token)).digest('hex');
  if (codexSourceBlockApplies(db,shared.bindingId,componentKey,hash)) return {allowed:false,reason:'source_rejected'};
  let localReason: BridgeRejectionReason = 'activity_generation_mismatch';
  for (const member of active) {
    const row = readGuardRow(db, member.agent_id!);
    if (!row || row.bridge_state === 'stopped' || (row.eligibility_reason && DEFINITIVE_SOURCE_REJECTIONS.has(row.eligibility_reason))) continue;
    const artifacts = db.prepare(`SELECT a.id, a.owned_fragment_hash, a.state FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id=c.artifact_id
      JOIN installation_components component ON component.installation_id=c.installation_id
        AND component.component_key=c.component_key AND component.artifact_id=a.id
      JOIN agent_consents consent ON consent.id=c.consent_envelope_id AND consent.installation_id=c.installation_id
      WHERE c.installation_id=? AND c.component_key=? AND c.state='active' AND c.tombstoned_at IS NULL
        AND c.desired_state IN ('managed','disabled') AND component.desired_state IN ('managed','disabled')
        AND component.tombstoned_at IS NULL AND consent.status='active'
        AND component.consent_envelope_id=consent.id
        AND consent.id=(SELECT consent_envelope_id FROM agent_installations WHERE id=c.installation_id)
        AND a.state IN ('healthy','paused','needs_recovery')`).all(member.id, componentKey) as Array<{id:string;owned_fragment_hash:string|null;state:string}>;
    for (const artifact of artifacts) {
      const anchored = readAnchoredAdmission(db, shared.bindingId, artifact.id, componentKey, member.id, hash);
      if (anchored === true) return { allowed: true };
      if (anchored === false) {
        const current = latestPhysicalBridgeWrite(db,artifact.id);
        if (current?.token_hash === hash && current.token === token) {
          const proof = db.prepare(`SELECT a.target_path,p.file_identity FROM codex_bridge_anchors a
            JOIN codex_bridge_member_proofs p USING(binding_id,artifact_id,component_key)
            WHERE a.binding_id=? AND a.artifact_id=? AND a.component_key=? AND p.installation_id=?`)
            .get(shared.bindingId,artifact.id,componentKey,member.id) as {target_path:string;file_identity:string} | undefined;
          localReason = proof && proof.file_identity !== currentBridgeFileIdentity(proof.target_path)
            ? 'managed_fragment_changed' : 'bridge_revalidation_pending';
        }
        continue;
      }
      if (artifact.state === 'needs_recovery') continue;
      const memberHealth = db.prepare('SELECT health_state FROM agent_installations WHERE id=?').get(member.id) as {health_state:string};
      if (memberHealth.health_state !== 'discovered' || row.eligibility_reason === 'source_verification_pending') continue;
      const observedChange = db.prepare('SELECT last_run_rowid AS cutoff FROM codex_bridge_invalidations WHERE installation_id=?')
        .get(member.id) as {cutoff:number} | undefined;
      if (observedChange && !db.prepare(`SELECT 1 FROM reconcile_runs WHERE installation_id=? AND rowid>?
        AND operation_type IN ('connect','repair') AND state IN ('applied_unverified','verified','committed')
        AND json_extract(prepared_plan_json,'$.activityGenerationToken')=?
        AND EXISTS(SELECT 1 FROM json_each(prepared_plan_json,'$.componentKeys') WHERE value=?)`)
        .get(member.id,observedChange.cutoff,token,componentKey)) {
        if (latestPhysicalBridgeWrite(db,artifact.id)?.token_hash === hash) localReason = 'bridge_revalidation_pending';
        continue;
      }
      // Read the latest committed physical write across ALL consumers. Filtering
      // by member first would incorrectly resurrect an older shared token.
      const carrier = latestPhysicalBridgeWrite(db, artifact.id);
      // Retiring a proved run need not remove its shared physical configuration.
      // Admission still requires a current consumer/consent and this latest write.
      if (carrier && carrier.operation_type !== 'disconnect' && (['applied_unverified','verified','committed'].includes(carrier.run_state) || (carrier.run_state === 'cancelled' && ['superseded_by_shared_disconnect','superseded_by_same_generation_connect','superseded_by_same_generation_repair','superseded_by_confirmed_generation','superseded_by_disconnect'].includes(carrier.failure_code ?? ''))) && carrier.after_hash !== null
        && carrier.after_hash === artifact.owned_fragment_hash && carrier.token === token && carrier.token_hash === hash
        && shared.consumers.some(c => c.id === carrier.installation_id)) return { allowed: true };
    }
  }
  return { allowed: false, reason: localReason };
}
