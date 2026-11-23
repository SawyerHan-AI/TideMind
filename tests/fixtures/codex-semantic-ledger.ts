import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureSchema } from '../../src/db/schema.js';
import { agentIdentityDomainKey } from '../../src/db/agent-identity-binding.js';
import { captureBridgeAnchor, currentBridgeFileIdentity, currentCodexMemberSurface, publishAttestedBridgeMember } from '../../src/db/codex-bridge-continuity.js';
import { codexAnchorFingerprint, type CodexMcpProofRow } from '../../src/db/codex-mcp-semantic-proof.js';
import { compareCodexMcpSemantics } from '../../src/utils/codex-mcp-semantic.js';
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard.js';
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository.js';
import { seedLifecycle } from './seed-managed-lifecycle.js';

/** Synthetic low-level reader fixture. SQL inserts are not producer/attestation
 * acceptance; production collection is separately tested through the coordinator. */
export function createCodexSemanticLedger() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-semantic-ledger-')));
  const target = path.join(root, 'config.toml');
  const generation = 'generation_cli';
  const tokenHash = createHash('sha256').update(JSON.stringify(generation)).digest('hex');
  const selector = 'mcp_servers.tidemind-cli';
  const original = `[${selector}]\nenabled = true\ncommand = "/synthetic/shim"\nargs = ["/synthetic/server.cjs"]\nenv = { EB_AGENT_ID = "cli", EB_ACTIVITY_GENERATION_TOKEN = "${generation}" }\n`;
  const nested = `[${selector}]\ncommand = "/synthetic/shim"\nargs = ["/synthetic/server.cjs"]\n\n[${selector}.env]\nEB_ACTIVITY_GENERATION_TOKEN = "${generation}"\nEB_AGENT_ID = "cli"\n`;
  const owned = createHash('sha256').update(original).digest('hex');
  fs.writeFileSync(target, original);
  for (const [agent, variant] of [['cli', 'codex-cli'], ['desktop', 'codex-desktop']]) seedLifecycle(db, agent, 'codex', variant);
  db.prepare('UPDATE agent_installations SET config_root=?').run(root);
  const member = db.prepare("SELECT * FROM agent_installations WHERE agent_id='cli'").get() as Parameters<typeof agentIdentityDomainKey>[0];
  db.prepare("INSERT INTO agent_identity_bindings VALUES ('binding',?,'cli',1,?,'now','now')").run(agentIdentityDomainKey(member), 'a'.repeat(64));
  db.exec(`INSERT INTO agent_identity_binding_members VALUES ('installation_cli','binding'),('installation_desktop','binding');
    DELETE FROM artifact_consumers;
    UPDATE installation_components SET component_key='memory_tools',artifact_id='artifact_cli';
    INSERT INTO artifact_consumers(artifact_id,installation_id,component_key,desired_state,consent_envelope_id,state,added_at,updated_at)
      SELECT artifact_id,installation_id,component_key,'managed',consent_envelope_id,'active','now','now' FROM installation_components;
    UPDATE agent_consents SET allowed_components_json='["memory_tools"]';
    UPDATE reconcile_runs SET prepared_plan_json=json_replace(prepared_plan_json,'$.componentKeys',json('["memory_tools"]'));`);
  db.prepare(`UPDATE managed_artifacts SET component_type='mcp',target_path=?,ownership_key=?,
    owned_fragment_hash=?,observed_fragment_hash=?,desired_fragment_hash=? WHERE id='artifact_cli'`).run(target, selector, owned, owned, owned);
  db.prepare(`INSERT INTO projection_mutations(id,run_id,operation_id,installation_id,component_key,artifact_id,
    mutation_domain,target,after_hash,post_effect_fingerprint,compensation_precondition,apply_receipt_json,journal_version,
    idempotency_strategy,readback_strategy,state,committed_at,created_at,updated_at)
    VALUES ('mutation','run_cli','synthetic','installation_cli','memory_tools','artifact_cli','domain',?,?,?,?,?,5,
      'readback_exact_then_replay','fixture','committed','2026-01-01','now','now')`)
    .run(target, owned, owned, owned, JSON.stringify({ fingerprint: owned }));
  const anchor = captureBridgeAnchor(db, 'binding', 'artifact_cli', 'memory_tools')!;
  for (const id of ['cli', 'desktop']) db.transaction(() => publishAttestedBridgeMember(db, anchor, {
    installationId: `installation_${id}`, consentId: `consent_${id}`,
    surface: currentCodexMemberSurface(db, `installation_${id}`)!, source: '1'.repeat(64),
    fileIdentity: currentBridgeFileIdentity(target)!, intentRevision: 0, observedAt: new Date().toISOString(),
  })).immediate();
  db.exec("UPDATE reconcile_runs SET state='cancelled',failure_code='superseded_by_codex_continuity' WHERE id='run_cli'");
  const repository = new AgentIntegrationRepository(db);
  const scope = (id = 'cli') => ({ bindingId: 'binding', artifactId: 'artifact_cli', installationId: `installation_${id}`, tokenHash });
  function rewrite() {
    fs.writeFileSync(target, nested);
    const observedFingerprint = createHash('sha256').update(nested).digest('hex');
    repository.markArtifactNeedsAttention({ artifactId: 'artifact_cli', artifactState: 'drifted', statusReason: 'conflict',
      invalidationReason: 'artifact_drifted', observedFingerprint, observedAt: new Date().toISOString() });
    repository.recordEvent({ artifactId: 'artifact_cli', kind: 'artifact_drifted', severity: 'warning',
      payload: { observedFingerprint }, createdAt: new Date().toISOString() });
  }
  function putProof(id = 'cli', phase: 'collected' | 'active' = 'collected', epoch = 'fixture-epoch'): CodexMcpProofRow {
    const current = fs.readFileSync(target, 'utf8');
    const compared = compareCodexMcpSemantics(original, current, selector);
    if (compared.kind !== 'exact' && compared.kind !== 'equivalent') throw new Error('invalid synthetic comparison');
    const row: CodexMcpProofRow = {
      binding_id: 'binding', artifact_id: 'artifact_cli', component_key: 'memory_tools', installation_id: `installation_${id}`,
      binding_generation: 1, mutation_id: 'mutation', journal_version: 5, anchor_fingerprint: codexAnchorFingerprint(anchor),
      proof_version: 1, evidence_phase: phase, layout_kind: compared.kind, collection_epoch: epoch,
      observed_fragment_hash: compared.observed.rawHash, semantic_hash: compared.observed.semanticHash,
      container_hash: createHash('sha256').update(current).digest('hex'), file_identity: currentBridgeFileIdentity(target)!,
      consent_id: `consent_${id}`, intent_revision: repository.connectionIntent(`installation_${id}`).revision,
      surface_fingerprint: currentCodexMemberSurface(db, `installation_${id}`)!, source_fingerprint: '1'.repeat(64),
      observed_at: new Date().toISOString(),
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO codex_mcp_semantic_member_proofs (${keys.join(',')}) VALUES (${keys.map(key => '@' + key).join(',')})`).run(row);
    return row;
  }
  return { db, root, target, generation, tokenHash, original, nested, anchor, repository, scope, rewrite, putProof,
    admit: () => evaluateBridgeAdmission(db, { agentId: 'cli', activityGenerationToken: generation, componentKey: 'memory_tools' }),
    close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
