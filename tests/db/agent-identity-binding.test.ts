import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema.js';
import { SqliteCoordinatorRepository } from '../../client/electron/agent-integration/coordinator-repository';
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository';
import { agentIdentityDomainKey, type ConfirmSharedIdentityInput } from '../../src/db/agent-identity-binding.js';

const now='2026-10-23T00:00:00Z';
describe('shared Agent identity binding',()=>{
 let db: Database.Database;
 let repository: AgentIntegrationRepository;
 beforeEach(()=>{
  db=new Database(':memory:');ensureSchema(db);repository=new AgentIntegrationRepository(db);
  db.prepare('INSERT INTO agents(id,name,tool_type,created) VALUES (?,?,?,?)').run('canonical','Synthetic Codex','codex',now);
  for(const [id,variant] of [['cli','codex-cli'],['desktop','codex-desktop']] as const) repository.upsertDiscoveredInstallation({
   id,provenance:'test',distributionId:'test-'+id,family:'codex',hostVariant:variant,runtimeRealm:'local_macos',installKey:id,configRoot:'/synthetic/.codex',
   agentId:'original-'+id,displayName:id,supportedCapability:4,lastDetectedAt:now,
  });
 });
 afterEach(()=>db.close());
 function input():ConfirmSharedIdentityInput{return {id:'binding',canonicalAgentId:'canonical',evidenceHash:'a'.repeat(64),confirmedAt:now,
  members:['cli','desktop'].map(id=>{const row=repository.getInstallation(id)!;return {installationId:id,installationAgentId:row.agent_id!,installKey:row.install_key,domainKey:agentIdentityDomainKey(row)};})};}
 it('resolves two surfaces to one canonical Agent without merging control identities or granting consent',()=>{
  const original=['cli','desktop'].map(id=>repository.getInstallation(id));
  repository.confirmSharedIdentity(input());
  for(const id of ['cli','desktop'])expect(repository.resolveAgentIdentity(id)).toEqual({installationAgentId:'original-'+id,canonicalAgentId:'canonical',bindingId:'binding',bindingGeneration:1});
  expect(['cli','desktop'].map(id=>repository.getInstallation(id))).toEqual(original);
 });
 it('falls back to the original identity for an unbound Installation',()=>{
  expect(repository.resolveAgentIdentity('cli').canonicalAgentId).toBe('original-cli');
 });
 it('repeats the same confirmation without duplicating members, including after activation',()=>{
  const plan=input();repository.confirmSharedIdentity(plan);
  db.exec("UPDATE agent_installations SET desired_state='managed'");
  repository.confirmSharedIdentity(plan);
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_identity_binding_members').get()).toEqual({n:2});
 });
 it('rejects different config domains atomically',()=>{
  db.exec("UPDATE agent_installations SET config_root='/other/.codex' WHERE id='desktop'");
  expect(()=>repository.confirmSharedIdentity(input())).toThrow(/one Codex domain/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_identity_bindings').get()).toEqual({n:0});
 });
 it('rejects stale frozen identity and detects a domain change after binding',()=>{
  const plan=input();db.exec("UPDATE agent_installations SET install_key='new-cli' WHERE id='cli'");
  expect(()=>repository.confirmSharedIdentity(plan)).toThrow(/stale/);
  repository.confirmSharedIdentity(input());
  db.exec("UPDATE agent_installations SET profile_id='other' WHERE id='desktop'");
  expect(()=>repository.resolveAgentIdentity('desktop')).toThrow(/domain changed/);
 });
 it('does not change an existing canonical binding or bind a managed target without migration',()=>{
  db.exec("UPDATE agent_installations SET desired_state='managed' WHERE id='cli'");
  expect(()=>repository.confirmSharedIdentity(input())).toThrow(/coordinated migration/);
  db.exec("UPDATE agent_installations SET desired_state='unmanaged' WHERE id='cli'");
  const plan=input();repository.confirmSharedIdentity(plan);
  expect(()=>repository.confirmSharedIdentity({...plan,evidenceHash:'b'.repeat(64)})).toThrow(/different evidence/);
 });
 it('materializes canonical coordinator control while retaining the original CAS identity',()=>{
  repository.confirmSharedIdentity(input());
  const bridge=new SqliteCoordinatorRepository(db,repository);
  const resolved=repository.coordinatorAgentIdentity('desktop');
  expect(resolved.agentId).toBe('canonical');
  expect(resolved.installationAgentId).toBe('original-desktop');
  expect(resolved.sharedIdentityBinding).toMatch(/^[a-f0-9]{64}$/);
  expect(bridge.getInstallationControl('desktop')).toMatchObject(resolved);
 });

});
