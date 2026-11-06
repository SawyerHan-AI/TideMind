import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../src/db/schema'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { AgentIntegrationService, type AgentIntegrationServiceDependencies } from '../../client/electron/agent-integration/service'
import type { AgentAuthenticationResult } from '../../client/electron/agent-integration/agent-authentication'

function fixture(probe: (signal: AbortSignal) => Promise<AgentAuthenticationResult>, diagnostics?: AgentIntegrationServiceDependencies['diagnostics']) {
  const db = new Database(':memory:'); ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({ id: 'codex', family: 'codex', hostVariant: 'codex-cli', installKey: 'codex:fixture',
    provenance: 'fixture', osUserIdentity: 'fixture-user', displayName: 'Codex', configRoot: '/Users/alice/.codex',
    executablePath: '/fixture/codex', detectedVersion: '1.0.0', agentId: 'eb_fixture', supportedCapability: 4, lastDetectedAt: '2026-11-06T00:00:00Z' })
  repository.setInstallationIntent('codex', 'managed', '2026-11-06T00:00:00Z')
  const execution = { preview: vi.fn(), applyPrepared: vi.fn() }
  const probeAuthentication = vi.fn((_row, signal: AbortSignal) => probe(signal))
  const service = new AgentIntegrationService({ repository, execution, probeAuthentication, diagnostics,
    automaticConnections: { enabled: true, applicationDataDir: '/fixture' }, canManageInstallation: () => true,
    scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) }, homeDir: '/Users/alice',
    now: () => new Date('2026-11-06T01:00:00Z') })
  return { db, repository, execution, service, probeAuthentication, close: () => { service.stopAutomaticRescans(); db.close() } }
}

describe('Agent authentication UI service', () => {
  it('notifies checking and completion, isolates listener errors, and supports unsubscribe', async () => {
    let release!: (value: AgentAuthenticationResult) => void
    const gate = new Promise<AgentAuthenticationResult>(resolve => { release = resolve })
    const f = fixture(() => gate)
    const observed: Array<string | undefined> = []
    const stopBad = f.service.onStateChanged(() => { throw new Error('synthetic renderer failure') })
    const stop = f.service.onStateChanged(() => { observed.push(f.service.snapshot().installations[0].authentication?.status) })
    try {
      const pending = f.service.recheckAuthentication('codex')
      expect(observed).toEqual(['checking'])
      release({ status: 'authenticated', billing: 'unknown', reason: 'billing_unconfirmed' })
      await pending
      expect(observed).toEqual(['checking', 'authenticated'])
      stop(); stopBad()
      f.service.notifyStateChanged()
      expect(observed).toHaveLength(2)
    } finally { stop(); stopBad(); f.close() }
  })
  it('retries diagnostics through the bound installation and persists pause before cancelling', async () => {
    const diagnostics = { state: () => undefined, memorySuccess: () => null,
      run: vi.fn(async () => ({ status: 'waiting' as const, reason: 'billing_unconfirmed', runId: null })), cancel: vi.fn() }
    const f = fixture(async () => ({ status: 'authenticated', billing: 'unknown', reason: 'billing_unconfirmed' }), diagnostics)
    try {
      expect(await f.service.recheckDiagnostic('codex')).toMatchObject({ reason: 'billing_unconfirmed' })
      expect(diagnostics.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), 'manual')
      diagnostics.cancel.mockImplementation(() => { expect(f.db.prepare("SELECT desired_state FROM agent_installations WHERE id='codex'").get()).toEqual({ desired_state: 'disabled' }) })
      f.service.pause('codex')
      expect(diagnostics.cancel).toHaveBeenCalled()
      await expect(f.service.recheckDiagnostic('codex')).rejects.toThrow('diagnostic_check_unavailable')
      expect(diagnostics.run).toHaveBeenCalledTimes(1)
    } finally { f.close() }
  })
  it('coalesces login rechecks without creating configuration or verification evidence', async () => {
    let release!: (value: AgentAuthenticationResult) => void
    const gate = new Promise<AgentAuthenticationResult>(resolve => { release = resolve })
    const f = fixture(() => gate)
    try {
      const one = f.service.recheckAuthentication('codex'), two = f.service.recheckAuthentication('codex')
      expect(f.service.snapshot().installations[0].authentication?.status).toBe('checking')
      expect(f.probeAuthentication).toHaveBeenCalledTimes(1)
      release({ status: 'authenticated', billing: 'metered', reason: 'metered_authentication' })
      expect(await one).toEqual(await two)
      expect(f.service.snapshot().installations[0].authentication).toMatchObject({ status: 'authenticated', billing: 'metered' })
      expect(f.service.snapshot().connections[0].memoryCallsVerified).toBe(false)
      expect(f.db.prepare('SELECT COUNT(*) n FROM verification_results').get()).toEqual({ n: 0 })
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_consents').get()).toEqual({ n: 0 })
      expect(f.execution.applyPrepared).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it('discards an ignored cancellation after pause instead of recording a late login success', async () => {
    let release!: (value: AgentAuthenticationResult) => void
    const gate = new Promise<AgentAuthenticationResult>(resolve => { release = resolve })
    let signal!: AbortSignal
    const f = fixture(value => { signal = value; return gate })
    try {
      const pending = f.service.recheckAuthentication('codex')
      f.service.pause('codex')
      expect(signal.aborted).toBe(true)
      release({ status: 'authenticated', billing: 'confirmed_subscription', reason: 'subscription_confirmed' })
      expect(await pending).toMatchObject({ status: 'cancelled' })
      expect(f.service.snapshot().installations[0]).toMatchObject({ desiredState: 'disabled', authentication: { status: 'not_checked' } })
    } finally { f.close() }
  })
  it('only reports login required for explicit host evidence, and clears it on recheck', async () => {
    let response: AgentAuthenticationResult = { status: 'unavailable', billing: 'unknown', reason: 'auth_timeout' }
    const f = fixture(async () => response)
    try {
      await f.service.recheckAuthentication('codex')
      expect(f.service.snapshot().installations[0].statusReason).not.toBe('authentication_required')
      response = { status: 'explicitly_unauthenticated', billing: 'unknown', reason: 'host_reports_not_authenticated' }
      await f.service.recheckAuthentication('codex')
      expect(f.service.snapshot().installations[0]).toMatchObject({ statusGroup: 'needs_attention', statusReason: 'authentication_required' })
      response = { status: 'authenticated', billing: 'unknown', reason: 'billing_unconfirmed' }
      await f.service.recheckAuthentication('codex')
      expect(f.service.snapshot().installations[0].statusReason).not.toBe('authentication_required')
    } finally { f.close() }
  })
  it('rejects a result after the installation version changes', async () => {
    let release!: (value: AgentAuthenticationResult) => void
    const gate = new Promise<AgentAuthenticationResult>(resolve => { release = resolve })
    const f = fixture(() => gate)
    try {
      const pending = f.service.recheckAuthentication('codex')
      f.db.prepare("UPDATE agent_installations SET detected_version='2.0.0' WHERE id='codex'").run()
      release({ status: 'authenticated', billing: 'confirmed_subscription', reason: 'subscription_confirmed' })
      expect(await pending).toMatchObject({ status: 'cancelled' })
      expect(f.service.snapshot().installations[0].authentication?.status).toBe('not_checked')
    } finally { f.close() }
  })
})
