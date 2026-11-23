import { randomUUID } from 'node:crypto'
import { compareCodexMcpSemantics } from '@server/utils/codex-mcp-semantic.js'
import { readManagedTextSnapshot } from './safe-file.js'
import type { AdapterRuntimeContext } from './types.js'
import type { CoordinatorInstallation, WriterFenceLease } from './coordinator.js'
import type { SqliteCoordinatorRepository, CodexMcpReadbackCandidate } from './coordinator-repository.js'

export interface CodexMcpReadbackDependencies {
  repository: SqliteCoordinatorRepository
  runtime: AdapterRuntimeContext
  attest(installation: CoordinatorInstallation, expectedFingerprint?: string, signal?: AbortSignal): Promise<string | null>
  enabled(installation: CoordinatorInstallation): boolean
  canPublish?(): boolean
  diagnostic?(candidate: CodexMcpReadbackCandidate, reason: string): void
}

/** Main-process-only producer. No adapter effects, model calls or configuration
 * writes occur here. Member facts can accumulate before the whole domain grants
 * service; shutdown invalidates collection without revoking valid active grants. */
export class CodexMcpSemanticReadback {
  private epoch = randomUUID()
  private stopped = false
  private running: Promise<boolean> | null = null
  private readonly abort = new AbortController()

  constructor(private readonly dependencies: CodexMcpReadbackDependencies) {}

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    const old = this.epoch
    this.epoch = randomUUID()
    try { this.dependencies.repository.discardCodexMcpCollections(old) }
    catch { /* A closed/busy DB may retain facts, but the old epoch cannot activate. */ }
  }

  renew(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.running) return this.running
    const epoch = this.epoch
    this.running = this.run(epoch).finally(() => { this.running = null })
    return this.running
  }

  private async run(epoch: string): Promise<boolean> {
    let retry = false
    const repository = this.dependencies.repository
    const current = () => !this.stopped && epoch === this.epoch && (this.dependencies.canPublish?.() ?? true)
    for (const observed of repository.listCodexMcpSemanticCandidates()) {
      if (!current()) break
      if (!this.dependencies.enabled(observed.installation)) continue
      let execution: {assertOwned():void;release():void} | null = null
      let lease: WriterFenceLease | null = null
      try {
        execution = repository.acquireExecutionFence(observed.runId)
        if (!execution) { retry = true; continue }
        lease = repository.acquireWriterFence(observed.mutationDomain)
        if (!lease) { retry = true; continue }
        const heldExecution = execution
        const heldLease = lease
        const candidate = repository.codexMcpSemanticSnapshot(observed.installation.id)
        if (!candidate || candidate.runId !== observed.runId || candidate.mutationDomain !== observed.mutationDomain) { retry = true; continue }
        const safety = {
          collectionEpoch:epoch,runtime:this.dependencies.runtime,
          assertCurrent:() => {
            if (!current()) throw new Error('Codex readback collection stopped')
            heldExecution.assertOwned()
            heldLease.assertOwned()
          },
        }
        safety.assertCurrent()
        const snapshot = readManagedTextSnapshot(candidate.anchor.target_path,candidate.installation.identity.canonicalConfigRoot)
        const comparison = compareCodexMcpSemantics(candidate.expectedBlock,snapshot.content,candidate.anchor.ownership_key)
        if (!('expected' in comparison)) {
          safety.assertCurrent()
          if (repository.codexMcpSemanticSnapshot(candidate.installation.id)?.fingerprint===candidate.fingerprint) {
            repository.discardChangedCodexMcpReadback(candidate)
          }
          this.diagnostic(candidate,comparison.reason)
          continue
        }
        if (repository.codexMcpReadbackHasPermanentSourceBlock(candidate)) {
          this.diagnostic(candidate,'source_rejected')
          continue
        }
        const evidence = repository.codexMcpReadbackEvidenceState(candidate,snapshot,epoch)
        if (evidence === 'serving') continue
        if (evidence === 'missing') {
          const source = await this.attest(candidate.installation)
          if (!current()) break
          if (!source) { retry = true; continue }
          // The final live source check is the last await before the synchronous
          // file/ledger/fence recheck and collection transaction.
          const finalSource = await this.attest(candidate.installation,source)
          if (!current()) break
          if (finalSource !== source) { retry = true; continue }
          repository.collectCodexMcpReadback(candidate,snapshot,source,safety)
        }
        safety.assertCurrent()
        const result = repository.activateCodexMcpReadbacks(candidate,snapshot,safety)
        if (result.status === 'pending') retry = true
        else if (result.status === 'blocked') this.diagnostic(candidate,result.reason)
      } catch {
        if (current()) {
          retry = true
          this.diagnostic(observed,'readback_observation_changed')
        }
      } finally {
        for (const held of [lease,execution]) {
          try { held?.release() }
          catch { if (current()) { retry=true; this.diagnostic(observed,'readback_lease_release_failed') } }
        }
      }
    }
    return current() && retry
  }

  private async attest(installation: CoordinatorInstallation, expectedFingerprint?: string): Promise<string | null> {
    const signal=this.abort.signal
    signal.throwIfAborted()
    let cancel!:()=>void
    const cancelled=new Promise<never>((_resolve,reject)=>{
      cancel=()=>reject(new Error('Codex readback attestation cancelled'))
      signal.addEventListener('abort',cancel,{once:true})
    })
    try {
      // A shared Desktop verification may serve other callers. Cancel only our
      // wait and release our leases; the read-only shared job is not our process
      // to terminate. The producer never consumes its late result.
      return await Promise.race([this.dependencies.attest(installation,expectedFingerprint,signal),cancelled])
    } finally {signal.removeEventListener('abort',cancel)}
  }

  private diagnostic(candidate: CodexMcpReadbackCandidate, reason: string): void {
    if (this.stopped) return
    // Keep private paths, frozen projection content and generation values out of
    // diagnostic payloads. Diagnostic persistence cannot starve another member.
    try { this.dependencies.diagnostic?.(candidate,reason) } catch { /* bounded best effort */ }
  }
}
