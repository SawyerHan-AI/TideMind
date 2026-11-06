import type Database from 'better-sqlite3'
import { AgentDiagnosticError, assertDiagnosticBindingCurrent, type DiagnosticBinding } from '@server/agent-diagnostic-contract.js'
import { diagnosticContent, verifyDiagnosticReceipt } from '@server/agent-diagnostic-receipts.js'
import type { AgentAuthenticationResult } from './agent-authentication'
import type { DiagnosticProcessSession } from './diagnostic-process'
import { AgentDiagnosticRunStore, type PreparedDiagnosticRun } from './diagnostic-run-store'
import type { NativeDiagnosticSession } from './native-diagnostic-adapter'

export interface DiagnosticControllerPorts {
  authenticate(binding: DiagnosticBinding, signal: AbortSignal): Promise<AgentAuthenticationResult>
  attest(binding: DiagnosticBinding, signal: AbortSignal): Promise<boolean>
  prepare(input: { binding: DiagnosticBinding; run: PreparedDiagnosticRun; signal: AbortSignal;
    onProcess(process: DiagnosticProcessSession): void }): Promise<NativeDiagnosticSession>
  changed?(): void
}
export interface DiagnosticOutcome {
  status: 'checking' | 'passed' | 'waiting' | 'uncertain' | 'cancelled'
  reason: string
  runId: string | null
}
function reason(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'diagnostic_failed'
}

/** A-side orchestration. The native model never decides whether verification passed. */
export class AgentDiagnosticController {
  private active: { binding: DiagnosticBinding; abort: AbortController; promise: Promise<DiagnosticOutcome>; runId: string | null } | null = null
  private readonly observations = new Map<string, { version: string; intentRevision: number; day: string; outcome: DiagnosticOutcome }>()
  constructor(private readonly db: Database.Database, private readonly store: AgentDiagnosticRunStore,
    private readonly ports: DiagnosticControllerPorts) {}

  state(binding: DiagnosticBinding): DiagnosticOutcome | undefined {
    if (this.active?.binding.connectionKey === binding.connectionKey) return { status: 'checking', reason: 'checking', runId: this.active.runId }
    if (this.store.hasCurrentMemorySuccess(binding)) return { status: 'passed', reason: 'controller_verified', runId: null }
    const observed = this.observations.get(binding.connectionKey)
    return observed?.version === binding.configurationVersion && observed.intentRevision === binding.intentRevision
      && observed.outcome.status !== 'passed' ? observed.outcome : undefined
  }

  /** Intent must be persisted by the service before this cancellation is called. */
  cancel(domainKey?: string): void {
    if (!this.active || (domainKey && this.active.binding.domainKey !== domainKey)) return
    if (this.active.runId) this.store.cancel(this.active.runId)
    this.active.abort.abort()
  }

  run(binding: DiagnosticBinding, mode: 'automatic' | 'manual'): Promise<DiagnosticOutcome> {
    if (this.store.hasCurrentMemorySuccess(binding)) return Promise.resolve({ status: 'passed', reason: 'controller_verified', runId: null })
    if (this.active) return this.active.binding.connectionKey === binding.connectionKey
      && this.active.binding.configurationVersion === binding.configurationVersion && this.active.binding.intentRevision === binding.intentRevision ? this.active.promise
      : Promise.resolve({ status: 'waiting', reason: 'another_diagnostic_running', runId: null })
    const prior = this.observations.get(binding.connectionKey)
    // A failed free preflight should not launch on every snapshot. Explicit retry
    // or a changed configuration may retry; durable paid limits remain in store.
    if (mode === 'automatic' && prior?.version === binding.configurationVersion && prior.intentRevision === binding.intentRevision && prior.outcome.status !== 'passed'
      && prior.outcome.reason !== 'diagnostic_active'
      && !(prior.outcome.reason === 'daily_budget_exhausted' && prior.day !== new Date().toDateString())) return Promise.resolve(prior.outcome)
    const abort = new AbortController()
    const task = { binding, abort, promise: Promise.resolve(null as unknown as DiagnosticOutcome), runId: null as string | null }
    this.active = task
    task.promise = this.execute(binding, mode, abort.signal, id => { task.runId = id }).then(outcome => {
      this.observations.set(binding.connectionKey, { version: binding.configurationVersion, intentRevision: binding.intentRevision,
        day: new Date().toDateString(), outcome })
      return outcome
    }).finally(() => { if (this.active === task) this.active = null; this.ports.changed?.() })
    this.ports.changed?.()
    return task.promise
  }

