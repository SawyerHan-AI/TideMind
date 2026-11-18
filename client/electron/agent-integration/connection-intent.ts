import type Database from 'better-sqlite3'
import { agentIdentityDomainKey, supportsSharedAgentDomain } from '@server/db/agent-identity-binding.js'
import { sha256Json } from './fingerprint'
import type { AgentInstallationRow } from './repository'

export interface ConnectionIntent {
  domainKey: string
  revision: number
  state: 'active' | 'paused' | 'disconnected'
  /** Only these members may be restored by undoing a connection-wide pause. */
  pausedMemberIds: string[]
  pausedUnmanagedMemberIds?: string[]
  /** Explicit member choices survive connection-wide pause/resume. */
  excludedMemberIds: string[]
}

/** Stable before/after creating a binding, and independent of version or executable updates. */
export function connectionIntentDomain(row: AgentInstallationRow): string {
  if (supportsSharedAgentDomain(row)) {
    return `${row.family}:${agentIdentityDomainKey(row)}`
  }
  return `installation:${sha256Json([row.family, row.host_variant, row.runtime_realm,
    row.os_user_identity, row.config_root ?? row.install_key, row.profile_id])}`
}

const keyFor = (domain: string) => `agent_connection_intent:${domain}`
export function readConnectionIntent(db: Database.Database, domainKey: string): ConnectionIntent {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(keyFor(domainKey)) as { value: string } | undefined
  if (!row) return { domainKey, revision: 0, state: 'active', pausedMemberIds: [], excludedMemberIds: [] }
  const intent = JSON.parse(row.value) as ConnectionIntent
  if (intent.domainKey !== domainKey || !Number.isSafeInteger(intent.revision) || intent.revision < 1
    || !['active','paused','disconnected'].includes(intent.state)
    || !Array.isArray(intent.pausedMemberIds) || !intent.pausedMemberIds.every(id => typeof id === 'string')
    || (intent.pausedUnmanagedMemberIds !== undefined && (!Array.isArray(intent.pausedUnmanagedMemberIds) || !intent.pausedUnmanagedMemberIds.every(id => typeof id === 'string')))
    || !Array.isArray(intent.excludedMemberIds) || !intent.excludedMemberIds.every(id => typeof id === 'string')) {
    throw new Error('Invalid connection maintenance preference')
  }
  return intent
}

/** Caller may include Installation updates in the same existing SQLite transaction. */
export function changeConnectionIntent(db: Database.Database, domainKey: string,
  update: (previous: ConnectionIntent) => Omit<ConnectionIntent, 'domainKey' | 'revision'>,
): ConnectionIntent {
  return db.transaction(() => {
    const previous = readConnectionIntent(db, domainKey)
    const next = { ...update(previous), domainKey, revision: previous.revision + 1 }
    db.prepare(`INSERT INTO metadata(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(keyFor(domainKey), JSON.stringify(next))
    if (domainKey.startsWith('codex:')) {
      const binding = db.prepare('SELECT id FROM agent_identity_bindings WHERE domain_key=?')
        .get(domainKey.slice('codex:'.length)) as {id:string} | undefined
      if (binding && next.state === 'disconnected') {
        db.prepare('DELETE FROM codex_bridge_member_proofs WHERE binding_id=?').run(binding.id)
      } else if (binding && previous.state !== 'disconnected') {
        // Maintenance pauses preserve existing bridge grants. Only carry a proof
        // across this preference change when its own authorization is still live.
        db.prepare(`UPDATE codex_bridge_member_proofs AS proof SET intent_revision=?
          WHERE binding_id=? AND intent_revision=? AND EXISTS (
            SELECT 1 FROM agent_installations i JOIN agent_consents s ON s.id=i.consent_envelope_id
            JOIN artifact_consumers c ON c.installation_id=i.id AND c.artifact_id=proof.artifact_id
              AND c.component_key=proof.component_key AND c.state='active' AND c.tombstoned_at IS NULL
            WHERE i.id=proof.installation_id AND s.id=proof.consent_id AND s.status='active'
              AND c.consent_envelope_id=s.id AND i.tombstoned_at IS NULL AND i.bridge_state!='stopped'
              AND i.desired_state IN ('managed','disabled')
          )`).run(next.revision,binding.id,previous.revision)
      }
    }
    return next
  })()
}

export function allowsAutomaticConnection(intent: ConnectionIntent): boolean {
  // A newly discovered sibling must not undo a user's choice on this config domain.
  return intent.state === 'active' && intent.excludedMemberIds.length === 0
}

export function allowsConnectionMaintenance(intent: ConnectionIntent, installationId: string): boolean {
  return intent.state === 'active' && !intent.excludedMemberIds.includes(installationId)
}

export function isPausedVerifiedRun(run: { state: string; failure_code: string | null }): boolean {
  return run.state === 'verified' && run.failure_code === 'connection_intent_changed'
}
