import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { createNode } from '../../src/db/nodes'
import { DiagnosticProcessError } from '../../src/agent-diagnostic-runner'
import { completeDiagnosticDigest, completeDiagnosticRecall, countDiagnosticToolCall, diagnosticContent } from '../../src/agent-diagnostic-receipts'
import { AgentDiagnosticController, type DiagnosticControllerPorts } from '../../client/electron/agent-integration/diagnostic-controller'
import type { DiagnosticProcessSession } from '../../client/electron/agent-integration/diagnostic-process'
import { createDiagnosticFixture, MEM } from '../fixtures/agent-diagnostic-fixture'

function fixture() {
  const f = createDiagnosticFixture(false, 'Asia/Shanghai', new Date())
  fs.symlinkSync(process.execPath, f.binding().executablePath)
  const calls: string[] = []
  const exited = { reason: 'exited' as const, exitCode: 0, signal: null, processGroupExited: true,
    supervisorExited: true, rawStdoutBytes: 0, rawStderrBytes: 0, observedOutputBytes: 0, modelWindowArmed: true }
  const child: DiagnosticProcessSession = {
    pid: 123456, supervisorPid: 123455,
    identity: { protocolVersion: 1, pid: 123456, processGroupId: 123456, supervisorPid: 123455,
      startedAt: new Date().toISOString(), osStartIdentity: 'synthetic process fixture',
      executableRealpath: process.execPath, argumentsHash: 'a'.repeat(64), cwd: f.root },
    write: async () => {}, endInput: async () => {}, observeOutput: async () => {},
    armModelWindow: async () => { calls.push('arm') },
    stop: async () => { calls.push('stop'); return exited }, result: Promise.resolve(exited),
  }
  const ports: DiagnosticControllerPorts = {
    authenticate: vi.fn(async () => ({ status: 'authenticated', billing: 'confirmed_subscription', reason: 'subscription_confirmed' })),
    attest: vi.fn(async () => true),
    prepare: vi.fn(async ({ run, onProcess }) => {
      child.identity.cwd = run.dataDir
      calls.push('prepare'); onProcess(child)
      return { process: child, billing: 'confirmed_subscription', assertUnchanged: async () => {},
        submit: async () => {
          expect(f.store.get(run.runId)).toMatchObject({ phase: 'submitted', budgetReserved: true })
          expect(calls).toContain('arm'); calls.push('submit')
        }, completion: Promise.resolve({ status: 'completed', reason: 'complete' }) }
    }),
  }
  const controller = new AgentDiagnosticController(f.db, f.store, ports)
  return { ...f, calls, child, ports, controller }
}

