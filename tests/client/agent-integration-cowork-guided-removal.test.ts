import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-cowork-removal-test',
    getVersion: () => '0.2.92-test',
    getAppPath: () => '/tmp/Tide Mind.app',
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensureSchema } from '../../src/db/schema'
import { bindAgentIntegrationExecutionPort, createProductionAgentIntegrationComposition } from '../../client/electron/agent-integration/production-service'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'
import type { DiscoveredInstallation } from '../../client/electron/agent-integration/discovery'

describe('Claude Cowork guided removal receipt (C0)', { timeout: 60_000 }, () => {
  it('completes a Cowork disconnect only after the user confirms the in-host plugin removal', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-guided-removal-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const claudeConfig = path.join(home, 'Library', 'Application Support', 'Claude')
    const appPath = path.join(root, 'Applications', 'Claude.app')
    const executable = path.join(appPath, 'Contents', 'MacOS', 'Claude')
    for (const directory of [appData, claudeConfig, path.dirname(executable), path.join(root, 'bin')]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const runtime: AdapterRuntimeContext = {
      runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: appData,
      shimPath: path.join(root, 'bin', 'tm-node'),
      mcpServerPath: path.join(root, 'bin', 'mcp-server.cjs'),
      hookScriptPath: path.join(root, 'bin', 'hook-session-start.cjs'),
      preCompactScriptPath: path.join(root, 'bin', 'hook-pre-compact.cjs'),
      postCompactScriptPath: path.join(root, 'bin', 'hook-post-compact.cjs'),
      tideMindVersion: '0.2.92', catalogVersion: '1', projectionVersion: '1',
    }
    const candidate: DiscoveredInstallation = {
      catalogId: 'claude-cowork-local',
      displayName: 'Claude Cowork',
      identity: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_cowork_fixture',
        productFamilyId: 'claude-cowork',
        hostVariant: 'claude-cowork-local',
        configRoot: claudeConfig,
        distribution: {
          distributionId: 'com.anthropic.claudefordesktop',
          executableRealpath: executable,
          packageProvenance: 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW',
          capabilityFingerprint: `desktop-bundle-surface-v1:${'c'.repeat(64)}`,
        },
      }),
      configRoot: claudeConfig,
      executablePath: executable,
      appPath,
      detectedVersion: '1.46400.0',
      versionDetectionMethod: 'bundle_plist',
      provenance: ['signed Claude.app fixture'],
      evidence: [],
    }
    const adapters = new Map([['claude-cowork-local', createP0HostAdapters().get('claude-cowork-local')!]] as const)
    const db = new Database(path.join(root, 'agent-integration.sqlite'))
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters, enabledAdapterIds: ['claude-cowork-local'], observeOnly: false,
      startRuntime: false, fixtureMode: 'isolated_ui_audit',
      canManageInstallation: () => true,
      scanner: {
        scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }),
        previewGuidedInstallation: async () => candidate,
      },
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    try {
      const preflight = await composition.service.previewClaudeCoworkSetup()
      const { installationId } = await composition.service.prepareClaudeCoworkSetup(preflight.preflightHash)
      await composition.service.scan()
      const connectPreview = await composition.service.previewConnect([installationId])
      const connected = await composition.service.applyConnect(connectPreview.planHash, [installationId])
      expect(connected.results[0], JSON.stringify(connected.results[0])).toMatchObject({ status: 'awaiting_verification' })

      // Without a receipt the disconnect stays pending: Cowork's registry is private.
      const disconnectPreview = await composition.service.previewDisconnect(installationId)
      expect(disconnectPreview.installations[0].requiredUserActions).toContain('claude_cowork_plugin_remove_required')
      const disconnected = await composition.service.disconnect(disconnectPreview.planHash, installationId)
      expect(disconnected.results[0], JSON.stringify(disconnected.results[0])).toMatchObject({ status: 'awaiting_verification' })
      await composition.service.scan()
      expect(composition.repository.getInstallation(installationId)?.status_reason).not.toBe('disconnect_verified')
      expect(composition.service.detail(installationId).requiredUserActionDetails).toEqual([
        expect.objectContaining({ kind: 'claude_cowork_plugin_upload', operation: 'disconnect' }),
        expect.objectContaining({ kind: 'manual_file_removal', componentKey: 'instruction', operation: 'disconnect' }),
      ])
      const exportPath = path.join(appData, 'agent-integration', 'claude-cowork', installationId, 'tidemind-cowork.plugin')
      expect(fs.existsSync(exportPath)).toBe(true)

      // The receipt is refused while Tide Mind's own export is still present.
      const early = composition.service.reviewGuidedRemoval(installationId)
      expect(await composition.service.confirmGuidedRemoval(early.actionHash))
        .toMatchObject({ installationId, status: 'not_ready', receiptId: null })

      fs.unlinkSync(exportPath)
      const review = composition.service.reviewGuidedRemoval(installationId)
      expect(review).toMatchObject({
        installationId, status: 'action_required', connectorName: 'tidemind-cowork.plugin',
      })
      const confirmed = await composition.service.confirmGuidedRemoval(review.actionHash)
      expect(confirmed).toMatchObject({ installationId, status: 'removal_confirmed' })
      await composition.service.scan()

      expect(composition.repository.getInstallation(installationId)).toMatchObject({
        desired_state: 'removed',
        status_reason: 'disconnect_verified',
      })
      expect(db.prepare(`
        SELECT state FROM reconcile_runs WHERE installation_id = ? AND operation_type = 'disconnect'
      `).all(installationId)).toEqual([{ state: 'committed' }])
      // The user's receipt completes the disconnect, but it is not a host reload
      // signal: Tide Mind's bridge is stopped and host components await reload.
      expect(composition.service.detail(installationId).installation.deactivation).toEqual({
        maintenance: 'active', bridge: 'stopped', hostComponents: 'awaiting_reload',
      })
      expect(db.prepare(`
        SELECT result, evidence_ref FROM verification_results
        WHERE installation_id = ? AND evidence_ref LIKE 'user-confirmed-guided-removal:%'
      `).all(installationId)).toHaveLength(2)
      // The receipt is single-use for this exact pending generation.
      expect(() => composition.service.reviewGuidedRemoval(installationId)).toThrow('guided removal action is unavailable')
      // The ledger closed consistently: an explicit reconnect can export again.
      const reconnect = await composition.service.previewConnect([installationId])
      expect(reconnect.installations[0].diagnostics).not.toContain('claude_cowork_plugin_archive_conflict')
      expect(reconnect.installations[0].targets.length).toBeGreaterThan(0)
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
