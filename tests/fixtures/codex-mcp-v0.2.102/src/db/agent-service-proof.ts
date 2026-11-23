import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { currentBridgeFileIdentity, latestPhysicalBridgeWrite } from './codex-bridge-continuity.js';

/**
 * A plugin-manager target (for example `claude:user:name@market`) is not a file.
 * The host only starts the bundled server while the plugin is installed, and the
 * bundle that carries the token lives in Tide Mind's own data directory, so the
 * token and ledger checks are the binding facts for it.
 */
export const HOST_MANAGED_TARGET_IDENTITY = 'host-managed';
export function currentServiceTargetIdentity(targetPath: string): string | null {
  return path.isAbsolute(targetPath) ? currentBridgeFileIdentity(targetPath) : HOST_MANAGED_TARGET_IDENTITY;
}

/**
 * Service proof for a dedicated (non-shared) Installation.
 *
 * Whether memory is served depends on current facts — user intent, consent,
 * source and the exact bytes Tide Mind last wrote — not on whether a historical
 * connect run finished its verification. Creating the table grants nothing:
 * only the desktop coordinator publishes a row, after a live source
 * attestation and a read-back of the managed fragment.
 */
export const AGENT_SERVICE_PROOF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_service_proofs (
  installation_id TEXT NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES managed_artifacts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL CHECK(component_key IN ('memory_tools','lifecycle')),
  consent_id TEXT NOT NULL REFERENCES agent_consents(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL REFERENCES projection_mutations(id) ON DELETE CASCADE,
  journal_version INTEGER NOT NULL,
  target_path TEXT NOT NULL,
  fragment_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  surface_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  intent_domain_key TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  superseded_run_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,artifact_id,component_key)
);
`;

export type ServiceProofComponent = 'memory_tools' | 'lifecycle';

export interface ServiceAnchor {
  installation_id: string;
  artifact_id: string;
  component_key: ServiceProofComponent;
  mutation_id: string;
  journal_version: number;
  target_path: string;
  ownership_key: string;
  selector_schema_version: string;
  fragment_hash: string;
  token_hash: string;
}

/** One snapshot of everything discovery knows about the host; scan timestamps are excluded. */
export function currentInstallationSurface(db: Database.Database, installationId: string): string | null {
  const row = db.prepare(`SELECT json_array(
      family, host_variant, runtime_realm, os_user_identity, config_root, profile_id,
      install_key, distribution_id, detected_version, executable_path, app_path, supported_capability,
      json_extract(metadata_json,'$.hostOwnedIdentity'), json_extract(metadata_json,'$.distribution'),
      json_extract(metadata_json,'$.componentConfigRoots'), json_extract(metadata_json,'$.componentConfigFiles'),
      json_extract(metadata_json,'$.resourceRoots'), json_extract(metadata_json,'$.managementEligibility')
    ) AS surface FROM agent_installations WHERE id=?`).get(installationId) as { surface: string } | undefined;
  return row ? createHash('sha256').update(row.surface).digest('hex') : null;
}

/** Current physical bytes with an intact, fully committed write receipt and no undetermined write on the domain. */
export function captureServiceAnchor(
  db: Database.Database, installationId: string, artifactId: string, component: ServiceProofComponent,
): ServiceAnchor | null {
  const latest = latestPhysicalBridgeWrite(db, artifactId);
  if (!latest || latest.operation_type === 'disconnect' || latest.installation_id !== installationId
    || !latest.token || !latest.token_hash
    || latest.token_hash !== createHash('sha256').update(JSON.stringify(latest.token)).digest('hex')) return null;
  const row = db.prepare(`SELECT p.installation_id, a.id AS artifact_id, ? AS component_key,
      p.id AS mutation_id, p.journal_version, a.target_path, a.ownership_key, a.selector_schema_version,
      p.after_hash AS fragment_hash, ? AS token_hash
    FROM projection_mutations p JOIN managed_artifacts a ON a.id=p.artifact_id
    WHERE p.id=? AND a.id=? AND p.installation_id=? AND p.target=a.target_path
      AND p.journal_version>=4 AND p.state='committed' AND p.failure_code IS NULL AND p.failure_stage IS NULL
      AND p.after_hash IS NOT NULL AND p.after_hash=a.owned_fragment_hash
      AND p.after_hash=a.desired_fragment_hash AND p.after_hash=p.post_effect_fingerprint
      AND p.after_hash=p.compensation_precondition
      AND json_extract(CASE WHEN json_valid(p.apply_receipt_json) THEN p.apply_receipt_json END,'$.fingerprint')=p.after_hash
      AND a.state IN ('healthy','paused','needs_recovery')
      AND NOT EXISTS (SELECT 1 FROM agent_identity_binding_members m WHERE m.installation_id=p.installation_id)
      AND NOT EXISTS (
        SELECT 1 FROM projection_mutations uncertain JOIN reconcile_runs r ON r.id=uncertain.run_id
        WHERE uncertain.idempotency_strategy!='consumer_detach_only'
          AND (uncertain.artifact_id=a.id OR uncertain.mutation_domain=a.mutation_domain
            OR EXISTS (SELECT 1 FROM json_each(r.writer_fence_snapshot_json,'$.mutationDomains')
              WHERE value=a.mutation_domain))
          AND (uncertain.state IN ('effect_started','effect_observed','receipt_persisted','verified','needs_recovery','compensating')
            OR (uncertain.state='prepared' AND r.state IN ('planned','preconditions_checked','applying','needs_recovery')))
      )`).get(component, latest.token_hash, latest.id, artifactId, installationId) as ServiceAnchor | undefined;
  return row ?? null;
}

interface ProofRow extends ServiceAnchor {
  surface_fingerprint: string;
  file_identity: string;
  intent_domain_key: string;
  intent_revision: number;
}

/**
 * True only while every fact the proof was published under still holds.
 * A missing table or row is not an error: it simply proves nothing.
 */
export function readServiceProofAdmission(
  db: Database.Database, installationId: string, component: ServiceProofComponent, tokenHash: string,
): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_service_proofs'").get()) return false;
  const rows = db.prepare(`SELECT p.installation_id, p.artifact_id, p.component_key, p.mutation_id, p.journal_version,
      p.target_path, p.fragment_hash, p.token_hash, p.surface_fingerprint, p.file_identity,
      p.intent_domain_key, p.intent_revision
    FROM agent_service_proofs p
    JOIN agent_installations i ON i.id=p.installation_id
    JOIN agent_consents s ON s.id=p.consent_id AND s.installation_id=i.id AND s.status='active'
    JOIN artifact_consumers c ON c.installation_id=i.id AND c.artifact_id=p.artifact_id
      AND c.component_key=p.component_key AND c.consent_envelope_id=s.id AND c.state='active'
      AND c.desired_state IN ('managed','disabled') AND c.tombstoned_at IS NULL
    JOIN installation_components part ON part.installation_id=i.id AND part.artifact_id=c.artifact_id
      AND part.component_key=c.component_key AND part.consent_envelope_id=s.id AND part.tombstoned_at IS NULL
      AND part.desired_state IN ('managed','disabled')
    WHERE p.installation_id=? AND p.component_key=? AND p.token_hash=?
      AND p.consent_id=i.consent_envelope_id
      AND i.health_state='discovered' AND i.tombstoned_at IS NULL AND i.bridge_state!='stopped'
      AND i.desired_state IN ('managed','disabled') AND COALESCE(i.status_reason,'')!='conflict'
      AND COALESCE(json_extract(CASE WHEN json_valid(i.metadata_json) THEN i.metadata_json END,'$.managementEligibility.reason'),'')
        NOT IN ('source_not_official','release_distribution_not_accepted','release_entry_missing','release_mode_detect_only')
      AND EXISTS (SELECT 1 FROM json_each(s.allowed_components_json) WHERE value=p.component_key)
    `).all(installationId, component, tokenHash) as ProofRow[];
  if (!rows.length) return false;
  const surface = currentInstallationSurface(db, installationId);
  return rows.every(row => {
    const current = captureServiceAnchor(db, installationId, row.artifact_id, component);
    if (!current || current.mutation_id !== row.mutation_id || current.journal_version !== row.journal_version
      || current.fragment_hash !== row.fragment_hash || current.token_hash !== row.token_hash
      || current.target_path !== row.target_path) return false;
    const intent = readIntent(db, row.intent_domain_key);
    return intent.state !== 'disconnected' && intent.revision === row.intent_revision
      && row.surface_fingerprint === surface
      && row.file_identity === currentServiceTargetIdentity(row.target_path);
  });
}

function readIntent(db: Database.Database, domainKey: string): { state: string; revision: number } {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(`agent_connection_intent:${domainKey}`) as { value: string } | undefined;
  if (!row) return { state: 'active', revision: 0 };
  try {
    const value = JSON.parse(row.value) as { state?: unknown; revision?: unknown };
    return typeof value.state === 'string' && Number.isSafeInteger(value.revision)
      ? { state: value.state, revision: value.revision as number }
      : { state: 'disconnected', revision: -1 };
  } catch {
    return { state: 'disconnected', revision: -1 };
  }
}

export interface AttestedServiceMember {
  consentId: string;
  surface: string;
  source: string;
  fileIdentity: string;
  intentDomainKey: string;
  intentRevision: number;
  supersededRunId: string | null;
  observedAt: string;
}

/** Call within the same immediate transaction as the final intent/read-back/fence checks. */
export function publishServiceProof(db: Database.Database, expected: ServiceAnchor, member: AttestedServiceMember): void {
  if (!db.inTransaction) throw new Error('Service proof requires an active transaction');
  const current = captureServiceAnchor(db, expected.installation_id, expected.artifact_id, expected.component_key);
  if (!current || (Object.keys(current) as Array<keyof ServiceAnchor>).some(key => current[key] !== expected[key])
    || currentInstallationSurface(db, expected.installation_id) !== member.surface
    || currentServiceTargetIdentity(expected.target_path) !== member.fileIdentity
    || !/^[a-f\d]{64}$/.test(member.source)) throw new Error('Service observation changed');
  db.prepare(`INSERT INTO agent_service_proofs
    (installation_id,artifact_id,component_key,consent_id,mutation_id,journal_version,target_path,fragment_hash,token_hash,
      surface_fingerprint,source_fingerprint,file_identity,intent_domain_key,intent_revision,superseded_run_id,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(installation_id,artifact_id,component_key) DO UPDATE SET
      consent_id=excluded.consent_id,mutation_id=excluded.mutation_id,journal_version=excluded.journal_version,
      target_path=excluded.target_path,fragment_hash=excluded.fragment_hash,token_hash=excluded.token_hash,
      surface_fingerprint=excluded.surface_fingerprint,source_fingerprint=excluded.source_fingerprint,
      file_identity=excluded.file_identity,intent_domain_key=excluded.intent_domain_key,
      intent_revision=excluded.intent_revision,
      superseded_run_id=COALESCE(excluded.superseded_run_id,agent_service_proofs.superseded_run_id),
      observed_at=excluded.observed_at`).run(
    current.installation_id, current.artifact_id, current.component_key, member.consentId, current.mutation_id,
    current.journal_version, current.target_path, current.fragment_hash, current.token_hash, member.surface,
    member.source, member.fileIdentity, member.intentDomainKey, member.intentRevision, member.supersededRunId, member.observedAt);
  if (!readServiceProofAdmission(db, current.installation_id, current.component_key, current.token_hash)) {
    throw new Error('Service member no longer eligible');
  }
}
