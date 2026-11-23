import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexSemanticLedger } from '../fixtures/codex-semantic-ledger.js';
import { readActiveCodexMcpSemanticProof, readCodexMcpActivationCore } from '../../src/db/codex-mcp-semantic-proof.js';
import { evaluateBridgeAdmission as oldAdmission } from '../fixtures/codex-mcp-v0.2.102/src/agent-bridge-guard.js';
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard.js';

describe('separate Codex semantic evidence readers', () => {
  let fixture: ReturnType<typeof createCodexSemanticLedger>;
  beforeEach(() => { fixture = createCodexSemanticLedger(); });
  afterEach(() => fixture.close());

  it('keeps collected facts non-authorizing, with current epoch required for activation input', () => {
    expect(fixture.admit()).toEqual({ allowed: true });
    fixture.rewrite();
    fixture.putProof();
    fixture.db.exec('DELETE FROM codex_bridge_member_proofs');
    expect(readCodexMcpActivationCore(fixture.db, fixture.scope(), 'fixture-epoch')).not.toBeNull();
    expect(readCodexMcpActivationCore(fixture.db, fixture.scope(), 'different-epoch')).toBeNull();
    expect(readActiveCodexMcpSemanticProof(fixture.db, fixture.scope())).toBeNull();
    expect(fixture.admit()).toEqual({ allowed: false, reason: 'managed_fragment_changed' });
  });

  it('only admits an active, currently bound proof, and does not authorize the old reader', () => {
    fixture.rewrite();
    fixture.putProof('cli', 'active');
    fixture.db.exec('DELETE FROM codex_bridge_member_proofs');
    expect(fixture.admit()).toEqual({ allowed: true });
    for (const state of ['drifted', 'needs_recovery', 'healthy']) {
      fixture.db.prepare("UPDATE managed_artifacts SET state=? WHERE id='artifact_cli'").run(state);
      expect(oldAdmission(fixture.db, { agentId: 'cli', activityGenerationToken: fixture.generation }).allowed).toBe(false);
    }
    expect(evaluateBridgeAdmission(fixture.db, { agentId: 'cli', activityGenerationToken: 'different-generation' }).allowed).toBe(false);
  });

  it.each(['file', 'source', 'consent', 'anchor', 'observed', 'version', 'phase'])('rejects changed %s facts', change => {
    fixture.rewrite();
    fixture.putProof('cli', 'active');
    fixture.db.exec('DELETE FROM codex_bridge_member_proofs');
    expect(fixture.admit().allowed).toBe(true);
    switch (change) {
      case 'file': fs.writeFileSync(fixture.target, fixture.nested + '# new observation required\n'); break;
      case 'source': fixture.db.exec("UPDATE agent_installations SET detected_version='changed' WHERE id='installation_cli'"); break;
      case 'consent': fixture.db.exec("UPDATE agent_consents SET status='revoked' WHERE id='consent_cli'"); break;
      case 'anchor': fixture.db.exec("UPDATE codex_bridge_anchors SET journal_version=6"); break;
      case 'observed': fixture.db.exec("UPDATE managed_artifacts SET observed_fragment_hash='changed' WHERE id='artifact_cli'"); break;
      case 'version': fixture.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE codex_mcp_semantic_member_proofs SET proof_version=99'); break;
      case 'phase': fixture.db.exec("UPDATE codex_mcp_semantic_member_proofs SET evidence_phase='collected'"); break;
    }
    expect(fixture.admit().allowed).toBe(false);
  });

  it('carries active pause/resume grants but drops incomplete collection and revokes disconnect', () => {
    fixture.rewrite();
    fixture.putProof('cli', 'active');
    fixture.putProof('desktop', 'collected');
    fixture.db.exec('DELETE FROM codex_bridge_member_proofs');
    fixture.repository.pauseConnection('binding:binding', new Date().toISOString());
    expect(fixture.db.prepare("SELECT evidence_phase FROM codex_mcp_semantic_member_proofs").all()).toEqual([{ evidence_phase: 'active' }]);
    expect(fixture.admit().allowed).toBe(true);
    fixture.repository.resumeConnection('binding:binding', new Date().toISOString());
    expect(fixture.admit().allowed).toBe(true);
    fixture.repository.setMemberUserIntent('installation_cli', 'disabled', new Date().toISOString());
    expect(fixture.admit().allowed).toBe(true);
    fixture.repository.setInstallationIntent('installation_cli', 'removed', new Date().toISOString(), 'user_disconnect');
    expect(fixture.admit().allowed).toBe(false);
  });

  it('does not conceal an independent component conflict', () => {
    fixture.rewrite();
    fixture.putProof('cli', 'active');
    fixture.db.exec(`DELETE FROM codex_bridge_member_proofs;
      INSERT INTO installation_components(installation_id,component_key,desired_state,artifact_id,created_at,updated_at)
        VALUES ('installation_cli','instruction','managed','artifact_desktop','now','now');
      UPDATE managed_artifacts SET state='conflict' WHERE id='artifact_desktop';`);
    expect(fixture.admit().allowed).toBe(false);
  });

  it('does not create a missing proof table or admit without its anchored evidence', () => {
    fixture.rewrite();
    fixture.db.exec('DROP TABLE codex_mcp_semantic_member_proofs; DELETE FROM codex_bridge_member_proofs');
    expect(readActiveCodexMcpSemanticProof(fixture.db, fixture.scope())).toBeNull();
    expect(fixture.admit().allowed).toBe(false);
    expect(fixture.db.prepare("SELECT name FROM sqlite_master WHERE name='codex_mcp_semantic_member_proofs'").all()).toEqual([]);
  });
});
