import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { AgentDiagnosticError, assertDiagnosticBindingCurrent, captureDiagnosticBinding, type DiagnosticBinding } from '@server/agent-diagnostic-contract.js'
import { verifyDiagnosticReceipt } from '@server/agent-diagnostic-receipts.js'
import type { AgentInstallationRow } from './repository'
import type { AgentIntegrationServiceDependencies } from './service'
import { AgentDiagnosticController } from './diagnostic-controller'
import { AgentDiagnosticRunStore } from './diagnostic-run-store'
import type { ClaudeDiagnosticCarrier, NativeDiagnosticInput, NativeDiagnosticSession } from './native-diagnostic-adapter'
import type { AdapterRuntimeContext, PlannedMutation } from './types'
import type { DiagnosticSupervisorLaunch } from './diagnostic-process'
import { probeAgentAuthentication } from './agent-authentication'

/** Production wiring only. No schema migration, configuration repair or permission grant. */
export function createDiagnosticService(db: Database.Database, options: {
  homeDir: string
  applicationDataDir: string
  runtimeVersion: string
  runtime: Pick<AdapterRuntimeContext, 'shimPath' | 'mcpServerPath'>
  launch: DiagnosticSupervisorLaunch
  attest(row: AgentInstallationRow): Promise<boolean>
  prepare(input: NativeDiagnosticInput): Promise<NativeDiagnosticSession>
  changed?(): void
}): NonNullable<AgentIntegrationServiceDependencies['diagnostics']> {
  const main = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
  const controlDatabasePath = main.find(row => row.name === 'main')?.file
  // An in-memory embedding cannot supply a durable submission ledger. Keep
  // discovery/configuration usable, but never start a diagnostic from it.
  if (!controlDatabasePath) return {
    state: () => undefined, memorySuccess: () => null, cancel: () => undefined,
    run: async () => ({ status: 'waiting', reason: 'diagnostic_storage_unavailable', runId: null }),
  }
  const store = new AgentDiagnosticRunStore(db, { controlDatabasePath,
    diagnosticsRoot: path.join(options.applicationDataDir, 'agent-diagnostics'),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const row = (id: string) => db.prepare('SELECT * FROM agent_installations WHERE id=?').get(id) as AgentInstallationRow | undefined
  const carrierFor = (installationId: string) => db.prepare(`SELECT p.planned_mutation_json,p.after_hash,r.prepared_plan_json
    FROM installation_components c
    JOIN projection_mutations p ON p.artifact_id=c.artifact_id AND p.state='committed'
    JOIN reconcile_runs r ON r.id=p.run_id
    WHERE c.installation_id=? AND c.component_key='memory_tools'
      AND p.idempotency_strategy!='consumer_detach_only'
    ORDER BY p.committed_at DESC,p.rowid DESC LIMIT 1`).get(installationId) as
    { planned_mutation_json: string; after_hash: string | null; prepared_plan_json: string } | undefined
  const claudeCarrierFor = (binding: DiagnosticBinding): ClaudeDiagnosticCarrier => {
    try {
      const carrier = carrierFor(binding.installationId)
      const mutation = JSON.parse(carrier?.planned_mutation_json ?? '{}') as PlannedMutation
      const metadata = mutation.metadata
      const pluginName = `tidemind-${binding.canonicalAgentId}`
      const qualifiedPlugin = metadata?.qualifiedPlugin
      const desiredFiles = metadata?.desiredFiles as Record<string, string> | undefined
      if (carrier?.after_hash === binding.components.memory_tools.ownedFragmentHash
        && mutation.desiredFragmentHash === carrier.after_hash
        && metadata?.kind === 'claude_plugin_aggregate' && metadata.direction === 'install'
        && metadata.pluginName === pluginName && typeof qualifiedPlugin === 'string'
        && qualifiedPlugin === `${pluginName}@${metadata.marketplaceId}` && desiredFiles) {
        const manifest = JSON.parse(desiredFiles[`plugins/${pluginName}/.claude-plugin/plugin.json`])
        const mcp = JSON.parse(desiredFiles[`plugins/${pluginName}/.mcp.json`])
        const expected = { mcpServers: { tidemind: { command: options.runtime.shimPath,
          args: [options.runtime.mcpServerPath], env: { EB_AGENT_ID: binding.canonicalAgentId,
            EB_HOST_VARIANT: binding.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: binding.components.memory_tools.activityGenerationToken } } } }
        if (manifest?.name === pluginName && manifest.version === metadata.pluginVersion && isDeepStrictEqual(mcp, expected)) {
          return { qualifiedPlugin, manifest, mcp }
        }
      }
    } catch { /* Missing or unreadable historical carrier cannot authorize spawn. */ }
    throw new AgentDiagnosticError('claude_managed_carrier_unavailable')
  }
  const attest = async (binding: DiagnosticBinding, signal: AbortSignal) => {
    const target = row(binding.installationId)
    return !signal.aborted && Boolean(target && await options.attest(target))
  }
  const controller = new AgentDiagnosticController(db, store, {
    attest,
    authenticate: (binding, signal) => probeAgentAuthentication({ target: { installationId: binding.installationId,
      hostVariant: binding.hostVariant, executable: binding.executablePath, configRoot: binding.configRoot, homeDir: options.homeDir },
      dataDir: options.applicationDataDir, signal, attest: (_target, abort) => attest(binding, abort) }),
    prepare: async input => options.prepare({ ...input, homeDir: options.homeDir, sourceEnv: process.env,
      launch: options.launch, attest,
      ...(['claude-code-cli', 'claude-code-native'].includes(input.binding.hostVariant)
        ? { claudeCarrier: claudeCarrierFor(input.binding) } : {}),
    }),
    changed: options.changed,
  })
  const bindingFor = (target: AgentInstallationRow): DiagnosticBinding => {
    // The original committed carrier owns the generation; never mint a token
    // for a diagnostic or infer it from an arbitrary observed host file.
    const carrier = carrierFor(target.id)
    let token: unknown
    try { token = JSON.parse(carrier?.prepared_plan_json ?? '{}').activityGenerationToken } catch { /* Stable classification below. */ }
    if (typeof token !== 'string' || !token) throw new AgentDiagnosticError('generation_unavailable')
    return captureDiagnosticBinding(db, target.id, { memory_tools: token }, { runtimeVersion: options.runtimeVersion })
  }
  store.recoverInterruptedRuns()
  let cleanupTask: Promise<void> | null = null
  const cleanupPending = (): Promise<void> => cleanupTask ??= (async () => {
    for (const pending of store.listPendingCleanup()) {
      const assessment = await store.assessRestartCleanup(pending.runId)
      if (assessment.canCleanup) {
        if (pending.phase === 'uncertain' && pending.submittedAt) {
          try {
            const binding = store.bindingForRun(pending.runId)
            assertDiagnosticBindingCurrent(db, binding)
            if (!await attest(binding, new AbortController().signal)) throw new AgentDiagnosticError('source_attestation_failed')
            const context = store.receiptContext(pending.runId)
            const Constructor = db.constructor as new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => Database.Database
            const isolated = new Constructor(context.databasePath, { readonly: true, fileMustExist: true })
            const receipt = (() => { try { return verifyDiagnosticReceipt(isolated, context) } finally { isolated.close() } })()
            store.recordControllerVerifiedSuccess(pending.runId, receipt.readCompletedAt!)
          } catch { /* Incomplete/stale receipt remains uncertain; never replay the model request. */ }
        }
        if (!pending.processesExited) store.confirmProcessesExited(pending.runId)
        store.cleanup(pending.runId)
        options.changed?.()
      }
    }
  })().finally(() => { cleanupTask = null })
  // Startup cleanup failure must not become an unhandled rejection. Its durable
  // active slot remains occupied until a later successful liveness observation.
  void cleanupPending().catch(() => undefined)
  return {
    memorySuccess: target => store.getCurrentMemorySuccess(target.id, options.runtimeVersion),
    state: target => {
      const success = store.getCurrentMemorySuccess(target.id, options.runtimeVersion)
      if (success) return { status: 'passed', reason: 'controller_verified', runId: success.runId, lastTestAt: success.verifiedAt }
      if (target.desired_state !== 'managed') return undefined
      if (!['codex-cli','claude-code-cli','claude-code-native'].includes(target.host_variant)) {
        return { status: 'waiting', reason: 'native_diagnostic_unsupported', runId: null }
      }
      try {
        const state = controller.state(bindingFor(target))
        if (!state) return { status: 'waiting', reason: 'awaiting_diagnostic', runId: null }
        const run = state.runId ? store.get(state.runId) : null
        return { ...state, lastTestAt: run?.submittedAt ? run.finishedAt ?? run.submittedAt : null }
      }
      catch { return undefined }
    },
    run: async (target, mode) => {
      // A supervisor may still be exiting at startup. Recheck before each new
      // request so its former active slot is not stranded for this app session.
      await cleanupPending().catch(() => undefined)
      if (!['codex-cli','claude-code-cli','claude-code-native'].includes(target.host_variant)) return { status: 'waiting', reason: 'native_diagnostic_unsupported', runId: null }
      try { return await controller.run(bindingFor(target), mode) }
      catch (error) { return { status: 'waiting', reason: error instanceof AgentDiagnosticError ? error.code : 'diagnostic_unavailable', runId: null } }
    },
    cancel: domainKey => controller.cancel(domainKey),
  }
}
