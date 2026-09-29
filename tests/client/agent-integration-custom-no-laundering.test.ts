import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/tidemind-custom-laundering-test',
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
import { createCustomLocalMcpHostAdapter } from '../../client/electron/agent-integration/hosts/custom-local-mcp-adapter'
import type { AdapterRuntimeContext } from '../../client/electron/agent-integration/types'
import {
  knownReasonCodeIn,
  statusReasonKey,
} from '../../client/src/components/settings/agent-integration-managed/presentation'

describe('Custom MCP cannot launder a discovered host configuration (design §3.2)', () => {
  it('rejects a manual_mcp_client file or folder that belongs to a discovered Installation', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-no-laundering-')))
    const home = path.join(root, 'home')
    const appData = path.join(root, 'app-data')
    const cursorRoot = path.join(home, '.cursor')
    const cursorMcp = path.join(cursorRoot, 'mcp.json')
    const cursorSibling = path.join(cursorRoot, 'other-client.json')
    const privateConfig = path.join(home, '.private-agent', 'mcp.json')
    const executable = path.join(home, 'bin', 'private-agent')
    for (const directory of [cursorRoot, path.dirname(privateConfig), path.dirname(executable), appData]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    for (const file of [cursorMcp, cursorSibling, privateConfig]) fs.writeFileSync(file, '{}\n', { mode: 0o600 })
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
    const db = new Database(':memory:')
    ensureSchema(db)
    const composition = createProductionAgentIntegrationComposition(db, {
      homeDir: home, applicationDataDir: appData, runtimeContext: runtime,
      adapters: new Map([['custom-local-mcp', createCustomLocalMcpHostAdapter()]]),
      enabledAdapterIds: ['custom-local-mcp'],
      scanner: { scan: async () => ({ installations: [], unresolved: [], diagnostics: [] }) },
      startRuntime: false,
      notifications: { deliver: vi.fn() },
    })
    const unbind = bindAgentIntegrationExecutionPort(composition.coordinator)
    composition.repository.upsertDiscoveredInstallation({
      id: 'installation-cursor-discovered', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: `cursor-desktop:${cursorRoot}`, distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'app_bundle', osUserIdentity: 'usr_laundering_fixture', displayName: 'Cursor',
      configRoot: cursorRoot, detectedVersion: '3.19.7', agentId: 'eb_cursor_discovered',
      supportedCapability: 4, lastDetectedAt: '2026-09-25T00:00:00.000Z',
      metadata: {
        componentConfigFiles: { memory_tools: cursorMcp, lifecycle: path.join(cursorRoot, 'hooks.json') },
        componentConfigRoots: { instruction: path.join(cursorRoot, 'skills') },
      },
    })
    const request = (configFilePath: string, selectorKey: string) => ({
      mode: 'manual_mcp_client' as const,
      displayName: 'Private Agent',
      clientExecutablePath: executable,
      configFilePath,
      schemaKind: 'standard_mcp_servers' as const,
      selectorKey,
    })
    try {
      await expect(composition.service.previewCustomInstallation(request(cursorMcp, 'tidemind-private')))
        .rejects.toThrow('custom_config_owned_by_discovered_host')
      await expect(composition.service.previewCustomInstallation(request(cursorSibling, 'tidemind-private')))
        .rejects.toThrow('custom_config_owned_by_discovered_host')
      expect(composition.repository.listInstallations().map(row => row.host_variant)).toEqual(['cursor-desktop'])

      // A private client's own file stays available through Custom.
      const preflight = await composition.service.previewCustomInstallation(request(privateConfig, 'tidemind-private'))
      expect(preflight.mode).toBe('manual_mcp_client')

      // An existing Custom row that already points at the discovered host's file
      // (created before this check) cannot be (re)connected either.
      const allowed = await composition.service.prepareCustomConnect(preflight.preflightHash)
      const customId = allowed.installations[0]!.installationId
      const customRow = composition.repository.getInstallation(customId)!
      const metadata = JSON.parse(customRow.metadata_json) as { componentConfigFiles: Record<string, string> }
      metadata.componentConfigFiles.memory_tools = cursorMcp
      db.prepare('UPDATE agent_installations SET metadata_json = ?, config_root = ? WHERE id = ?')
        .run(JSON.stringify(metadata), cursorRoot, customId)
      await expect(composition.service.previewConnect([customId]))
        .rejects.toThrow('custom_config_owned_by_discovered_host')
    } finally {
      unbind()
      composition.runtime.stop()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('presents the stable reason code from a wrapped IPC failure', () => {
    const message = "Error invoking remote method 'agent-integrations:preview-custom': Error: custom_config_owned_by_discovered_host"
    expect(knownReasonCodeIn(message)).toBe('custom_config_owned_by_discovered_host')
    expect(statusReasonKey('custom_config_owned_by_discovered_host'))
      .toBe('agent.managed.reason.customConfigOwnedByDiscoveredHost')
    expect(knownReasonCodeIn('the selected client file is not executable')).toBeNull()
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt-BR', 'ru', 'tr']) {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, `../../client/src/locales/${locale}/settings.json`), 'utf8'))
      expect(settings.agent.managed.reason.customConfigOwnedByDiscoveredHost, locale).toEqual(expect.any(String))
    }
  })
})