  private async execute(binding: DiagnosticBinding, mode: 'automatic' | 'manual', signal: AbortSignal,
    prepared: (runId: string) => void): Promise<DiagnosticOutcome> {
    let run: PreparedDiagnosticRun | undefined
    let child: DiagnosticProcessSession | undefined
    let submitted = false
    let preparationExitUnconfirmed = false
    const current = async () => {
      if (signal.aborted) throw new AgentDiagnosticError('cancelled')
      assertDiagnosticBindingCurrent(this.db, binding)
      if (!await this.ports.attest(binding, signal)) throw new AgentDiagnosticError('source_attestation_failed')
      if (signal.aborted) throw new AgentDiagnosticError('cancelled')
      assertDiagnosticBindingCurrent(this.db, binding)
    }
    const verifyReceipt = () => {
      const context = this.store.receiptContext(run!.runId)
      const Constructor = this.db.constructor as new (filename: string, options: { readonly: boolean; fileMustExist: boolean }) => Database.Database
      const isolated = new Constructor(context.databasePath, { readonly: true, fileMustExist: true })
      const receipt = (() => { try { return verifyDiagnosticReceipt(isolated, context) } finally { isolated.close() } })()
      this.store.recordControllerVerifiedSuccess(run!.runId, receipt.readCompletedAt!)
    }
    try {
      await current()
      const auth = await this.ports.authenticate(binding, signal)
      if (auth.status !== 'authenticated' || auth.billing !== 'confirmed_subscription') {
        return { status: signal.aborted ? 'cancelled' : 'waiting', reason: auth.reason, runId: null }
      }
      await current()
      run = this.store.prepare({ binding, mode, allowedOperations: ['brain_prepare', 'brain_digest', 'brain_recall'] })
      prepared(run.runId)
      const native = await this.ports.prepare({ binding, run, signal, onProcess: process => {
        child = process
        this.store.recordProcessIdentity(run!.runId, process.identity)
      } })
      child = native.process
      // Same-native-process confirmation is required. A separate auth probe
      // cannot license a model route whose billing the adapter cannot establish.
      if (native.billing !== 'confirmed_subscription') throw new AgentDiagnosticError('billing_unconfirmed')
      await current()
      const reserved = this.store.reserve(run.runId, native.billing)
      await native.process.armModelWindow(Date.parse(reserved.expiresAt))
      await native.assertUnchanged()
      if (signal.aborted) throw new AgentDiagnosticError('cancelled')
      this.store.markSubmitted(run.runId)
      submitted = true
      await native.submit(`Check this existing Tide Mind connection. Use only brain_digest with exactly ${JSON.stringify({ content: diagnosticContent(run), async: false })}. After status processed, call brain_recall with only its returned node_id. Then stop. Use no other tools and no more than four calls.`)
      const completion = await native.completion
      if (completion.status !== 'completed') throw new AgentDiagnosticError(completion.status === 'permission_required' ? 'native_permission_required' : 'native_diagnostic_failed')
      const exit = await native.process.stop()
      if (!exit.processGroupExited || !exit.supervisorExited) throw new AgentDiagnosticError('process_exit_unconfirmed')
      await current()
      verifyReceipt()
      return { status: 'passed', reason: 'controller_verified', runId: run.runId }
    } catch (error) {
      preparationExitUnconfirmed = Boolean(error && typeof error === 'object'
        && 'processExitConfirmed' in error && error.processExitConfirmed === false)
      const code = signal.aborted ? 'cancelled' : reason(error)
      if (run) this.store.fail(run.runId, code)
      // A lost final protocol message is not evidence that the tools failed.
      // Revoke/stop first, then read the completed private receipt without
      // resubmitting or reviving its capability. User cancellation stays stopped.
      if (run && child && submitted && !signal.aborted) {
        const exit = await child.stop()
        if (exit.processGroupExited && exit.supervisorExited) {
          try {
            await current()
            verifyReceipt()
            return { status: 'passed', reason: 'controller_verified', runId: run.runId }
          } catch { /* No complete current proof: retain the uncertain outcome. */ }
        }
      }
      return { status: signal.aborted ? 'cancelled' : submitted ? 'uncertain' : 'waiting', reason: code, runId: run?.runId ?? null }
    } finally {
      if (run) {
        // Revoke first, then stop. An error cannot leave a usable diagnostic cap.
        if (!['succeeded', 'failed', 'released', 'cancelled', 'uncertain'].includes(this.store.get(run.runId).phase)) this.store.cancel(run.runId)
        const exit = child ? await child.stop() : null
        if ((!child && !preparationExitUnconfirmed) || (exit?.processGroupExited && exit.supervisorExited)) {
          this.store.confirmProcessesExited(run.runId)
          this.store.cleanup(run.runId)
        }
      }
    }
  }
}
