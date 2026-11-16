import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';

/** Stable readback identity; the selector hash is established separately by the adapter. */
export function currentBridgeFileIdentity(target: string): string | null {
  try {
    if (realpathSync.native(target) !== target) return null;
    const st = lstatSync(target,{bigint:true});
    return st.isFile() ? [st.dev,st.ino,st.mode,st.size,st.mtimeNs,st.ctimeNs].join(':') : null;
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
    WHERE id=? AND family='codex' AND host_variant IN ('codex-cli','codex-desktop')`)
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
export function captureBridgeAnchor(
  db: Database.Database, bindingId: string, artifactId: string, component: CodexBridgeComponent,
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
      AND a.state IN ('healthy','paused','needs_recovery')
      AND NOT EXISTS (
        SELECT 1 FROM projection_mutations uncertain JOIN reconcile_runs r ON r.id=uncertain.run_id
        WHERE uncertain.idempotency_strategy!='consumer_detach_only'
          AND (uncertain.artifact_id=a.id OR uncertain.mutation_domain=a.mutation_domain
            OR EXISTS (SELECT 1 FROM json_each(r.writer_fence_snapshot_json,'$.mutationDomains')
              WHERE value=a.mutation_domain))

          AND (uncertain.state IN ('effect_started','effect_observed','receipt_persisted','verified','needs_recovery','compensating')
            OR (uncertain.state='prepared' AND r.state IN ('planned','preconditions_checked','applying','needs_recovery')))
      )`).get(component, latest.token_hash, latest.id, bindingId, artifactId, component) as BridgeAnchor | undefined;
  return row ?? null;
}

/** Once a component is enrolled, its proof governs admission even when all members lose trust. */
export function readAnchoredAdmission(
  db: Database.Database, bindingId: string, artifactId: string, component: CodexBridgeComponent,
  installationId: string, expectedTokenHash: string,
): boolean | null {
  const persisted = db.prepare(`SELECT * FROM codex_bridge_anchors
    WHERE binding_id=? AND artifact_id=? AND component_key=?`).get(bindingId, artifactId, component) as BridgeAnchor | undefined;
  if (!persisted) return null;
  const current = captureBridgeAnchor(db, bindingId, artifactId, component);
  if (!current || current.token_hash !== expectedTokenHash
    || (Object.keys(current) as Array<keyof BridgeAnchor>).some(key => current[key] !== persisted[key])) return false;

  const row = db.prepare(`SELECT p.surface_fingerprint, p.file_identity FROM codex_bridge_member_proofs p
    JOIN agent_installations i ON i.id=p.installation_id
    JOIN agent_identity_binding_members m ON m.installation_id=i.id AND m.binding_id=p.binding_id
    JOIN agent_identity_bindings b ON b.id=m.binding_id
    JOIN agent_consents s ON s.id=p.consent_id AND s.installation_id=i.id AND s.status='active'
    JOIN artifact_consumers c ON c.installation_id=i.id AND c.artifact_id=p.artifact_id
      AND c.component_key=p.component_key AND c.consent_envelope_id=s.id AND c.state='active'
      AND c.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
    JOIN installation_components part ON part.installation_id=i.id AND part.artifact_id=c.artifact_id
      AND part.component_key=c.component_key AND part.consent_envelope_id=s.id AND part.tombstoned_at IS NULL
      AND part.desired_state IN ('managed','disabled')
    LEFT JOIN metadata preference ON preference.key='agent_connection_intent:codex:' || b.domain_key
    WHERE p.binding_id=? AND p.artifact_id=? AND p.component_key=? AND p.installation_id=?
      AND p.binding_generation=b.generation AND p.mutation_id=? AND p.journal_version=? AND p.consent_id=i.consent_envelope_id
      AND i.health_state='discovered' AND i.tombstoned_at IS NULL AND i.bridge_state!='stopped'
      AND i.desired_state IN ('managed','disabled') AND COALESCE(i.status_reason,'')!='conflict'
      AND p.intent_revision=COALESCE(json_extract(preference.value,'$.revision'),0)
      AND COALESCE(json_extract(preference.value,'$.state'),'active')!='disconnected'
      AND EXISTS (SELECT 1 FROM json_each(s.allowed_components_json) WHERE value=p.component_key)
    `).get(bindingId, artifactId, component, installationId, current.mutation_id, current.journal_version) as
      {surface_fingerprint:string;file_identity:string} | undefined;
  return Boolean(row && row.file_identity === currentBridgeFileIdentity(current.target_path) && row.surface_fingerprint === currentCodexMemberSurface(db, installationId));
}

export interface AttestedBridgeMember {
  installationId: string;
  consentId: string;
  surface: string;
  source: string;
  fileIdentity: string;
  intentRevision: number;
  observedAt: string;
}

