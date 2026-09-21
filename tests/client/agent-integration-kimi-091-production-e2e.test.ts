import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-kimi-e2e-app-data',
    getVersion: () => '0.2.92-test',
    getAppPath: () => '/tmp/tidemind-kimi-e2e-app',
    isPackaged: false,
  },
  Notification: class {
    static isSupported() { return false }
    show() {}
  },
}))
vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Database from 'better-sqlite3'
import { parse as parseToml } from 'smol-toml'
import {
  bindAgentIntegrationExecutionPort,
  createProductionAgentIntegrationComposition,
} from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { ensureSchema } from '../../src/db/schema.js'
import { createLink } from '../../src/db/links.js'
import { createNode } from '../../src/db/nodes.js'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'

const AGENT_ID = 'eb_kimi_upgrade091'
const ARCHIVE_TARGET_ID = 'kimi-091-production-e2e-archive-target'
const CONCURRENT_ARCHIVE_TARGET_ID = 'kimi-091-production-e2e-concurrent-archive-target'
const LEGACY_SKILL_DESCRIPTION = 'Tide Mind 外部记忆系统。用户上下文在每次会话开始时通过 Hook 自动加载（在第一条消息前注入）。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。'

function electronAsNodeExecutable(): string {
  const dist = path.resolve('client', 'node_modules', 'electron', 'dist')
  if (process.platform === 'darwin') {
    return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')
}

function runtimeContext(home: string): AdapterRuntimeContext {
  const bin = path.join(home, '.tidemind-runtime')
  return {
    runtimeRealm: 'local_macos',
    homeDir: home,
    applicationDataDir: path.join(home, '.tidemind'),
    shimPath: path.join(bin, 'tm-node'),
    mcpServerPath: path.join(bin, 'mcp-server.cjs'),
    hookScriptPath: path.join(bin, 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(bin, 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(bin, 'hook-post-compact.cjs'),
    tideMindVersion: '0.2.92-test',
    catalogVersion: '2',
    projectionVersion: '3',
  }
}

function builtRuntimeContext(home: string): AdapterRuntimeContext {
  const bin = path.resolve('client', 'out', 'bin')
  const bundledVersion = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version: string
  }).version
  return {
    ...runtimeContext(home),
    shimPath: electronAsNodeExecutable(),
    mcpServerPath: path.join(bin, 'mcp-server.cjs'),
    hookScriptPath: path.join(bin, 'hook-session-start.cjs'),
    preCompactScriptPath: path.join(bin, 'hook-pre-compact.cjs'),
    postCompactScriptPath: path.join(bin, 'hook-post-compact.cjs'),
    tideMindVersion: bundledVersion,
  }
}

function parseConfiguredCommand(command: string): string[] {
  return execFileSync('/bin/sh', [
    '-c',
    `set -- ${command}; printf '%s\\0' "$@"`,
  ]).toString().split('\0').slice(0, -1)
}

function isolatedProcessEnv(
  home: string,
  tmpDir: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(Object.entries({
    ...process.env,
    HOME: home,
    TMPDIR: tmpDir,
    ELECTRON_RUN_AS_NODE: '1',
    ...extra,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function writeLegacy091Kimi(configRoot: string, runtime: AdapterRuntimeContext): void {
  fs.mkdirSync(configRoot, { recursive: true })
  const oldSkill = path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md')
  fs.mkdirSync(path.dirname(oldSkill), { recursive: true })
  const legacyBody = fs.readFileSync(path.resolve('data', 'skill', 'kimi-code-skill.md'), 'utf8')
  fs.writeFileSync(oldSkill, [
    '---',
    `name: tidemind-${AGENT_ID}`,
    `description: ${JSON.stringify(LEGACY_SKILL_DESCRIPTION)}`,
    '---',
    '',
  ].join('\n') + legacyBody)
  const userSkill = path.join(configRoot, 'skills', 'user-owned', 'SKILL.md')
  fs.mkdirSync(path.dirname(userSkill), { recursive: true })
  fs.writeFileSync(userSkill, '# User-owned Kimi skill\n')
  fs.writeFileSync(path.join(configRoot, 'mcp.json'), `${JSON.stringify({
    userSetting: { theme: 'moon' },
    mcpServers: {
      [`tidemind-${AGENT_ID}`]: {
        command: runtime.shimPath,
        args: [runtime.mcpServerPath],
        env: { EB_AGENT_ID: AGENT_ID },
      },
      userServer: { command: '/usr/bin/true' },
    },
  }, null, 2)}\n`)
  const legacyCommand = [
    JSON.stringify(runtime.shimPath),
    JSON.stringify(runtime.hookScriptPath),
    '--agent-id', JSON.stringify(AGENT_ID),
    '--skill-path', JSON.stringify(oldSkill),
    '--tool', JSON.stringify('kimi-code'),
    '--once-per-session',
  ].join(' ')
  fs.writeFileSync(path.join(configRoot, 'config.toml'), [
    'model = "kimi-for-coding"',
    '',
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    `command = ${JSON.stringify(legacyCommand)}`,
    'timeout = 30',
    '',
  ].join('\n'))
}

describe('Kimi 0.2.91 production upgrade acceptance', () => {
  beforeAll(async () => {
    // All cases execute these same production bundles. Build once as async
    // suite setup so emulated CI does not spend each behavior test's budget
    // recompiling them or block Vitest's worker RPC while esbuild runs.
    await promisify(execFile)(process.execPath, [path.resolve('client', 'scripts', 'build-bin.mjs')], {
      cwd: path.resolve('.'),
      timeout: 30_000,
    })
  }, 30_000)

  it('adopts at C2, upgrades through consent/coordinator, restarts to C4, then disconnects exactly', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-091-production-e2e-')))
    const home = path.join(root, 'home')
    const appData = path.join(home, '.tidemind')
    const graph = path.join(appData, 'graph')
    const configRoot = path.join(home, '.kimi-code')
    const hookTmpDir = path.join(root, 'hook-tmp')
    const executable = path.join(root, 'node_modules', '@moonshot-ai', 'kimi-code', 'bin', 'kimi.js')
    const runtime = builtRuntimeContext(home)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(graph, { recursive: true })
    fs.mkdirSync(hookTmpDir, { recursive: true })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    writeLegacy091Kimi(configRoot, runtime)

    const dbPath = path.join(graph, 'brain.sqlite')
    const db = new Database(dbPath)
    ensureSchema(db)
    db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES (?, 'Kimi legacy', 'kimi-code', 0, ?)`).run(AGENT_ID, new Date().toISOString())
    db.prepare(`INSERT INTO nodes (id, type, content, created, updated)
      VALUES (?, 'fact', 'Kimi 0.2.91 production E2E archive target', ?, ?)`)
      .run(ARCHIVE_TARGET_ID, new Date().toISOString(), new Date().toISOString())
    db.prepare(`INSERT INTO nodes (id, type, content, created, updated)
      VALUES (?, 'fact', 'Kimi 0.2.91 production E2E concurrent archive target', ?, ?)`)
      .run(CONCURRENT_ARCHIVE_TARGET_ID, new Date().toISOString(), new Date().toISOString())
    const correctionTarget = createNode(db, {
      type: 'fact',
      content: 'Kimi 0.2.91 production E2E correction target',
    })
    const linkFrom = createNode(db, {
      type: 'fact',
      content: 'Kimi 0.2.91 production E2E unlink source',
    })
    const linkTo = createNode(db, {
      type: 'fact',
      content: 'Kimi 0.2.91 production E2E unlink destination',
    })
    const existingLink = createLink(db, {
      from_id: linkFrom.id,
      to_id: linkTo.id,
      relation: [{ type: 'supports', confidence: 0.9 }],
    })!
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_kimi_e2e',
      productFamilyId: 'kimi-code',
      hostVariant: 'kimi-code-cli',
      configRoot,
      distribution: {
        distributionId: 'cli:kimi-code-cli',
        executableRealpath: executable,
        packageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
        capabilityFingerprint: 'npm-kimi-0.41.0-e2e',
      },
    })
    const scanner = { scan: async () => ({
      installations: [{
        catalogId: 'kimi-code-cli' as const,
        displayName: 'Kimi Code',
        identity,
        configRoot,
        executablePath: executable,
        detectedVersion: '0.41.0',
        versionDetectionMethod: 'npm_package_manifest' as const,
        managementEligibility: {
          schemaVersion: 1 as const,
          eligible: true as const,
          executableSizeBytes: fs.statSync(executable).size,
          proofLimitBytes: 512 * 1024 * 1024,
        },
        provenance: ['npm_metadata:@moonshot-ai/kimi-code'],
        evidence: [],
      }],
      unresolved: [],
      diagnostics: [],
    }) }
    const options = {
      homeDir: home,
      applicationDataDir: appData,
      runtimeContext: runtime,
      adapters: createP0HostAdapters(),
      enabledAdapterIds: ['kimi-code-cli' as const],
      scanner,
      canManageInstallation: () => true,
      fixtureMode: 'isolated_ui_audit' as const,
      autoRestore: true,
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    }

    let first = createProductionAgentIntegrationComposition(db, options)
    let unbind = bindAgentIntegrationExecutionPort(first.coordinator)
    try {
      const discovered = await first.service.scan()
      const installation = discovered.snapshot.installations.find(item => item.hostVariant === 'kimi-code-cli')!
      expect(installation).toMatchObject({
        desiredState: 'unmanaged',
        accessLevel: 'partial',
        accessIsHistorical: true,
      })
      expect(first.repository.getInstallation(installation.id)).toMatchObject({
        agent_id: AGENT_ID,
        verified_capability: 2,
        consent_envelope_id: null,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM writer_fences').get()).toEqual({ count: 0 })

      const preview = await first.service.previewConnect([installation.id])
      expect(preview.installations[0].targets.map(target => target.action)).toEqual(
        expect.arrayContaining(['create', 'update']),
      )
      const applied = await first.service.applyConnect(preview.planHash, [installation.id])
      expect(applied.results[0]).toMatchObject({ status: 'awaiting_verification' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_consents').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM reconcile_runs').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_mutations').get())
        .toEqual({ count: 3 })
      const consent = db.prepare(`SELECT status, allowed_components_json, normalized_targets_json
        FROM agent_consents`).get() as any
      expect(consent.status).toBe('active')
      expect(JSON.parse(consent.allowed_components_json)).toEqual([
        'instruction', 'lifecycle', 'memory_tools',
      ])
      expect(JSON.parse(consent.normalized_targets_json)).toHaveLength(4)
      const frozenRun = db.prepare(`SELECT state, consent_envelope_id, writer_fence_snapshot_json,
        prepared_plan_json FROM reconcile_runs`).get() as any
      expect(frozenRun.state).toBe('applied_unverified')
      expect(frozenRun.consent_envelope_id).toEqual(expect.any(String))
      expect(JSON.parse(frozenRun.writer_fence_snapshot_json)).not.toEqual({})
      const frozenPlan = JSON.parse(frozenRun.prepared_plan_json) as {
        componentKeys: string[]
        activityGenerationToken: string
      }
      expect(frozenPlan.componentKeys).toEqual([
        'instruction', 'lifecycle', 'memory_tools',
      ])
      expect(frozenPlan.activityGenerationToken).toMatch(/^operation_/u)
      expect(db.prepare(`SELECT COUNT(*) AS count FROM projection_mutations
        WHERE state = 'committed' AND apply_receipt_json IS NOT NULL
          AND post_effect_fingerprint IS NOT NULL`).get())
        .toEqual({ count: 3 })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts
        WHERE state = 'healthy' AND owned_fragment_hash IS NOT NULL`).get())
        .toEqual({ count: 3 })

      const mcpAfter = JSON.parse(fs.readFileSync(path.join(configRoot, 'mcp.json'), 'utf8'))
      expect(mcpAfter.userSetting).toEqual({ theme: 'moon' })
      expect(mcpAfter.mcpServers.userServer).toEqual({ command: '/usr/bin/true' })
      expect(mcpAfter.mcpServers[`tidemind-${AGENT_ID}`].env).toEqual({
        EB_AGENT_ID: AGENT_ID,
        EB_HOST_VARIANT: 'kimi-code-cli',
        EB_ACTIVITY_GENERATION_TOKEN: frozenPlan.activityGenerationToken,
      })
      const hooksAfter = (parseToml(fs.readFileSync(path.join(configRoot, 'config.toml'), 'utf8')) as any).hooks
      expect(hooksAfter).toHaveLength(5)
      expect(hooksAfter.filter((hook: any) => hook.event === 'UserPromptSubmit')).toHaveLength(1)
      expect(hooksAfter.filter((hook: any) => hook.event === 'SessionStart')).toHaveLength(1)
      expect(hooksAfter[0].command).toContain('--expected-skill-sha256')
      expect(hooksAfter[0].command).toContain('--suppress-session-start-activity')
      expect(fs.existsSync(path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md'))).toBe(false)
      expect(fs.existsSync(path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`))).toBe(false)
      expect(fs.existsSync(path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'))).toBe(true)
      const migratedSkillLedger = db.prepare(`SELECT target_path, state, owned_fragment_hash
        FROM managed_artifacts WHERE component_type = 'skill' ORDER BY target_path`).all() as any[]
      expect(migratedSkillLedger).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target_path: path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md'),
          state: 'removal_pending',
          owned_fragment_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          target_path: path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'),
          state: 'healthy',
          owned_fragment_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]))

      unbind()
      first.runtime.stop()
      const restarted = createProductionAgentIntegrationComposition(db, options)
      first = restarted
      unbind = bindAgentIntegrationExecutionPort(restarted.coordinator)
      const hookEnv = isolatedProcessEnv(home, hookTmpDir)
      const migratedHooks = (parseToml(
        fs.readFileSync(path.join(configRoot, 'config.toml'), 'utf8'),
      ) as any).hooks as Array<{ event: string; command: string }>
      for (const event of ['SessionStart', 'PreCompact', 'PostCompact', 'SessionEnd']) {
        const configured = migratedHooks.find(hook => hook.event === event)
        expect(configured, `missing migrated ${event} hook`).toBeDefined()
        const argv = parseConfiguredCommand(configured!.command)
        expect(argv[0]).toBe(runtime.shimPath)
        const invoked = spawnSync(argv[0], argv.slice(1), {
          cwd: root,
          env: hookEnv,
          input: `${JSON.stringify({ source: event === 'SessionStart' ? 'startup' : 'manual' })}\n`,
          encoding: 'utf8',
          timeout: 15_000,
        })
        expect(invoked.status, `${event} stderr: ${invoked.stderr}`).toBe(0)
      }

      const migratedMcp = JSON.parse(fs.readFileSync(path.join(configRoot, 'mcp.json'), 'utf8'))
        .mcpServers[`tidemind-${AGENT_ID}`] as {
          command: string
          args: string[]
          env: Record<string, string>
        }
      expect(migratedMcp.command).toBe(runtime.shimPath)
      expect(migratedMcp.args).toEqual([runtime.mcpServerPath])
      const mcpTransport = new StdioClientTransport({
        command: migratedMcp.command,
        args: migratedMcp.args,
        cwd: root,
        env: isolatedProcessEnv(home, hookTmpDir, migratedMcp.env),
        stderr: 'pipe',
      })
      const mcpClient = new Client({ name: 'kimi-091-production-e2e', version: '1.0.0' })
      try {
        await mcpClient.connect(mcpTransport)
        const invalidPrepare = await mcpClient.callTool({
          name: 'brain_prepare',
          arguments: {},
        })
        expect(invalidPrepare.isError).toBe(true)
        const rejectedRecall = await mcpClient.callTool({
          name: 'brain_recall',
          arguments: { context: 'context alone is not a valid recall dimension' },
        })
        expect(rejectedRecall.isError).toBe(true)
        const invalidDigest = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: { intent: 'new', async: false },
        })
        expect(invalidDigest.isError).toBe(true)
        const rejectedDigest = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi rejected archive without a target',
            intent: 'archive',
            async: false,
          },
        })
        expect(rejectedDigest.isError).not.toBe(true)
        expect(JSON.parse((rejectedDigest.content[0] as { text: string }).text)).toMatchObject({
          status: 'rejected',
        })
        const noOpDigest = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi rejected archive for a missing target',
            target_node: 'missing-kimi-archive-target',
            intent: 'archive',
            async: false,
          },
        })
        expect(noOpDigest.isError).not.toBe(true)
        expect(JSON.parse((noOpDigest.content[0] as { text: string }).text)).toMatchObject({
          status: 'rejected',
        })
        const operationCountBeforeNoOpUnlink = db.prepare(`SELECT COUNT(*) AS count
          FROM operation_log WHERE operation = 'digest'`).get() as { count: number }
        const noOpUnlink = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi rejected unlink without an active relationship',
            target_link: { from: 'missing-kimi-link-a', to: 'missing-kimi-link-b' },
            intent: 'correction',
            async: false,
          },
        })
        expect(noOpUnlink.isError).not.toBe(true)
        expect(JSON.parse((noOpUnlink.content[0] as { text: string }).text)).toMatchObject({
          status: 'rejected',
          reject_reason: expect.stringContaining('没有可断开的活跃链接'),
        })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
          WHERE agent_id = ? AND component_key = 'memory_tools'`).get(AGENT_ID))
          .toEqual({ count: 0 })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM operation_log
          WHERE operation = 'digest'`).get()).toEqual(operationCountBeforeNoOpUnlink)
        expect(db.prepare('SELECT archived FROM nodes WHERE id = ?').get(ARCHIVE_TARGET_ID))
          .toEqual({ archived: 0 })
        const recall = await mcpClient.callTool({
          name: 'brain_recall',
          arguments: { type: 'fact', sort: 'recent', limit: 1 },
        })
        expect(recall.isError).not.toBe(true)

        const resetDigestActivity = () => db.prepare(`DELETE FROM agent_host_activity_evidence
          WHERE agent_id = ? AND signal_name = 'brain_digest'`).run(AGENT_ID)
        const expectDigestActivity = () => expect(db.prepare(`SELECT COUNT(*) AS count
          FROM agent_host_activity_evidence
          WHERE agent_id = ? AND signal_name = 'brain_digest'`).get(AGENT_ID)).toEqual({ count: 1 })

        const correction = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi 0.2.91 production E2E corrected content',
            target_node: correctionTarget.id,
            intent: 'correction',
            async: false,
          },
        })
        expect(correction.isError).not.toBe(true)
        expect(JSON.parse((correction.content[0] as { text: string }).text)).toMatchObject({
          status: 'processed',
          updated_nodes: [{ id: correctionTarget.id }],
        })
        expect(db.prepare('SELECT content FROM nodes WHERE id = ?').get(correctionTarget.id))
          .toEqual({ content: 'Kimi 0.2.91 production E2E corrected content' })
        expectDigestActivity()
        resetDigestActivity()

        const unlink = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi 0.2.91 production E2E unlink existing relationship',
            target_link: { from: linkFrom.id, to: linkTo.id },
            intent: 'correction',
            async: false,
          },
        })
        expect(unlink.isError).not.toBe(true)
        expect(JSON.parse((unlink.content[0] as { text: string }).text)).toMatchObject({
          status: 'processed',
        })
        expect(db.prepare('SELECT deleted FROM links WHERE id = ?').get(existingLink.id))
          .toEqual({ deleted: 1 })
        expectDigestActivity()
        resetDigestActivity()

        const asyncDigest = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi 0.2.91 production E2E accepted asynchronous memory',
            intent: 'new',
            async: true,
          },
        })
        expect(asyncDigest.isError).not.toBe(true)
        expect(JSON.parse((asyncDigest.content[0] as { text: string }).text)).toMatchObject({
          status: 'accepted',
          trace_id: expect.any(String),
        })
        expectDigestActivity()
        resetDigestActivity()

        const digest = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi 0.2.91 production E2E archive invocation',
            target_node: ARCHIVE_TARGET_ID,
            intent: 'archive',
            async: false,
          },
        })
        expect(digest.isError).not.toBe(true)
        expect(JSON.parse((digest.content[0] as { text: string }).text)).toMatchObject({
          status: 'processed',
          archived_nodes: [ARCHIVE_TARGET_ID],
        })
        expectDigestActivity()

        const archivedBeforeRepeat = db.prepare(`SELECT archived, heat, edit_seq, updated
          FROM nodes WHERE id = ?`).get(ARCHIVE_TARGET_ID)
        const digestOperationsBeforeRepeat = (db.prepare(`SELECT COUNT(*) AS count
          FROM operation_log WHERE operation = 'digest'`).get() as { count: number }).count
        const activityBeforeRepeat = db.prepare(`SELECT id, observed_at
          FROM agent_host_activity_evidence
          WHERE agent_id = ? AND signal_name = 'brain_digest'`).get(AGENT_ID)
        const repeatedArchive = await mcpClient.callTool({
          name: 'brain_digest',
          arguments: {
            content: 'Kimi 0.2.91 production E2E repeated archive no-op',
            target_node: ARCHIVE_TARGET_ID,
            intent: 'archive',
            async: false,
          },
        })
        expect(repeatedArchive.isError).not.toBe(true)
        expect(JSON.parse((repeatedArchive.content[0] as { text: string }).text)).toMatchObject({
          status: 'rejected',
          reject_reason: expect.stringContaining('已归档'),
        })
        expect(db.prepare(`SELECT archived, heat, edit_seq, updated
          FROM nodes WHERE id = ?`).get(ARCHIVE_TARGET_ID)).toEqual(archivedBeforeRepeat)
        expect(db.prepare(`SELECT COUNT(*) AS count FROM operation_log
          WHERE operation = 'digest'`).get()).toEqual({ count: digestOperationsBeforeRepeat })
        expect(db.prepare(`SELECT id, observed_at FROM agent_host_activity_evidence
          WHERE agent_id = ? AND signal_name = 'brain_digest'`).get(AGENT_ID))
          .toEqual(activityBeforeRepeat)

        resetDigestActivity()
        const concurrentOperationsBefore = (db.prepare(`SELECT COUNT(*) AS count
          FROM operation_log WHERE operation = 'digest'`).get() as { count: number }).count
        const concurrentBefore = db.prepare(`SELECT edit_seq FROM nodes WHERE id = ?`)
          .get(CONCURRENT_ARCHIVE_TARGET_ID) as { edit_seq: number }
        const secondTransport = new StdioClientTransport({
          command: migratedMcp.command,
          args: migratedMcp.args,
          cwd: root,
          env: isolatedProcessEnv(home, hookTmpDir, migratedMcp.env),
          stderr: 'pipe',
        })
        const secondClient = new Client({ name: 'kimi-091-concurrent-archive', version: '1.0.0' })
        try {
          await secondClient.connect(secondTransport)
          const concurrentResults = await Promise.all([
            mcpClient.callTool({
              name: 'brain_digest',
              arguments: {
                content: 'Kimi concurrent archive writer one',
                target_node: CONCURRENT_ARCHIVE_TARGET_ID,
                intent: 'archive',
                async: false,
              },
            }),
            secondClient.callTool({
              name: 'brain_digest',
              arguments: {
                content: 'Kimi concurrent archive writer two',
                target_node: CONCURRENT_ARCHIVE_TARGET_ID,
                intent: 'archive',
                async: false,
              },
            }),
          ])
          expect(concurrentResults.map(result => JSON.parse(
            (result.content[0] as { text: string }).text,
          ).status).sort()).toEqual(['processed', 'rejected'])
        } finally {
          await secondClient.close()
        }
        expect(db.prepare(`SELECT archived, edit_seq FROM nodes WHERE id = ?`)
          .get(CONCURRENT_ARCHIVE_TARGET_ID)).toEqual({
          archived: 1,
          edit_seq: concurrentBefore.edit_seq + 1,
        })
        expect(db.prepare(`SELECT COUNT(*) AS count FROM operation_log
          WHERE operation = 'digest'`).get()).toEqual({ count: concurrentOperationsBefore + 1 })
        expectDigestActivity()
      } finally {
        await mcpClient.close()
      }
      expect(db.prepare('SELECT archived FROM nodes WHERE id = ?').get(ARCHIVE_TARGET_ID))
        .toEqual({ archived: 1 })
      expect(db.prepare(`SELECT component_key, signal_name
        FROM agent_host_activity_evidence
        WHERE agent_id = ?
        ORDER BY component_key, signal_name`).all(AGENT_ID)).toEqual([
        { component_key: 'lifecycle', signal_name: 'post_compact' },
        { component_key: 'lifecycle', signal_name: 'pre_compact' },
        { component_key: 'lifecycle', signal_name: 'session_end' },
        { component_key: 'lifecycle', signal_name: 'session_start' },
        { component_key: 'memory_tools', signal_name: 'brain_digest' },
        { component_key: 'memory_tools', signal_name: 'brain_recall' },
      ])
      await restarted.service.scan()
      expect(restarted.repository.getInstallation(installation.id)).toMatchObject({
        desired_state: 'managed',
        verified_capability: 4,
        verification_summary: 'verified',
      })

      const disconnectPreview = await restarted.service.previewDisconnect(installation.id)
      const disconnected = await restarted.service.disconnect(disconnectPreview.planHash, installation.id)
      const disconnectMutations = db.prepare(`SELECT component_key, state, failure_code, failure_stage,
          before_hash, after_hash, precondition_json, planned_mutation_json, apply_receipt_json
        FROM projection_mutations WHERE run_id = ? ORDER BY rowid`).all(disconnected.results[0].runId)
      const liveConfigToml = fs.readFileSync(path.join(configRoot, 'config.toml'), 'utf8')
      expect(disconnected.results[0], JSON.stringify({
        result: disconnected.results[0],
        disconnectMutations,
        liveConfigToml,
      }, null, 2))
        .toMatchObject({ status: 'committed' })
      const mcpDisconnected = JSON.parse(fs.readFileSync(path.join(configRoot, 'mcp.json'), 'utf8'))
      expect(mcpDisconnected).toEqual({
        userSetting: { theme: 'moon' },
        mcpServers: { userServer: { command: '/usr/bin/true' } },
      })
      const tomlDisconnected = parseToml(fs.readFileSync(path.join(configRoot, 'config.toml'), 'utf8')) as any
      expect(tomlDisconnected.model).toBe('kimi-for-coding')
      expect(tomlDisconnected.hooks).toBeUndefined()
      expect(fs.existsSync(path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'))).toBe(false)
      expect(fs.existsSync(path.join(configRoot, 'skills', 'tidemind'))).toBe(false)
      expect(fs.readFileSync(path.join(configRoot, 'skills', 'user-owned', 'SKILL.md'), 'utf8'))
        .toBe('# User-owned Kimi skill\n')
      expect(db.prepare(`SELECT target_path, state, owned_fragment_hash FROM managed_artifacts
        WHERE component_type = 'skill' ORDER BY target_path`).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target_path: path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md'),
          state: 'removed',
          owned_fragment_hash: null,
        }),
        expect.objectContaining({
          target_path: path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'),
          state: 'removed',
          owned_fragment_hash: null,
        }),
      ]))
      expect(restarted.repository.getInstallation(installation.id)?.desired_state).toBe('removed')
    } finally {
      unbind()
      first.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('disconnects an exact applied-unverified migration without leaving legacy ownership pending', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-091-immediate-disconnect-')))
    const home = path.join(root, 'home')
    const appData = path.join(home, '.tidemind')
    const graph = path.join(appData, 'graph')
    const configRoot = path.join(home, '.kimi-code')
    const executable = path.join(root, 'node_modules', '@moonshot-ai', 'kimi-code', 'bin', 'kimi.js')
    const runtime = runtimeContext(home)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(graph, { recursive: true })
    fs.mkdirSync(path.dirname(runtime.shimPath), { recursive: true })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    for (const asset of [
      runtime.shimPath, runtime.mcpServerPath, runtime.hookScriptPath,
      runtime.preCompactScriptPath, runtime.postCompactScriptPath,
      path.join(path.dirname(runtime.hookScriptPath), 'hook-kimi-session-start-activity.cjs'),
      path.join(path.dirname(runtime.hookScriptPath), 'hook-session-end.cjs'),
    ]) fs.writeFileSync(asset, '// packaged runtime fixture\n', { mode: 0o700 })
    writeLegacy091Kimi(configRoot, runtime)
    const userSkill = path.join(configRoot, 'skills', 'user-owned', 'SKILL.md')
    fs.mkdirSync(path.dirname(userSkill), { recursive: true })
    fs.writeFileSync(userSkill, '# keep me\n')

    const db = new Database(path.join(graph, 'brain.sqlite'))
    ensureSchema(db)
    db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
      VALUES (?, 'Kimi legacy', 'kimi-code', 0, ?)`).run(AGENT_ID, new Date().toISOString())
    const identity = canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos', osUserIdentity: 'usr_kimi_e2e', productFamilyId: 'kimi-code',
      hostVariant: 'kimi-code-cli', configRoot,
      distribution: {
        distributionId: 'cli:kimi-code-cli', executableRealpath: executable,
        packageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
        capabilityFingerprint: 'npm-kimi-0.41.0-e2e',
      },
    })
    const scanner = { scan: async () => ({
      installations: [{
        catalogId: 'kimi-code-cli' as const, displayName: 'Kimi Code', identity, configRoot,
        executablePath: executable, detectedVersion: '0.41.0',
        versionDetectionMethod: 'npm_package_manifest' as const,
        managementEligibility: {
          schemaVersion: 1 as const, eligible: true as const,
          executableSizeBytes: fs.statSync(executable).size, proofLimitBytes: 512 * 1024 * 1024,
        },
        provenance: ['npm_metadata:@moonshot-ai/kimi-code'], evidence: [],
      }],
      unresolved: [], diagnostics: [],
    }) }
    const options = {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters: createP0HostAdapters(), enabledAdapterIds: ['kimi-code-cli' as const], scanner,
      canManageInstallation: () => true, fixtureMode: 'isolated_ui_audit' as const,
      autoRestore: true, startRuntime: false, notifications: { deliver: vi.fn() },
    }
    let composition = createProductionAgentIntegrationComposition(db, options)
    let unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const installation = (await composition.service.scan()).snapshot.installations
        .find(item => item.hostVariant === 'kimi-code-cli')!
      const connectPreview = await composition.service.previewConnect([installation.id])
      const connected = await composition.service.applyConnect(connectPreview.planHash, [installation.id])
      expect(connected.results[0]).toMatchObject({ status: 'awaiting_verification' })
      const connectRunId = connected.results[0].runId!

      const disconnectPreview = await composition.service.previewDisconnect(installation.id)
      const disconnected = await composition.service.disconnect(disconnectPreview.planHash, installation.id)
      expect(disconnected.results[0]).toMatchObject({ status: 'committed' })
      expect(db.prepare(`SELECT state, failure_code FROM reconcile_runs WHERE id = ?`).get(connectRunId))
        .toEqual({ state: 'cancelled', failure_code: 'superseded_by_disconnect' })
      const feedKey = `run:${connectRunId}`
      expect(composition.service.listApplyTasks({ limit: 20 })).toMatchObject({
        attentionCount: 0,
        activeCount: 0,
        tasks: [{
          feedKey,
          state: 'completed',
          results: [{
            status: 'superseded', runId: connectRunId,
          }],
        }],
      })
      expect(composition.service.getApplyTask(feedKey)).toMatchObject({
        feedKey,
        state: 'completed',
        results: [{ status: 'superseded', runId: connectRunId }],
      })

      unbind()
      composition.runtime.stop()
      composition = createProductionAgentIntegrationComposition(db, options)
      unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
      expect(composition.service.listApplyTasks({ limit: 20 })).toMatchObject({
        attentionCount: 0,
        activeCount: 0,
        tasks: [{ feedKey, state: 'completed', results: [{ status: 'superseded', runId: connectRunId }] }],
      })
      expect(composition.service.getApplyTask(feedKey)).toMatchObject({
        feedKey,
        state: 'completed',
        results: [{ status: 'superseded', runId: connectRunId }],
      })
      expect(db.prepare(`SELECT COUNT(*) AS count FROM managed_artifacts WHERE state = 'removal_pending'`).get())
        .toEqual({ count: 0 })
      expect(fs.existsSync(path.join(configRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md'))).toBe(false)
      expect(fs.existsSync(path.join(configRoot, 'skills', 'tidemind', 'SKILL.md'))).toBe(false)
      expect(fs.readFileSync(userSkill, 'utf8')).toBe('# keep me\n')
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('records Kimi session evidence only from the built silent SessionStart hook', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-091-built-hook-')))
    const home = path.join(root, 'home')
    const dataDir = path.join(home, '.tidemind')
    const graph = path.join(dataDir, 'graph')
    const hookTmpDir = path.join(root, 'hook-tmp')
    const skill = path.join(root, 'SKILL.md')
    const bundle = path.resolve('client', 'out', 'bin', 'hook-session-start.cjs')
    const electronExecutable = electronAsNodeExecutable()
    fs.mkdirSync(graph, { recursive: true })
    fs.mkdirSync(hookTmpDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.toml'), `[general]\ndata_dir = ${JSON.stringify(dataDir)}\n`)
    fs.writeFileSync(skill, '# Hook execution fixture\n')

    const db = new Database(path.join(graph, 'brain.sqlite'))
    ensureSchema(db)
    seedManagedLifecycle(
      db, 'eb_kimi_bundle', 'kimi-code', 'kimi-code-cli', '0.41.0',
    )
    seedManagedLifecycle(
      db, 'eb_claude_bundle', 'claude-code', 'claude-code-cli', '2.1.260',
    )
    const kimiGeneration = readCommittedGeneration(db, 'eb_kimi_bundle')
    const claudeGeneration = readCommittedGeneration(db, 'eb_claude_bundle')
    db.close()
    let sessionSequence = 0
    const run = (
      agentId: string,
      tool: string,
      oncePerSession: boolean,
      activityGenerationToken?: string,
      expectedSkillSha256?: string,
      suppressSessionStartActivity = false,
      sessionLabel = 'session',
      extraArgs: readonly string[] = [],
    ) => spawnSync(
      electronExecutable,
      [bundle, '--agent-id', agentId, '--skill-path', skill, '--tool', tool,
        ...(oncePerSession ? ['--once-per-session'] : []),
        ...(activityGenerationToken
          ? ['--activity-generation-token', activityGenerationToken]
          : []),
        ...(expectedSkillSha256
          ? ['--expected-skill-sha256', expectedSkillSha256]
          : []),
        ...(suppressSessionStartActivity ? ['--suppress-session-start-activity'] : []),
        ...extraArgs],
      {
        cwd: root,
        env: { ...process.env, HOME: home, TMPDIR: hookTmpDir, ELECTRON_RUN_AS_NODE: '1' },
        input: `${JSON.stringify({
          session_id: `${agentId}-${sessionLabel}-${path.basename(root)}-${sessionSequence++}`,
        })}\n`,
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
    try {
      const expectedSkillSha256 = createHash('sha256').update(fs.readFileSync(skill)).digest('hex')
      const legacyKimi = run('eb_kimi_bundle', 'kimi-code', true, undefined, undefined, false, 'legacy-session')
      expect(legacyKimi.status, legacyKimi.stderr).toBe(0)
      expect(legacyKimi.stdout).toContain('# Hook execution fixture')
      expect(legacyKimi.stdout).not.toContain('HOOK_SESSION_START_FATAL')
      const afterLegacyKimi = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      expect(afterLegacyKimi.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_kimi_bundle' AND signal_name = 'session_start'`).get()).toEqual({ count: 0 })
      afterLegacyKimi.close()

      const incompleteManagedKimiCases = [
        run('eb_kimi_bundle', 'kimi-code', true, undefined, expectedSkillSha256, true,
          'managed-missing-generation'),
        run('eb_kimi_bundle', 'kimi-code', true, undefined, expectedSkillSha256, false,
          'expected-hash-missing-generation'),
        run('eb_kimi_bundle', 'kimi-code', true, undefined, undefined, true,
          'suppress-missing-generation'),
        run('eb_kimi_bundle', 'kimi-code', true, undefined, undefined, false,
          'bare-generation-flag', ['--activity-generation-token']),
      ]
      for (const incompleteManagedKimi of incompleteManagedKimiCases) {
        expect(incompleteManagedKimi.status).toBe(0)
        expect(incompleteManagedKimi.stderr).toContain('Missing --activity-generation-token')
        expect(incompleteManagedKimi.stdout).toContain('HOOK_SESSION_START_FATAL')
        expect(incompleteManagedKimi.stdout).not.toContain('# Hook execution fixture')
      }
      const afterIncompleteManagedKimi = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      expect(afterIncompleteManagedKimi.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_kimi_bundle' AND signal_name = 'session_start'`).get()).toEqual({ count: 0 })
      afterIncompleteManagedKimi.close()

      const kimi = run(
        'eb_kimi_bundle',
        'kimi-code',
        true,
        kimiGeneration,
        expectedSkillSha256,
        true,
        'managed-session',
      )
      expect(kimi.status, kimi.stderr).toBe(0)
      expect(kimi.stdout).toContain('# Hook execution fixture')
      const afterKimi = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      expect(afterKimi.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_kimi_bundle' AND signal_name = 'session_start'`).get()).toEqual({ count: 0 })
      afterKimi.close()

      const kimiSessionStart = spawnSync(
        electronExecutable,
        [path.resolve('client', 'out', 'bin', 'hook-kimi-session-start-activity.cjs'),
          '--agent-id', 'eb_kimi_bundle', '--activity-generation-token', kimiGeneration],
        {
          cwd: root,
          env: { ...process.env, HOME: home, TMPDIR: hookTmpDir, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
      expect(kimiSessionStart.status, kimiSessionStart.stderr).toBe(0)
      const afterRealKimiStart = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      expect(afterRealKimiStart.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_kimi_bundle' AND signal_name = 'session_start'`).get()).toEqual({ count: 1 })
      afterRealKimiStart.close()

      const missingGeneration = run('eb_claude_bundle', 'claude-code', false)
      expect(missingGeneration.stderr).toContain('Missing --activity-generation-token')
      const afterMissingGeneration = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      expect(afterMissingGeneration.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_claude_bundle' AND signal_name = 'session_start'`).get()).toEqual({ count: 0 })
      afterMissingGeneration.close()

      const claude = run(
        'eb_claude_bundle',
        'claude-code',
        false,
        claudeGeneration,
        expectedSkillSha256,
      )
      expect(claude.status).toBe(0)
      const afterClaude = new Database(path.join(graph, 'brain.sqlite'), { readonly: true })
      const positive = afterClaude.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
        WHERE agent_id = 'eb_claude_bundle' AND signal_name = 'session_start'`).get()
      expect(positive, `built hook stderr: ${claude.stderr}`).toEqual({ count: 1 })
      afterClaude.close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

function seedManagedLifecycle(
  db: Database.Database,
  agentId: string,
  family: string,
  hostVariant: string,
  hostVersion: string,
): void {
  const now = new Date().toISOString()
  const suffix = agentId.replace(/[^a-z0-9]/giu, '_')
  const installationId = `installation_${suffix}`
  const consentId = `consent_${suffix}`
  const generation = `generation_${suffix}`
  const generationHash = createHash('sha256').update(JSON.stringify(generation)).digest('hex')
  db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
    VALUES (?, ?, ?, 0, ?)`).run(agentId, agentId, family, now)
  db.prepare(`INSERT INTO agent_installations (
    id, family, host_variant, runtime_realm, profile_id, install_key, provenance,
    display_name, detected_version, agent_id, desired_state, supported_capability,
    desired_capability, health_state, created_at, updated_at
  ) VALUES (?, ?, ?, 'local_macos', 'default', ?, 'fixture', ?, ?, ?, 'managed', 4, 4, 'discovered', ?, ?)`)
    .run(installationId, family, hostVariant, `${hostVariant}:${suffix}`, agentId, hostVersion, agentId, now, now)
  db.prepare(`INSERT INTO managed_artifacts (
    id, component_type, target_path, ownership_key, mutation_domain,
    projection_version, selector_schema_version, owned_fragment_hash,
    observed_fragment_hash, state, created_at, updated_at
  ) VALUES (?, 'hook', ?, 'document', ?, '3', '1', 'owned', 'owned', 'healthy', ?, ?)`)
    .run(`artifact_${suffix}`, `/fixture/${suffix}`, `local_macos:file:/fixture/${suffix}:document`, now, now)
  db.prepare(`INSERT INTO installation_components (
    installation_id, component_key, desired_state, desired_capability, delivery_mode,
    verification_status, artifact_id, visibility_state, created_at, updated_at
  ) VALUES (?, 'lifecycle', 'managed', 4, 'managed', 'unverified', ?, 'dedicated', ?, ?)`)
    .run(installationId, `artifact_${suffix}`, now, now)
  db.prepare(`INSERT INTO artifact_consumers (
    artifact_id, installation_id, component_key, required_capability, desired_state,
    discover_reachability, state, added_at, updated_at
  ) VALUES (?, ?, 'lifecycle', 4, 'managed', 'dedicated', 'active', ?, ?)`)
    .run(`artifact_${suffix}`, installationId, now, now)
  db.prepare(`INSERT INTO reconcile_runs (
    id, installation_id, operation_type, execution_plan_hash, state, recovery_strategy,
    adapter_version, catalog_version, projection_version, selector_schema_version,
    prepared_plan_json, desired_capability, created_at, updated_at
  ) VALUES (?, ?, 'connect', ?, 'committed', 'readback_before_replay', '1', '2', '3', '1', ?, 4, ?, ?)`)
    .run(`run_${suffix}`, installationId, `plan_${suffix}`, JSON.stringify({
      componentKeys: ['lifecycle'],
      activityGenerationToken: generation,
      executionPlan: { activityGenerationTokenHash: generationHash },
    }), now, now)
  db.prepare(`INSERT INTO agent_consents (
    id, installation_id, policy_version, allowed_components_json,
    allowed_scopes_json, normalized_targets_json, selector_schema_version,
    selector_resolution_json, executable_realpaths_json, command_categories_json,
    maximum_risk, status, confirmed_at, created_at
  ) VALUES (?, ?, '1', '["lifecycle"]', '[]', '[]', '1', '{}', '[]', '[]',
    'low', 'active', ?, ?)`).run(consentId, installationId, now, now)
  db.prepare(`UPDATE agent_installations SET consent_envelope_id = ? WHERE id = ?`)
    .run(consentId, installationId)
  db.prepare(`UPDATE installation_components SET consent_envelope_id = ? WHERE installation_id = ?`)
    .run(consentId, installationId)
  db.prepare(`UPDATE artifact_consumers SET consent_envelope_id = ? WHERE installation_id = ?`)
    .run(consentId, installationId)
  db.prepare(`UPDATE reconcile_runs SET consent_envelope_id = ? WHERE installation_id = ?`)
    .run(consentId, installationId)
}

function readCommittedGeneration(db: Database.Database, agentId: string): string {
  const suffix = agentId.replace(/[^a-z0-9]/giu, '_')
  const row = db.prepare(`SELECT json_extract(prepared_plan_json, '$.activityGenerationToken') AS token
    FROM reconcile_runs WHERE installation_id = ? AND state = 'committed'`)
    .get(`installation_${suffix}`) as { token?: unknown } | undefined
  if (typeof row?.token !== 'string' || !row.token) {
    throw new Error(`missing committed activity generation for ${agentId}`)
  }
  return row.token
}
