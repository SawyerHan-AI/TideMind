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
export function assertFreshCodexConfig(plan: CodexFreshIdentityPlan, configRoot: string, family = 'codex'): void {
  if (plan.existingBinding) return
  if (family === 'antigravity') {
    const file = inspectRegularFileWithinRoot(path.join(configRoot, 'mcp_config.json'), configRoot)
    if (!file.exists) return
    const source = fs.readFileSync(file.canonicalPath, 'utf8')
    const document: unknown = source.trim() ? JSON.parse(source) : {}
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid_antigravity_mcp_config')
    const servers = (document as Record<string, unknown>).mcpServers
    if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('invalid_antigravity_mcp_config')
    if (servers && Object.keys(servers).some(key => key === 'tidemind' || key.startsWith('tidemind-'))) {
      throw new Error('existing_antigravity_connection_requires_review')
    }
    return
  }
  if (family !== 'codex') throw new Error('unsupported_shared_configuration_domain')
  const file=inspectRegularFileWithinRoot(path.join(configRoot,'config.toml'),configRoot)
  if (!file.exists) return
  const document=parse(fs.readFileSync(file.canonicalPath,'utf8'))
  if (document.mcp_servers && typeof document.mcp_servers==='object'
    && Object.keys(document.mcp_servers).some(key=>key.startsWith('tidemind-'))) {
    throw new Error('existing_codex_connection_requires_review')
  }
}
