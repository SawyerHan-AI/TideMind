import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { parse, stringify } from 'smol-toml'
import { ensureSchema } from '../../src/db/schema.js'
import { evaluateBridgeAdmission } from '../../src/agent-bridge-guard.js'
import { captureBridgeAnchor, currentBridgeFileIdentity, currentCodexMemberSurface, publishAttestedBridgeMember } from '../../src/db/codex-bridge-continuity.js'
import { adoptProvableLegacyConnections } from '../../client/electron/agent-integration/legacy-adoption.js'
import { bindAgentIntegrationExecutionPort, createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service.js'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry.js'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity.js'
import { CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION, MAX_CLI_EXECUTABLE_PROOF_BYTES } from '../../client/electron/agent-integration/discovery.js'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types.js'

/** Real service/plan/journal/file fixture; only native host discovery/attestation
 * is synthetic. No actual host, account, model or personal database is used. */
export async function createCodexSemanticComposition(autoRestore = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-semantic-flow-')))
  const home = path.join(root, 'home'), configRoot = path.join(home, '.codex'), appData = path.join(root, 'data')
  for (const dir of [configRoot, appData, path.join(root, 'bin')]) fs.mkdirSync(dir, { recursive: true })
  const db = new Database(':memory:')
  ensureSchema(db)
  const runtime: AdapterRuntimeContext = { runtimeRealm:'local_macos',homeDir:home,applicationDataDir:appData,
    shimPath:path.join(root,'bin','tm-node'),mcpServerPath:path.join(root,'bin','mcp-server.cjs'),
    hookScriptPath:path.join(root,'bin','hook.cjs'),preCompactScriptPath:path.join(root,'bin','pre.cjs'),
    postCompactScriptPath:path.join(root,'bin','post.cjs'),tideMindVersion:'synthetic-test',catalogVersion:'1',projectionVersion:'1' }
  const all = createP0HostAdapters()
  const adapters = new Map([['codex-cli',all.get('codex-cli')!],['codex-desktop',all.get('codex-desktop')!]] as const)
  const composition = createProductionAgentIntegrationComposition(db,{homeDir:home,applicationDataDir:appData,runtimeContext:runtime,
    adapters,enabledAdapterIds:[...adapters.keys()],observeOnly:false,autoRestore,startRuntime:false,fixtureMode:'isolated_ui_audit',
    canManageInstallation:()=>true,scanner:{scan:async()=>({installations:[],unresolved:[],diagnostics:[]})},
    notifications:{deliver:async()=>undefined} })
  const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
  try {
    for (const variant of ['codex-cli','codex-desktop'] as const) {
      const executable = path.join(root,'bin',variant)
      fs.writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o700})
      const identity = canonicalizeInstallationIdentity({runtimeRealm:'local_macos',osUserIdentity:'synthetic-user',productFamilyId:'codex',
        hostVariant:variant,configRoot,distribution:{distributionId:'cli:'+variant,executableRealpath:executable,
          packageProvenance:'fixture',capabilityFingerprint:'fixture-'+variant}})
      composition.repository.upsertDiscoveredInstallation({id:variant,family:'codex',hostVariant:variant,runtimeRealm:'local_macos',
        osUserIdentity:'synthetic-user',installKey:identity.installKey,distributionId:'cli:'+variant,provenance:'fixture',displayName:variant,
        configRoot,executablePath:executable,detectedVersion:variant==='codex-cli'?'0.167.1':'26.1117.41037',agentId:'original-'+variant,
        supportedCapability:4,lastDetectedAt:new Date().toISOString(),metadata:{distribution:identity.distribution,
          managementEligibility:{schemaVersion:CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,eligible:true,
            executableSizeBytes:fs.statSync(executable).size,proofLimitBytes:MAX_CLI_EXECUTABLE_PROOF_BYTES}}})
    }
    db.exec("INSERT INTO agents(id,name,tool_type,created) VALUES ('canonical','synthetic','codex','2026-01-01')")
    const configFile = path.join(configRoot,'config.toml')
    fs.writeFileSync(configFile,`[mcp_servers.tidemind-canonical]\nenabled = true\ncommand = ${JSON.stringify(runtime.shimPath)}\nargs = [${JSON.stringify(runtime.mcpServerPath)}]\nenv = { EB_AGENT_ID = "canonical" }\n`)
    const adopted = await adoptProvableLegacyConnections({repository:composition.repository,adapters,runtime,now:new Date().toISOString()})
    if (adopted.adopted!==1) throw new Error('synthetic legacy adoption did not complete')
    for (const id of ['codex-cli','codex-desktop']) {
      const preview = await composition.service.previewConnect([id],true,undefined,{withoutLifecycleInstallationIds:[id]})
      const result = await composition.service.applyConnect(preview.planHash,[id])
      if (result.results[0]?.status!=='awaiting_verification') throw new Error('synthetic managed installation failed: '+JSON.stringify(result))
    }
    const canonical = composition.repository.resolveAgentIdentity('codex-cli').canonicalAgentId
    const bindingId = composition.repository.resolveAgentIdentity('codex-cli').bindingId!
    const original = fs.readFileSync(configFile,'utf8')
    const entry = (parse(original).mcp_servers as Record<string,{env:Record<string,string>}>)[`tidemind-${canonical}`]
    const token = entry.env.EB_ACTIVITY_GENERATION_TOKEN
    const artifactId = (db.prepare("SELECT artifact_id FROM installation_components WHERE installation_id='codex-cli' AND component_key='memory_tools'").get() as {artifact_id:string}).artifact_id
    const anchor = captureBridgeAnchor(db,bindingId,artifactId,'memory_tools')!
    if (!anchor) throw new Error('synthetic physical journal lacks an anchor')
    // Seed the previously attested baseline through the real exact publisher,
    // not by making the new recovery implementation pre-approve itself.
    for (const id of ['codex-cli','codex-desktop']) db.transaction(()=>publishAttestedBridgeMember(db,anchor,{
      installationId:id,consentId:composition.repository.getInstallation(id)!.consent_envelope_id!,
      surface:currentCodexMemberSurface(db,id)!,source:'1'.repeat(64),fileIdentity:currentBridgeFileIdentity(configFile)!,
      intentRevision:composition.repository.connectionIntent(id).revision,observedAt:new Date().toISOString(),
    })).immediate()
    await composition.runtime.markScanCompleted()
    const rewrite = () => {
      const doc = parse(original)
      const server = (doc.mcp_servers as Record<string,Record<string,unknown>>)[`tidemind-${canonical}`]
      delete server.enabled
      const bytes = stringify(doc)
      fs.writeFileSync(configFile,bytes)
      return bytes
    }
    return {root,home,db,runtime,composition,configFile,artifactId,canonical,bindingId,token,anchor,original,rewrite,
      admit:()=>evaluateBridgeAdmission(db,{agentId:canonical,activityGenerationToken:token}),
      close:()=>{composition.runtime.stop();unbind();db.close();fs.rmSync(root,{recursive:true,force:true})} }
  } catch (error) {
    composition.runtime.stop();unbind();db.close();fs.rmSync(root,{recursive:true,force:true});throw error
  }
}
