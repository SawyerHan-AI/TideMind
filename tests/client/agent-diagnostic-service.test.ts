import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { createDiagnosticService } from '../../client/electron/agent-integration/diagnostic-service'
import { createDiagnosticFixture, MEM } from '../fixtures/agent-diagnostic-fixture'
import { ensureSchema } from '../../src/db/schema'
import { createNode } from '../../src/db/nodes'
import { completeDiagnosticDigest, completeDiagnosticRecall, countDiagnosticToolCall, diagnosticContent } from '../../src/agent-diagnostic-receipts'
import { readDiagnosticProcessStartIdentity } from '../../src/agent-diagnostic-runner'
import type { AgentInstallationRow } from '../../client/electron/agent-integration/repository'

vi.mock('../../client/electron/agent-integration/agent-authentication', () => ({
  probeAgentAuthentication: async () => ({ status: 'authenticated', billing: 'confirmed_subscription', reason: 'subscription_confirmed' }),
}))

it.each([false, true])('admits only committed Claude payloads matching the current runtime (drift: %s)', async drift => {
  const f = createDiagnosticFixture(false, 'Asia/Shanghai', new Date())
  try {
    const binding = f.binding()
    const runtime = { shimPath: '/fixture/shim', mcpServerPath: '/fixture/mcp-server.cjs' }
    const pluginName = `tidemind-${binding.canonicalAgentId}`, marketplaceId = 'synthetic-local', pluginVersion = '1.0.0'
    const qualifiedPlugin = `${pluginName}@${marketplaceId}`
    const manifest = { name: pluginName, version: pluginVersion }
    const mcp = { mcpServers: { tidemind: { command: drift ? '/fixture/replaced' : runtime.shimPath,
      args: [runtime.mcpServerPath], env: { EB_AGENT_ID: binding.canonicalAgentId,
        EB_HOST_VARIANT: binding.hostVariant, EB_ACTIVITY_GENERATION_TOKEN: MEM } } } }
    f.db.prepare('UPDATE projection_mutations SET planned_mutation_json=? WHERE artifact_id=?').run(JSON.stringify({
      desiredFragmentHash: binding.components.memory_tools.ownedFragmentHash,
      metadata: { kind: 'claude_plugin_aggregate', direction: 'install', pluginName, marketplaceId, qualifiedPlugin, pluginVersion,
        desiredFiles: { [`plugins/${pluginName}/.claude-plugin/plugin.json`]: JSON.stringify(manifest),
          [`plugins/${pluginName}/.mcp.json`]: JSON.stringify(mcp) } },
    }), binding.components.memory_tools.artifactId)
    const prepare = vi.fn(async () => { throw new Error('synthetic stop before spawn') })
    const diagnostics = createDiagnosticService(f.db, { homeDir: f.home, applicationDataDir: f.root,
      runtime, runtimeVersion: binding.runtimeVersion, launch: { executable: process.execPath, args: [] },
      attest: async () => true, prepare })
    const target = f.db.prepare('SELECT * FROM agent_installations WHERE id=?').get(f.ids[0]) as AgentInstallationRow
    const outcome = await diagnostics.run(target, 'automatic')
    expect(outcome.runId).toBeTruthy()
    expect(f.store.get(outcome.runId!)).toMatchObject({ submittedAt: null, finishedAt: expect.any(String) })
    expect(diagnostics.state(target)).toMatchObject({ lastTestAt: null })
    if (drift) {
      expect(outcome).toMatchObject({ status: 'waiting', reason: 'claude_managed_carrier_unavailable' })
      expect(prepare).not.toHaveBeenCalled()
    } else {
      expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        claudeCarrier: { qualifiedPlugin, manifest, mcp },
      }))
    }
  } finally { f.close() }
})

it('recovers completed isolated receipts after a startup process exits without resubmitting a model request', async () => {
  const f = createDiagnosticFixture(false, 'Asia/Shanghai', new Date())
  fs.symlinkSync(process.execPath, f.binding().executablePath)
  const run = f.prepare(), context = f.context(run), local = new Database(run.databasePath)
  f.store.reserve(run.runId, 'confirmed_subscription')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 750)'], { cwd: run.dataDir, detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
  try {
    f.store.recordProcessIdentity(run.runId, { protocolVersion: 1, pid: child.pid!, processGroupId: child.pid!,
      supervisorPid: 123455, supervisorStartIdentity: null, startedAt: new Date().toISOString(),
      osStartIdentity: await readDiagnosticProcessStartIdentity(child.pid!), executableRealpath: fs.realpathSync(process.execPath),
      argumentsHash: 'a'.repeat(64), cwd: run.dataDir })
    f.store.markSubmitted(run.runId)
    ensureSchema(local)
    const caller = { agentId: f.canonical, activityGenerationToken: MEM }
    countDiagnosticToolCall(local, context, caller, 'brain_digest')
    const node = createNode(local, { content: diagnosticContent(context), source_tool: 'synthetic-recovery-test' })
    completeDiagnosticDigest(local, context, caller, { status: 'processed', trace_id: 'synthetic-trace', created_nodes: [node] } as never)
    countDiagnosticToolCall(local, context, caller, 'brain_recall')
    completeDiagnosticRecall(local, context, caller, { nodes: [node] } as never)
    local.close()
    const prepare = vi.fn(async () => { throw new Error('Recovery must not invoke a model adapter') })
    const diagnostics = createDiagnosticService(f.db, { homeDir: f.home, applicationDataDir: f.root,
      runtime: { shimPath: '/fixture/shim', mcpServerPath: '/fixture/mcp-server.cjs' },
      runtimeVersion: f.binding().runtimeVersion, launch: { executable: process.execPath, args: [] },
      attest: async () => true, prepare })
    await Promise.resolve()
    expect(f.store.get(run.runId).phase).toBe('uncertain')
    expect(f.store.get(run.runId).cleaned).toBe(false)
    await exited
    const target = f.db.prepare('SELECT * FROM agent_installations WHERE id=?').get(f.ids[0]) as AgentInstallationRow
    expect(await diagnostics.run(target, 'automatic')).toMatchObject({ status: 'passed' })
    expect(diagnostics.state(target)).toMatchObject({ status: 'passed', lastTestAt: expect.any(String) })
    expect(f.store.get(run.runId)).toMatchObject({ phase: 'succeeded', cleaned: true, processesExited: true })
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await exited
    if (local.open) local.close()
    f.close()
  }
}, 10_000)
