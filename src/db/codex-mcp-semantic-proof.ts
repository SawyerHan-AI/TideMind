import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  captureCodexReadbackAnchor, currentBridgeFileIdentity, currentCodexMemberSurface,
  type BridgeAnchor,
} from './codex-bridge-physical.js';
import { resolveInstallationAgentIdentity } from './agent-identity-binding.js';

export const CODEX_MCP_PROOF_VERSION = 1;
export interface CodexMcpProofScope {
  bindingId: string;
  artifactId: string;
  installationId: string;
  tokenHash: string;
}
export interface CodexMcpProofRow {
  binding_id: string;
  artifact_id: string;
  component_key: 'memory_tools';
  installation_id: string;
  binding_generation: number;
  mutation_id: string;
  journal_version: number;
  anchor_fingerprint: string;
  proof_version: number;
  evidence_phase: 'collected' | 'active';
  layout_kind: 'exact' | 'equivalent';
  collection_epoch: string;
  observed_fragment_hash: string;
  semantic_hash: string;
  container_hash: string;
  file_identity: string;
  consent_id: string;
  intent_revision: number;
  surface_fingerprint: string;
  source_fingerprint: string;
  observed_at: string;
}
export interface CodexMcpProofCore {
  row: CodexMcpProofRow;
  anchor: BridgeAnchor;
}

const hashPattern = /^[a-f0-9]{64}$/u;
export function codexAnchorFingerprint(anchor: BridgeAnchor): string {
  return createHash('sha256').update(JSON.stringify([
    anchor.binding_id, anchor.artifact_id, anchor.component_key, anchor.binding_generation,
    anchor.mutation_id, anchor.journal_version, anchor.target_path, anchor.ownership_key,
    anchor.selector_schema_version, anchor.fragment_hash, anchor.token_hash,
  ])).digest('hex');
}

export function hasCodexMcpSemanticProofTable(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_mcp_semantic_member_proofs'").get());
}

/** A layout proof may explain only this component's derived attention.
 * Identity conflicts remain inaccessible/paused; other unhealthy components
 * and missing attribution are not silently dismissed by a historical event.
 */
