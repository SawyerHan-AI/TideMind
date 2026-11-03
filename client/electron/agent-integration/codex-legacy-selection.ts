import {inspectLegacyCodexHookProof,type CodexLegacyHookProof} from './hosts/codex-lifecycle-adapter'
import fs from 'node:fs'
import {parse as parseToml} from 'smol-toml'
import { agentIdentityDomainKey } from '@server/db/agent-identity-binding.js'
import { sha256Json, sha256Bytes } from './fingerprint.js'
import { adoptionInput, installationIdentity } from './legacy-adoption.js'
import type { AgentIntegrationRepository, AgentInstallationRow } from './repository.js'
import type { AgentHostAdapter, CatalogId, AdapterRuntimeContext, AdoptableArtifactObservation, OwnedArtifactBaseline } from './types.js'

/** Only the two Codex surfaces sharing one proven legacy configuration domain. */
export interface CodexLegacySelection {
  hookProof?: CodexLegacyHookProof
  selectedAgentId: string
  members: AgentInstallationRow[]
  candidates: { agentId: string; name: string; observations: AdoptableArtifactObservation[] }[]
  adoption: Parameters<AgentIntegrationRepository['adoptSharedLegacyInstallations']>[0]
}

export async function inspectCodexLegacySelection(input: {
  repository: AgentIntegrationRepository
  adapters: ReadonlyMap<CatalogId, AgentHostAdapter>
  runtime: AdapterRuntimeContext
  installationId: string
  selectedAgentId?: string
  now: string
}): Promise<CodexLegacySelection> {
  const own = input.repository.getInstallation(input.installationId)
  if (!own) throw new Error('Codex legacy Installation disappeared')
  const domain = agentIdentityDomainKey(own)
  const members = input.repository.listInstallations({includeRemoved:false}).filter(row => {
    try { return agentIdentityDomainKey(row) === domain } catch { return false }
  }).sort((a,b)=>a.id.localeCompare(b.id))
  if (members.length !== 2 || new Set(members.map(row=>row.host_variant)).size !== 2
    || members.some(row=>row.desired_state !== 'unmanaged' || row.tombstoned_at || row.health_state !== 'discovered'
      || row.status_reason === 'conflict' || !row.agent_id || row.runtime_realm !== input.runtime.runtimeRealm
      || input.repository.resolveAgentIdentity(row.id).bindingId
      || input.repository.listComponents(row.id).length !== 0)) {
    throw new Error('Legacy selection requires two unconnected Codex surfaces without existing managed components')
  }
  const candidates: CodexLegacySelection['candidates'] = []
  const byAgent = new Map<string, AdoptableArtifactObservation[][]>()
  for (const legacy of input.repository.listLegacyAgents().filter(row=>row.tool_type === 'codex' && row.archived === 0)) {
    const proofs: AdoptableArtifactObservation[][] = []
    for (const row of members) {
      const inspect = input.adapters.get(row.host_variant as CatalogId)?.inspectAdoptableArtifacts
      if (!inspect) throw new Error('Codex legacy inspection unavailable')
      proofs.push([...(await inspect({runtime:input.runtime,installation:installationIdentity(row),agentId:legacy.id,
        operationId:'codex_legacy_selection'}))].filter(item=>item.identityAssertion === legacy.id))
    }
    if (proofs.every(proof=>proof.length === 0)) continue
    if (proofs.some(proof=>proof.filter(item=>item.componentKey==='memory_tools').length !== 1 || proof.some(item=>!['memory_tools','lifecycle'].includes(item.componentKey)))
      || sha256Json(proofs[0]) !== sha256Json(proofs[1])) throw new Error('Codex surfaces disagree on the legacy selector')
    candidates.push({agentId:legacy.id,name:legacy.name,observations:proofs[0]})
    byAgent.set(legacy.id, proofs)
  }
  candidates.sort((a,b)=>a.agentId.localeCompare(b.agentId))
  if (candidates.length < 2) throw new Error('Legacy selection no longer has multiple proven identities; scan again')
  const observedFile=candidates[0].observations.find(item=>item.componentKey==='memory_tools')!
  const bytes=fs.readFileSync(observedFile.physicalTarget)
  if(sha256Bytes(bytes)!==observedFile.containerHash)throw new Error('Codex configuration changed during selection inspection')
  const servers=parseToml(bytes.toString()).mcp_servers as Record<string,unknown> | undefined
  const provenKeys=new Set(candidates.map(candidate=>'tidemind-'+candidate.agentId))
  if(Object.keys(servers ?? {}).some(key=>key.startsWith('tidemind-') && !provenKeys.has(key))) {
    throw new Error('An existing Tide Mind selector cannot be proved; review its configuration before selecting an identity')
  }
  const selectedAgentId = input.selectedAgentId ?? candidates[0].agentId
  const legacy = input.repository.listLegacyAgents().find(row=>row.id === selectedAgentId)
  const proofs = byAgent.get(selectedAgentId)
  if (!legacy || !proofs) throw new Error('Selected legacy identity is not in the frozen candidates')
  return {
    selectedAgentId,members,candidates,
    ...( (()=>{
      const hookProof=inspectLegacyCodexHookProof({runtime:input.runtime,installation:installationIdentity(members[0]),agentId:selectedAgentId,operationId:'legacy_hook_selection'},candidates.map(item=>item.agentId))
      return hookProof?{hookProof}:{}
    })()),
    adoption:{binding:{id:`binding_${domain}`,canonicalAgentId:selectedAgentId,
      evidenceHash:sha256Json({domain,candidates,selectedAgentId}),
      members:members.map(row=>({installationId:row.id,installationAgentId:row.agent_id!,installKey:row.install_key,domainKey:domain})),
      confirmedAt:input.now},
      installations:members.map((installation,index)=>adoptionInput(legacy,{installation,observations:proofs[index]},proofs[index],input.now))},
  }
}

export function codexSelectionFingerprint(selection: CodexLegacySelection): string {
  return sha256Json({...selection,adoption:{
    binding:{...selection.adoption.binding,confirmedAt:null},
    installations:selection.adoption.installations.map(item=>({...item,adoptedAt:null})),
  }})
}

export function prospectiveCodexIdentity(selection: CodexLegacySelection, installationId: string) {
  const member=selection.members.find(row=>row.id === installationId)
  if (!member?.agent_id) throw new Error('Legacy selection Installation mismatch')
  const resolved={installationAgentId:member.agent_id,canonicalAgentId:selection.selectedAgentId,
    bindingId:selection.adoption.binding.id,bindingGeneration:1}
  return {agentId:selection.selectedAgentId,installationAgentId:member.agent_id,sharedIdentityBinding:sha256Json(resolved)}
}

export function selectedCodexBaselines(selection: CodexLegacySelection, installationId: string): OwnedArtifactBaseline[] {
  const adoption=selection.adoption.installations.find(item=>item.installationId === installationId)
  if (!adoption) throw new Error('Legacy selection baseline Installation mismatch')
  return adoption.artifacts.map(item=>({componentKey:item.componentKey,physicalTarget:item.targetPath,
    ownershipKey:item.ownershipKey,ownedFragmentHash:item.fragmentHash,selectorSchemaVersion:Number(item.selectorSchemaVersion)}))
}
