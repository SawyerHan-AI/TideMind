import type Database from 'better-sqlite3'
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

export function registerAllHandlers(db: Database.Database, dataDir: string): void {
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
  registerPluginGeneratorHandlers(dataDir)
  registerNoteSourceHandlers()
  registerConnectionHandlers(dataDir)
}