export function codexMcpLayoutAttentionIsExplainable(db: Database.Database, installationId: string, artifactId: string): boolean {
  const member = db.prepare(`SELECT status_reason, reconcile_state, desired_state, health_state
    FROM agent_installations WHERE id=? AND family='codex' AND host_variant IN ('codex-cli','codex-desktop')`)
    .get(installationId) as { status_reason: string | null; reconcile_state: string; desired_state: string; health_state: string } | undefined;
  if (!member || member.health_state !== 'discovered') return false;
  if (!['conflict', 'permission'].includes(member.status_reason ?? '')) return true;
  if (member.reconcile_state === 'paused' && member.desired_state !== 'disabled') return false;
  if (db.prepare(`SELECT 1 FROM installation_components c JOIN managed_artifacts a ON a.id=c.artifact_id
    WHERE c.installation_id=? AND c.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
      AND a.id!=? AND a.state NOT IN ('healthy','removed') LIMIT 1`).get(installationId, artifactId)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM agent_integration_events e
    WHERE e.artifact_id=? AND e.kind IN ('artifact_drifted','artifact_inaccessible') LIMIT 1`).get(artifactId));
}

function validShape(row: CodexMcpProofRow): boolean {
  return row.proof_version === CODEX_MCP_PROOF_VERSION && row.component_key === 'memory_tools'
    && ['collected', 'active'].includes(row.evidence_phase) && ['exact', 'equivalent'].includes(row.layout_kind)
    && (row.evidence_phase !== 'active' || row.layout_kind === 'equivalent')
    && typeof row.collection_epoch === 'string' && row.collection_epoch.length > 0
    && typeof row.file_identity === 'string' && row.file_identity.startsWith('v2:')
    && Number.isSafeInteger(row.binding_generation) && row.binding_generation > 0
    && Number.isSafeInteger(row.journal_version) && row.journal_version >= 4
    && Number.isSafeInteger(row.intent_revision) && row.intent_revision >= 0
    && typeof row.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.observed_at)
    && Number.isFinite(Date.parse(row.observed_at))
    && [row.anchor_fingerprint, row.observed_fragment_hash, row.semantic_hash, row.container_hash,
      row.surface_fingerprint, row.source_fingerprint].every(value => typeof value === 'string' && hashPattern.test(value));
}

/** Validates a stored fact but deliberately never checks or grants global admission.
 * Only the activation coordinator is allowed to request collected evidence.
 */
function readCore(db: Database.Database, scope: CodexMcpProofScope, epoch: string | null): CodexMcpProofCore | null {
  if (!hasCodexMcpSemanticProofTable(db)) return null;
  const row = db.prepare(`SELECT p.* FROM codex_mcp_semantic_member_proofs p
    JOIN agent_installations i ON i.id=p.installation_id
    JOIN agent_identity_binding_members m ON m.installation_id=i.id AND m.binding_id=p.binding_id
    JOIN agent_identity_bindings b ON b.id=m.binding_id AND b.generation=p.binding_generation
    JOIN agents agent ON agent.id=b.canonical_agent_id AND agent.archived=0
    JOIN agent_consents s ON s.id=p.consent_id AND s.installation_id=i.id AND s.status='active'
    JOIN artifact_consumers c ON c.installation_id=i.id AND c.artifact_id=p.artifact_id AND c.component_key=p.component_key
      AND c.consent_envelope_id=s.id AND c.state='active' AND c.tombstoned_at IS NULL
      AND c.desired_state IN ('managed','disabled')
    JOIN installation_components part ON part.installation_id=i.id AND part.artifact_id=c.artifact_id
      AND part.component_key=c.component_key AND part.consent_envelope_id=s.id AND part.tombstoned_at IS NULL
      AND part.desired_state IN ('managed','disabled')
    JOIN managed_artifacts a ON a.id=p.artifact_id AND a.observed_fragment_hash=p.observed_fragment_hash
      AND a.state IN ('healthy','paused','needs_recovery','drifted')
    LEFT JOIN metadata preference ON preference.key='agent_connection_intent:codex:' || b.domain_key
    WHERE p.binding_id=? AND p.artifact_id=? AND p.installation_id=? AND p.component_key='memory_tools'
      AND i.family='codex' AND i.host_variant IN ('codex-cli','codex-desktop')
      AND i.consent_envelope_id=s.id AND i.tombstoned_at IS NULL AND i.bridge_state!='stopped'
      AND i.desired_state IN ('managed','disabled') AND i.health_state='discovered'
      AND p.intent_revision=COALESCE(json_extract(preference.value,'$.revision'),0)
      AND COALESCE(json_extract(preference.value,'$.state'),'active')!='disconnected'
      AND COALESCE(json_extract(CASE WHEN json_valid(i.metadata_json) THEN i.metadata_json END,'$.managementEligibility.reason'),'')
        NOT IN ('source_not_official','release_distribution_not_accepted','release_entry_missing','release_mode_detect_only')
      AND EXISTS (SELECT 1 FROM json_each(s.allowed_components_json) WHERE value='memory_tools')
      AND (p.evidence_phase='active' OR (? IS NOT NULL AND p.evidence_phase='collected' AND p.collection_epoch=?))`)
    .get(scope.bindingId, scope.artifactId, scope.installationId, epoch, epoch) as CodexMcpProofRow | undefined;
  if (!row || !validShape(row) || (epoch === null && row.evidence_phase !== 'active')) return null;
  const identity = resolveInstallationAgentIdentity(db, scope.installationId);
  if (identity.bindingId !== scope.bindingId || identity.bindingGeneration !== row.binding_generation) return null;
  const persisted = db.prepare(`SELECT * FROM codex_bridge_anchors
    WHERE binding_id=? AND artifact_id=? AND component_key='memory_tools'`).get(scope.bindingId, scope.artifactId) as BridgeAnchor | undefined;
  const anchor = captureCodexReadbackAnchor(db, scope.bindingId, scope.artifactId);
  if (!persisted || !anchor || anchor.token_hash !== scope.tokenHash
    || codexAnchorFingerprint(anchor) !== codexAnchorFingerprint(persisted)
    || row.anchor_fingerprint !== codexAnchorFingerprint(anchor)
    || row.mutation_id !== anchor.mutation_id || row.journal_version !== anchor.journal_version
    || row.binding_generation !== anchor.binding_generation
    || (row.layout_kind === 'exact') !== (row.observed_fragment_hash === anchor.fragment_hash)
    || row.surface_fingerprint !== currentCodexMemberSurface(db, scope.installationId)
    || row.file_identity !== currentBridgeFileIdentity(anchor.target_path)
    || !codexMcpLayoutAttentionIsExplainable(db, scope.installationId, scope.artifactId)) return null;
  return { row, anchor };
}

/** Public read side: no option or epoch can turn collected facts into permission. */
export function readActiveCodexMcpSemanticProof(db: Database.Database, scope: CodexMcpProofScope): CodexMcpProofCore | null {
  return readCore(db, scope, null);
}

/** Internal activation input only. Its result is NOT admission, and must never
 * be used by MCP, UI, or the public source-block veto as an authorization result.
 */
export function readCodexMcpActivationCore(db: Database.Database, scope: CodexMcpProofScope, collectionEpoch: string): CodexMcpProofCore | null {
  if (!collectionEpoch) return null;
  return readCore(db, scope, collectionEpoch);
}

export function revokeCodexMcpSemanticProofs(db: Database.Database, installationId: string): void {
  if (hasCodexMcpSemanticProofTable(db)) db.prepare('DELETE FROM codex_mcp_semantic_member_proofs WHERE installation_id=?').run(installationId);
}

/** Called inside the same intent transaction as the existing exact-proof update.
 * A maintenance pause carries existing grants, never unfinished collection.
 */
export function carryCodexMcpSemanticIntent(
  db: Database.Database, bindingId: string, previousRevision: number, revision: number, disconnected: boolean,
): void {
  if (!hasCodexMcpSemanticProofTable(db)) return;
  db.prepare(`DELETE FROM codex_mcp_semantic_member_proofs WHERE binding_id=?
    AND (?=1 OR evidence_phase='collected')`).run(bindingId, disconnected ? 1 : 0);
  if (disconnected) return;
  db.prepare(`UPDATE codex_mcp_semantic_member_proofs AS proof SET intent_revision=?
    WHERE binding_id=? AND evidence_phase='active' AND intent_revision=? AND EXISTS (
      SELECT 1 FROM agent_installations i JOIN agent_consents s ON s.id=i.consent_envelope_id
      JOIN artifact_consumers c ON c.installation_id=i.id AND c.artifact_id=proof.artifact_id
        AND c.component_key=proof.component_key AND c.state='active' AND c.tombstoned_at IS NULL
      WHERE i.id=proof.installation_id AND s.id=proof.consent_id AND s.status='active'
        AND c.consent_envelope_id=s.id AND i.tombstoned_at IS NULL AND i.bridge_state!='stopped'
        AND i.desired_state IN ('managed','disabled')
    )`).run(revision, bindingId, previousRevision);
}
