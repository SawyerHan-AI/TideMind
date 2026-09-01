import type Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { registerNodeHandlers } from './nodes'
import { registerStatsHandlers } from './stats'
import { registerOperationHandlers } from './operations'
import { registerStreamHandlers } from './stream'
import { registerConfigHandlers } from './config'
import { registerHealthHandlers } from './health'
import { registerWriteHandlers } from './write'
import { registerTimelineHandlers } from './timeline'
import { registerExportHandlers } from './export'
import { registerCredentialHandlers } from './credentials'
import { registerEmbeddingHandlers } from './embedding'
import { registerAgentHandlers } from './agents'
import { registerPluginGeneratorHandlers } from './plugin-generator'
import { registerNoteSourceHandlers } from './note-sources'
import { registerConnectionHandlers } from './connections'
import { registerCloudHandlers } from './cloud'
import { registerAppHandlers } from './app'
import { registerUpdaterHandlers } from './updater'
import { registerLLMHealthHandlers } from './llm-health'
import { registerAgentIntegrationHandlers } from './agent-integrations'
import {
  createProductionAgentIntegrationService,
  startProductionAgentIntegrationRuntime,
} from '../agent-integration/production-service'
import type { ProductionAgentIntegrationOptions } from '../agent-integration/production-service'
import { setAppLanguage } from '../app-language'

export function registerAllHandlers(
  db: Database.Database,
  dataDir: string,
  options: { agentIntegration?: ProductionAgentIntegrationOptions } = {},
): void {
  registerNodeHandlers(db)
  registerStatsHandlers(db)
  registerOperationHandlers(db)
  registerStreamHandlers(dataDir)
  registerConfigHandlers(dataDir)
  registerHealthHandlers(dataDir)
  registerWriteHandlers(db)
  registerTimelineHandlers(db)
  registerExportHandlers(db, dataDir)
  registerCredentialHandlers(dataDir)
  registerEmbeddingHandlers(db)
  registerAgentHandlers(dataDir)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
    ?? pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  const agentIntegrationService = createProductionAgentIntegrationService(db, {
    ...options.agentIntegration,
    startRuntime: false,
  })
  registerAgentIntegrationHandlers(agentIntegrationService, {
    expectedRendererUrl: rendererUrl,
  })
  registerPluginGeneratorHandlers(dataDir)
  registerNoteSourceHandlers()
  registerConnectionHandlers(dataDir)
  registerCloudHandlers(db)
  registerAppHandlers({ onLanguageReady: startProductionAgentIntegrationRuntime })
  registerUpdaterHandlers()
  registerLLMHealthHandlers(db)
}

/**
 * Hermetic visual-audit surface.  Only local fixture configuration and the
 * Agent Integration API are reachable; cloud, updater, shell, credentials,
 * note sources and host CLI handlers are intentionally not registered.
 */
export function registerAgentIntegrationUiAuditHandlers(
  db: Database.Database,
  dataDir: string,
  agentIntegration: ProductionAgentIntegrationOptions,
): void {
  ipcMain.handle('config:get', () => {
    try {
      const configPath = path.join(dataDir, 'config.toml')
      return fs.existsSync(configPath) ? parseToml(fs.readFileSync(configPath, 'utf8')) : {}
    } catch {
      return {}
    }
  })
  // Read-only shell chrome dependencies.  Their mutating sibling channels are
  // deliberately absent in audit mode.
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:set-language', (_event, language: unknown) => {
    try {
      return { success: true, language: setAppLanguage(language) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('updater:get-state', () => ({ status: 'idle' }))
  ipcMain.handle('cloud:status', () => ({
    loggedIn: false,
    syncEnabled: false,
    online: false,
    syncing: false,
    outboxCount: null,
    cloudNotAvailable: true,
  }))
  ipcMain.handle('llm:health', () => ({
    circuitState: 'closed',
    failures: 0,
    openedAt: 0,
    cooldownMs: 0,
    lastSuccessAt: 0,
    lastError: null,
    lastErrorAt: 0,
    availableCount: 0,
    needsAttentionCount: 0,
    activeTask: null,
  }))
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
    ?? pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  registerAgentIntegrationHandlers(createProductionAgentIntegrationService(db, agentIntegration), {
    expectedRendererUrl: rendererUrl,
  })
}