/** Call within the same immediate transaction as final intent/readback/fence checks. */
export function publishAttestedBridgeMember(
  db: Database.Database, expected: BridgeAnchor, member: AttestedBridgeMember,
): void {
  if (!db.inTransaction) throw new Error('Bridge proof requires an active transaction');
  const current = captureBridgeAnchor(db, expected.binding_id, expected.artifact_id, expected.component_key);
  if (!current || (Object.keys(current) as Array<keyof BridgeAnchor>).some(key => current[key] !== expected[key])
    || currentCodexMemberSurface(db, member.installationId) !== member.surface
    || currentBridgeFileIdentity(expected.target_path) !== member.fileIdentity
    || !/^[a-f\d]{64}$/.test(member.source)) throw new Error('Bridge observation changed');
  // Update in place: replacing the parent row would cascade away valid peer proofs.
  db.prepare(`INSERT INTO codex_bridge_anchors
    (binding_id,artifact_id,component_key,binding_generation,mutation_id,journal_version,
      target_path,ownership_key,selector_schema_version,fragment_hash,token_hash)
    VALUES (@binding_id,@artifact_id,@component_key,@binding_generation,@mutation_id,@journal_version,
      @target_path,@ownership_key,@selector_schema_version,@fragment_hash,@token_hash)
    ON CONFLICT(binding_id,artifact_id,component_key) DO UPDATE SET
      binding_generation=excluded.binding_generation,mutation_id=excluded.mutation_id,
      journal_version=excluded.journal_version,target_path=excluded.target_path,ownership_key=excluded.ownership_key,
      selector_schema_version=excluded.selector_schema_version,fragment_hash=excluded.fragment_hash,token_hash=excluded.token_hash`).run(current);
  db.prepare(`INSERT INTO codex_bridge_member_proofs
    (binding_id,artifact_id,component_key,binding_generation,mutation_id,journal_version,installation_id,consent_id,
      surface_fingerprint,source_fingerprint,file_identity,intent_revision,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(binding_id,artifact_id,component_key,installation_id) DO UPDATE SET
      binding_generation=excluded.binding_generation,mutation_id=excluded.mutation_id,journal_version=excluded.journal_version,consent_id=excluded.consent_id,
      surface_fingerprint=excluded.surface_fingerprint,source_fingerprint=excluded.source_fingerprint,
      file_identity=excluded.file_identity,intent_revision=excluded.intent_revision,observed_at=excluded.observed_at`).run(
        current.binding_id,current.artifact_id,current.component_key,current.binding_generation,current.mutation_id,current.journal_version,
        member.installationId,member.consentId,member.surface,member.source,member.fileIdentity,member.intentRevision,member.observedAt);
  if (!readAnchoredAdmission(db, current.binding_id, current.artifact_id, current.component_key,
    member.installationId, current.token_hash)) throw new Error('Bridge member no longer eligible');
}

/** Retain a definitive rejection across later inconclusive scans. A physical removal
 * followed by an explicit, freshly trusted reconnect may use a new generation.
 * Previously exposed tokens never become valid again in this binding.
 */
export function retainCodexSourceRejection(db: Database.Database, installationId: string): void {
  db.prepare(`INSERT INTO codex_bridge_source_blocks
      (binding_id,installation_id,component_key,token_hash,last_mutation_rowid,last_consent_rowid)
    SELECT DISTINCT m.binding_id,m.installation_id,c.component_key,
      COALESCE((SELECT json_extract(r.prepared_plan_json,'$.executionPlan.activityGenerationTokenHash')
        FROM projection_mutations pm JOIN reconcile_runs r ON r.id=pm.run_id
        WHERE pm.artifact_id=c.artifact_id AND pm.state='committed' AND pm.idempotency_strategy!='consumer_detach_only'
        ORDER BY pm.committed_at DESC,pm.rowid DESC LIMIT 1),''),
      COALESCE((SELECT MAX(rowid) FROM projection_mutations),0), COALESCE((SELECT MAX(rowid) FROM agent_consents),0)
    FROM agent_identity_binding_members m JOIN agent_identity_binding_members peer ON peer.binding_id=m.binding_id
    JOIN artifact_consumers c ON c.installation_id=peer.installation_id
    WHERE m.installation_id=? AND c.component_key IN ('memory_tools','lifecycle') AND c.state='active'
    ON CONFLICT(binding_id,installation_id,component_key,token_hash) DO UPDATE SET
      last_mutation_rowid=excluded.last_mutation_rowid,last_consent_rowid=excluded.last_consent_rowid`).run(installationId);
}

export function codexSourceBlockApplies(db: Database.Database,bindingId: string,component: CodexBridgeComponent,tokenHash:string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM codex_bridge_source_blocks block
    WHERE block.binding_id=? AND block.component_key=? AND (block.token_hash=? OR NOT EXISTS (
      SELECT 1 FROM projection_mutations removed
      JOIN reconcile_runs disconnect ON disconnect.id=removed.run_id AND disconnect.operation_type='disconnect'
      JOIN agent_identity_binding_members rm ON rm.installation_id=removed.installation_id AND rm.binding_id=block.binding_id
      JOIN projection_mutations installed ON installed.artifact_id=removed.artifact_id AND installed.rowid>removed.rowid
      JOIN reconcile_runs connect ON connect.id=installed.run_id AND connect.operation_type='connect'
      JOIN agent_identity_binding_members im ON im.installation_id=installed.installation_id AND im.binding_id=block.binding_id
      JOIN agent_consents approval ON approval.id=connect.consent_envelope_id AND approval.installation_id=installed.installation_id
      JOIN codex_bridge_member_proofs fresh ON fresh.binding_id=block.binding_id AND fresh.installation_id=block.installation_id
        AND fresh.component_key=block.component_key AND fresh.mutation_id=installed.id
      WHERE removed.rowid>block.last_mutation_rowid AND removed.component_key=block.component_key AND removed.state='committed'
        AND removed.idempotency_strategy!='consumer_detach_only' AND removed.after_hash IS NULL
        AND installed.component_key=block.component_key AND installed.state='committed'
        AND installed.idempotency_strategy!='consumer_detach_only' AND installed.after_hash IS NOT NULL
        AND approval.rowid>block.last_consent_rowid AND approval.authorization_origin='explicit_user' AND approval.status='active'
        AND json_extract(connect.prepared_plan_json,'$.executionPlan.activityGenerationTokenHash')=?
    )) LIMIT 1`).get(bindingId,component,tokenHash,tokenHash));
}
