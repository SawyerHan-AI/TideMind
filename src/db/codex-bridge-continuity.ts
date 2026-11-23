import type Database from 'better-sqlite3';
import { readActiveCodexMcpSemanticProof } from './codex-mcp-semantic-proof.js';
import { captureBridgeAnchor, currentBridgeFileIdentity, currentCodexMemberSurface, type BridgeAnchor, type CodexBridgeComponent } from './codex-bridge-physical.js';
export { bridgeFileIdentity, currentBridgeFileIdentity, currentCodexMemberSurface, latestPhysicalBridgeWrite, captureBridgeAnchor, captureCodexReadbackAnchor, type BridgeAnchor, type CodexBridgeComponent } from './codex-bridge-physical.js';

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
    LEFT JOIN metadata preference ON preference.key='agent_connection_intent:' || i.family || ':' || b.domain_key
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

export interface CodexReconnectCandidate {
  artifactId: string;
  mutationId: string;
  exactWitness: boolean;
}
export interface CodexSourceBlockFacts {
  installationId: string;
  rejectedToken: boolean;
  candidates: CodexReconnectCandidate[];
}

/** Immutable reconnect-chain facts, NOT permission. No proof reader calls this
 * function recursively. Collected evidence is never consulted here. */
export function readCodexReconnectSourceFacts(
  db: Database.Database, bindingId: string, component: CodexBridgeComponent, tokenHash: string,
): CodexSourceBlockFacts[] {
  const blocks = db.prepare(`SELECT installation_id,token_hash,last_mutation_rowid,last_consent_rowid
    FROM codex_bridge_source_blocks WHERE binding_id=? AND component_key=? ORDER BY installation_id,token_hash`)
    .all(bindingId, component) as Array<{installation_id:string;token_hash:string;last_mutation_rowid:number;last_consent_rowid:number}>;
  return blocks.map(block => {
    if (block.token_hash === tokenHash) return {installationId:block.installation_id,rejectedToken:true,candidates:[]};
    const rows = db.prepare(`SELECT DISTINCT installed.id AS mutation_id,installed.artifact_id,
      EXISTS (SELECT 1 FROM codex_bridge_member_proofs fresh WHERE fresh.binding_id=?
        AND fresh.installation_id=? AND fresh.component_key=? AND fresh.mutation_id=installed.id) AS exact_witness
      FROM projection_mutations removed
      JOIN reconcile_runs disconnect ON disconnect.id=removed.run_id AND disconnect.operation_type='disconnect'
      JOIN agent_identity_binding_members rm ON rm.installation_id=removed.installation_id AND rm.binding_id=?
      JOIN projection_mutations installed ON installed.artifact_id=removed.artifact_id AND installed.rowid>removed.rowid
      JOIN reconcile_runs connect ON connect.id=installed.run_id AND connect.operation_type='connect'
      JOIN agent_identity_binding_members im ON im.installation_id=installed.installation_id AND im.binding_id=?
      JOIN agent_consents approval ON approval.id=connect.consent_envelope_id AND approval.installation_id=installed.installation_id
      WHERE removed.rowid>? AND removed.component_key=? AND removed.state='committed'
        AND removed.idempotency_strategy!='consumer_detach_only' AND removed.after_hash IS NULL
        AND installed.component_key=? AND installed.state='committed'
        AND installed.idempotency_strategy!='consumer_detach_only' AND installed.after_hash IS NOT NULL
        AND approval.rowid>? AND approval.authorization_origin='explicit_user' AND approval.status='active'
        AND json_extract(connect.prepared_plan_json,'$.executionPlan.activityGenerationTokenHash')=?`)
      .all(bindingId,block.installation_id,component,bindingId,bindingId,block.last_mutation_rowid,
        component,component,block.last_consent_rowid,tokenHash) as Array<{mutation_id:string;artifact_id:string;exact_witness:number}>;
    return {installationId:block.installation_id,rejectedToken:false,
      candidates:rows.map(row=>({artifactId:row.artifact_id,mutationId:row.mutation_id,exactWitness:row.exact_witness===1}))};
  });
}

/** Preserves the existing explicit reconnect gate. An ACTIVE semantic proof of
 * the previously rejected member may replace its exact witness, never the
 * immutable remove/new-install/explicit-consent chain or an exposed old token. */
export function codexSourceBlockApplies(db: Database.Database,bindingId: string,component: CodexBridgeComponent,tokenHash:string): boolean {
  return readCodexReconnectSourceFacts(db,bindingId,component,tokenHash).some(block => {
    if (block.rejectedToken || !block.candidates.length) return true;
    const codexMemory = component === 'memory_tools' && Boolean(db.prepare(`SELECT 1 FROM agent_installations
      WHERE id=? AND family='codex' AND host_variant IN ('codex-cli','codex-desktop')`).get(block.installationId));
    return !block.candidates.some(candidate => {
      if (candidate.exactWitness && (!codexMemory || readAnchoredAdmission(db, bindingId, candidate.artifactId,
        component, block.installationId, tokenHash) === true)) return true;
      if (!codexMemory) return false;
      const proof = readActiveCodexMcpSemanticProof(db, {
        bindingId,artifactId:candidate.artifactId,installationId:block.installationId,tokenHash,
      });
      return proof?.anchor.mutation_id === candidate.mutationId;
    });
  });
}
