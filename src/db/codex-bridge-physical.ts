import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';

/** A managed configuration file has no content hash here, so both timestamps stay; only the device number does not survive a reboot. */
export function bridgeFileIdentity(st: { ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return ['v2',st.ino,st.mode,st.size,st.mtimeNs,st.ctimeNs].join(':');
}

/** Stable readback identity; the selector hash is established separately by the adapter. */
export function currentBridgeFileIdentity(target: string): string | null {
  try {
    if (realpathSync.native(target) !== target) return null;
    const st = lstatSync(target,{bigint:true});
    return st.isFile() ? bridgeFileIdentity(st) : null;
  } catch {
    return null;
  }
}

export type CodexBridgeComponent = 'memory_tools' | 'lifecycle';

/** One snapshot per member. Ignore scan timestamps and historical activity. */
export function currentCodexMemberSurface(db: Database.Database, installationId: string): string | null {
  const row = db.prepare(`SELECT json_array(
      family, host_variant, runtime_realm, os_user_identity, config_root, profile_id,
      install_key, distribution_id, detected_version, executable_path, app_path, supported_capability,
      json_extract(metadata_json,'$.hostOwnedIdentity'), json_extract(metadata_json,'$.distribution'),
      json_extract(metadata_json,'$.componentConfigRoots'), json_extract(metadata_json,'$.componentConfigFiles'),
      json_extract(metadata_json,'$.resourceRoots'), json_extract(metadata_json,'$.managementEligibility')
    ) AS surface FROM agent_installations
    WHERE id=? AND EXISTS (SELECT 1 FROM agent_identity_binding_members m WHERE m.installation_id=agent_installations.id)`)
    .get(installationId) as {surface:string} | undefined;
  return row ? createHash('sha256').update(row.surface).digest('hex') : null;
}

interface PhysicalWrite {
  id: string;
  run_id: string;
  installation_id: string;
  journal_version: number;
  after_hash: string | null;
  token: string | null;
  token_hash: string | null;
  operation_type: string;
  run_state: string;
  failure_code: string | null;
}

/** Consumer detach changes management intent without replacing the bytes on disk. */
export function latestPhysicalBridgeWrite(db: Database.Database, artifactId: string): PhysicalWrite | undefined {
  return db.prepare(`SELECT p.id, p.run_id, r.installation_id, p.journal_version, p.after_hash,
      r.operation_type, r.state AS run_state, r.failure_code,
      json_extract(r.prepared_plan_json,'$.activityGenerationToken') AS token,
      json_extract(r.prepared_plan_json,'$.executionPlan.activityGenerationTokenHash') AS token_hash
    FROM projection_mutations p JOIN reconcile_runs r ON r.id=p.run_id
    WHERE p.artifact_id=? AND p.state='committed' AND p.idempotency_strategy!='consumer_detach_only'
    ORDER BY p.committed_at DESC, p.rowid DESC LIMIT 1`).get(artifactId) as PhysicalWrite | undefined;
}

export interface BridgeAnchor {
  binding_id: string;
  artifact_id: string;
  component_key: CodexBridgeComponent;
  binding_generation: number;
  mutation_id: string;
  journal_version: number;
  target_path: string;
  ownership_key: string;
  selector_schema_version: string;
  fragment_hash: string;
  token_hash: string;
}

/** Returns only current physical bytes with an intact, fully committed write receipt. */
function capturePhysicalAnchor(
  db: Database.Database, bindingId: string, artifactId: string, component: CodexBridgeComponent, allowRawDrift: boolean,
): BridgeAnchor | null {
  const latest = latestPhysicalBridgeWrite(db, artifactId);
  if (!latest || latest.operation_type === 'disconnect' || !latest.token || !latest.token_hash
    || latest.token_hash !== createHash('sha256').update(JSON.stringify(latest.token)).digest('hex')) return null;
  const row = db.prepare(`SELECT b.id AS binding_id, a.id AS artifact_id, ? AS component_key,
      b.generation AS binding_generation, p.id AS mutation_id, p.journal_version, a.target_path,
      a.ownership_key, a.selector_schema_version, p.after_hash AS fragment_hash, ? AS token_hash
    FROM projection_mutations p JOIN managed_artifacts a ON a.id=p.artifact_id
    JOIN agent_identity_binding_members m ON m.installation_id=p.installation_id
    JOIN agent_identity_bindings b ON b.id=m.binding_id
    WHERE p.id=? AND b.id=? AND a.id=? AND p.component_key=? AND p.target=a.target_path
      AND p.journal_version>=4 AND p.state='committed' AND p.failure_code IS NULL AND p.failure_stage IS NULL
      AND p.after_hash IS NOT NULL AND p.after_hash=a.owned_fragment_hash
      AND p.after_hash=a.desired_fragment_hash AND p.after_hash=p.post_effect_fingerprint
      AND p.after_hash=p.compensation_precondition
      AND json_extract(CASE WHEN json_valid(p.apply_receipt_json) THEN p.apply_receipt_json END,'$.fingerprint')=p.after_hash
      AND (a.state IN ('healthy','paused','needs_recovery') OR (?=1 AND a.state='drifted'))
      AND NOT EXISTS (
        SELECT 1 FROM projection_mutations uncertain JOIN reconcile_runs r ON r.id=uncertain.run_id
        WHERE uncertain.idempotency_strategy!='consumer_detach_only'
          AND (uncertain.artifact_id=a.id OR uncertain.mutation_domain=a.mutation_domain
            OR EXISTS (SELECT 1 FROM json_each(r.writer_fence_snapshot_json,'$.mutationDomains')
              WHERE value=a.mutation_domain))

          AND (uncertain.state IN ('effect_started','effect_observed','receipt_persisted','verified','needs_recovery','compensating')
            OR (uncertain.state='prepared' AND r.state IN ('planned','preconditions_checked','applying','needs_recovery')))
      )`).get(component, latest.token_hash, latest.id, bindingId, artifactId, component, allowRawDrift ? 1 : 0) as BridgeAnchor | undefined;
  return row ?? null;
}

/** Exact readers retain the original raw-state contract. */
export function captureBridgeAnchor(db: Database.Database, bindingId: string, artifactId: string, component: CodexBridgeComponent): BridgeAnchor | null {
  return capturePhysicalAnchor(db, bindingId, artifactId, component, false);
}

/** Immutable physical evidence only. This does not authorize a drifted carrier.
 * The caller must prove current file meaning, source and permission separately. */
export function captureCodexReadbackAnchor(db: Database.Database, bindingId: string, artifactId: string): BridgeAnchor | null {
  return capturePhysicalAnchor(db, bindingId, artifactId, 'memory_tools', true);
}
