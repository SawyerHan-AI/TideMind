import type { DiagnosticBinding } from '@server/agent-diagnostic-contract.js'
import type { DiagnosticProcessSession, DiagnosticSupervisorLaunch } from './diagnostic-process'
import type { PreparedDiagnosticRun } from './diagnostic-run-store'

export interface ClaudeDiagnosticCarrier {
  qualifiedPlugin: string
  manifest: Record<string, unknown>
  mcp: Record<string, unknown>
}

/** Composition adds host environment/runtime; controller owns budget and outcome. */
export interface NativeDiagnosticInput {
  binding: DiagnosticBinding
  run: PreparedDiagnosticRun
  homeDir: string
  sourceEnv: NodeJS.ProcessEnv
  launch: DiagnosticSupervisorLaunch
  signal: AbortSignal
  attest(binding: DiagnosticBinding, signal: AbortSignal): Promise<boolean>
  claudeCarrier?: ClaudeDiagnosticCarrier
  /** Called synchronously as soon as the supervised native process is ready. */
  onProcess(process: DiagnosticProcessSession): void
}

export interface NativeDiagnosticSession {
  process: DiagnosticProcessSession
  billing: 'confirmed_subscription' | 'metered' | 'unknown'
  /** No prompt/model request is sent until the controller arms and records submission. */
  submit(prompt: string): Promise<void>
  completion: Promise<{ status: 'completed' | 'permission_required' | 'failed'; reason: string }>
  /** Controller performs this final asynchronous recheck after arming and before
   * markSubmitted. submit must then send once without another metadata round trip. */
  assertUnchanged(): Promise<void>
}

export class NativeDiagnosticError extends Error {
  constructor(readonly code: string) {
    super(`native_diagnostic:${code}`)
    this.name = 'NativeDiagnosticError'
  }
}
