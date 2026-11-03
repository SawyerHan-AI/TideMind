import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import { inspectRegularFileWithinRoot } from './safe-file'
import { sha256Json } from './fingerprint'

/** Prospective identity only: no consent, host verification or historical identity transfer. */
export interface CodexFreshIdentityPlan {
  domainKey: string
  bindingId: string
  canonicalAgentId: string
  generation: number
  existingBinding: boolean
  carrierInstallationId: string | null
  members: Array<{
    id: string; agentId: string; installKey: string; domainKey: string
    desiredState: string; tombstonedAt: string | null
  }>
}

export function freshCodexIdentityFingerprint(plan: CodexFreshIdentityPlan): string {
  return sha256Json(plan)
}

export function prospectiveFreshCodexIdentity(plan: CodexFreshIdentityPlan, installationId: string) {
  const member = plan.members.find(item => item.id === installationId)
  if (!member) throw new Error('Fresh Codex identity member changed')
  return {
    agentId: plan.canonicalAgentId,
    installationAgentId: member.agentId,
    sharedIdentityBinding: sha256Json({ installationAgentId: member.agentId,
      canonicalAgentId: plan.canonicalAgentId, bindingId: plan.bindingId, bindingGeneration: plan.generation }),
  }
}

/** Fresh initialization must not silently append a second existing Tide Mind identity. */
export function assertFreshCodexConfig(plan: CodexFreshIdentityPlan, configRoot: string): void {
  if (plan.existingBinding) return
  const file=inspectRegularFileWithinRoot(path.join(configRoot,'config.toml'),configRoot)
  if (!file.exists) return
  const document=parse(fs.readFileSync(file.canonicalPath,'utf8'))
  if (document.mcp_servers && typeof document.mcp_servers==='object'
    && Object.keys(document.mcp_servers).some(key=>key.startsWith('tidemind-'))) {
    throw new Error('existing_codex_connection_requires_review')
  }
}