describe('A-side diagnostic controller submission boundary', () => {
  it.each(['completed', 'failed'] as const)('verifies a real receipt with native completion %s, preserves it after cleanup and expires it after 30 days', async completionStatus => {
    const f = fixture(), original = f.ports.prepare
    f.ports.prepare = async input => {
      const native = await original(input)
      return { ...native, completion: Promise.resolve({ status: completionStatus, reason: 'synthetic_protocol_result' }), submit: async prompt => {
        await native.submit(prompt)
        const context = f.context(input.run), local = new Database(input.run.databasePath)
        try {
          ensureSchema(local)
          const caller = { agentId: f.canonical, activityGenerationToken: MEM }
          countDiagnosticToolCall(local, context, caller, 'brain_digest')
          const node = createNode(local, { content: diagnosticContent(context), source_tool: 'synthetic-controller-test' })
          completeDiagnosticDigest(local, context, caller, { status: 'processed', trace_id: 'synthetic-trace', created_nodes: [node] } as never)
          countDiagnosticToolCall(local, context, caller, 'brain_recall')
          completeDiagnosticRecall(local, context, caller, { nodes: [node] } as never)
        } finally { local.close(); f.setNow(new Date().toISOString()) }
      } }
    }
    try {
      const outcome = await f.controller.run(f.binding(), 'automatic')
      expect(outcome.status).toBe('passed')
      expect(f.store.get(outcome.runId!)).toMatchObject({ phase: 'succeeded', cleaned: true })
      expect(f.controller.state(f.binding())).toMatchObject({ status: 'passed' })
      expect(f.db.prepare('SELECT COUNT(*) n FROM nodes').get()).toEqual({ n: 0 })
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_host_activity_evidence').get()).toEqual({ n: 0 })
      f.setNow(new Date(Date.now() + 31 * 24 * 60 * 60_000).toISOString())
      expect(f.controller.state(f.binding())).toBeUndefined()
    } finally { f.close() }
  })
  it('unknown billing never prepares a native process or consumes a quota', async () => {
    const f = fixture()
    f.ports.authenticate = async () => ({ status: 'authenticated', billing: 'unknown', reason: 'billing_unconfirmed' })
    try {
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ status: 'waiting', reason: 'billing_unconfirmed' })
      expect(f.calls).toEqual([])
      expect(f.db.prepare('SELECT COUNT(*) n FROM agent_diagnostic_runs').get()).toEqual({ n: 0 })
    } finally { f.close() }
  })

  it('persists submission before sending, never trusts model completion without a real receipt, and does not automatically replay', async () => {
    const f = fixture()
    try {
      const outcome = await f.controller.run(f.binding(), 'automatic')
      expect(outcome.status).toBe('uncertain')
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
      expect(f.store.get(outcome.runId!)).toMatchObject({ phase: 'uncertain', budgetReserved: true, processesExited: true, cleaned: true })
      await f.controller.run(f.binding(), 'automatic')
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
      // Even a fresh in-memory controller must obey the durable once-per-version limit.
      const restarted = new AgentDiagnosticController(f.db, f.store, f.ports)
      expect(await restarted.run(f.binding(), 'automatic')).toMatchObject({ status: 'waiting', reason: 'configuration_already_submitted' })
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
    } finally { f.close() }
  })

  it('same-process unknown billing cannot be licensed by an unrelated successful auth probe', async () => {
    const f = fixture(), original = f.ports.prepare
    f.ports.prepare = async input => ({ ...await original(input), billing: 'unknown' })
    try {
      const result = await f.controller.run(f.binding(), 'manual')
      expect(result).toMatchObject({ status: 'waiting', reason: 'billing_unconfirmed' })
      expect(f.calls).not.toContain('submit')
      expect(f.store.get(result.runId!)).toMatchObject({ budgetReserved: false, processesExited: true, cleaned: true })
    } finally { f.close() }
  })
  it('releases a reservation when the final pre-submit profile check fails', async () => {
    const f = fixture(), original = f.ports.prepare
    f.ports.prepare = async input => ({ ...await original(input), assertUnchanged: async () => {
      expect(f.store.get(input.run.runId).phase).toBe('reserved')
      expect(f.calls).toContain('arm')
      throw new Error('synthetic profile change before submission')
    } })
    try {
      const outcome = await f.controller.run(f.binding(), 'automatic')
      expect(outcome.status).toBe('waiting')
      expect(f.store.get(outcome.runId!)).toMatchObject({ budgetReserved: false, submittedAt: null, cleaned: true })
      expect(f.calls).not.toContain('submit')
    } finally { f.close() }
  })
  it('rechecks a daily-budget wait on the next local day', async () => {
    const f = fixture()
    try {
      for (let index = 0; index < 3; index++) {
        const run = f.prepare('manual')
        f.store.reserve(run.runId, 'confirmed_subscription'); f.store.markSubmitted(run.runId)
        f.done(run.runId)
      }
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ status: 'waiting', reason: 'daily_budget_exhausted' })
      expect(f.calls).not.toContain('submit')
      vi.useFakeTimers()
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000)
      vi.setSystemTime(tomorrow); f.setNow(tomorrow.toISOString())
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ status: 'uncertain' })
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
    } finally { vi.useRealTimers(); f.close() }
  })
  it('does not cache an occupied global slot after the previous run exits', async () => {
    const f = fixture()
    try {
      const previous = f.prepare('manual')
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ reason: 'diagnostic_active' })
      f.done(previous.runId)
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ status: 'uncertain' })
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
    } finally { f.close() }
  })

  it('cancellation during preparation revokes capability and stops without submission', async () => {
    const f = fixture(), original = f.ports.prepare
    f.ports.prepare = async input => {
      const session = await original(input)
      f.controller.cancel(input.binding.domainKey)
      return session
    }
    try {
      const outcome = await f.controller.run(f.binding(), 'automatic')
      expect(outcome.status).toBe('cancelled')
      expect(f.calls).not.toContain('submit')
      expect(f.store.get(outcome.runId!)).toMatchObject({ budgetReserved: false, processesExited: true, cleaned: true })
      const oldBinding = f.binding()
      f.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(`agent_connection_intent:${oldBinding.domainKey}`,
        JSON.stringify({ domainKey: oldBinding.domainKey, revision: 1, state: 'active', excludedMemberIds: [], pausedMemberIds: [] }))
      f.ports.prepare = original
      expect(f.binding().configurationVersion).toBe(oldBinding.configurationVersion)
      expect(await f.controller.run(f.binding(), 'automatic')).toMatchObject({ status: 'uncertain' })
      expect(f.calls.filter(call => call === 'submit')).toHaveLength(1)
    } finally { f.close() }
  })
  it('retains the private directory when supervisor startup cannot confirm its child exited', async () => {
    const f = fixture()
    f.ports.prepare = async () => { throw new DiagnosticProcessError('supervisor_failed', false) }
    try {
      const outcome = await f.controller.run(f.binding(), 'automatic')
      expect(outcome).toMatchObject({ status: 'waiting', reason: 'supervisor_failed' })
      expect(f.store.get(outcome.runId!)).toMatchObject({ budgetReserved: false, processesExited: false, cleaned: false })
      expect(fs.existsSync(f.store.get(outcome.runId!).dataDir)).toBe(true)
    } finally { f.close() }
  })
})
