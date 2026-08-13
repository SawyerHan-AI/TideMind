import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AppConfig } from '../types.js'
import { readStrategiesStrict } from '../strategy/loader.js'
import {
  createMetabolismWorkerRuntimeSnapshot,
  type MetabolismWorkerRuntimeSnapshot,
} from './worker-runtime-snapshot.js'

interface ConnectionRow {
  id: string
  name: string
  provider_type: string
  credentials: string
  archived: number
  status: string
  status_reason: string | null
  candidate_models: string | null
  available_models: string | null
  validation_fingerprint: string | null
  auth_fingerprint: string | null
  model_validation_json: string | null
}

function insideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function readCredentialFile(filePath: string, dataDir: string): unknown | null {
  if (!fs.existsSync(filePath)) return null
  const sourceStat = fs.lstatSync(filePath)
  if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw new Error('credential source is not a single-link regular file')
  const real = fs.realpathSync.native(filePath)
  if (!insideRoot(real, dataDir)) throw new Error('credential file escaped authorized data dir')
  const stat = fs.statSync(real)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_000_000) throw new Error('credential file is not an authorized regular file')
  const parsed = JSON.parse(fs.readFileSync(real, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error('credential file is not a plain object')
  }
  return parsed
}

export function buildMetabolismWorkerRuntimeSnapshotFromInitializedMain(
  db: Database.Database,
  config: AppConfig,
  dataDirInput: string,
  runtimeRevision: number,
): MetabolismWorkerRuntimeSnapshot {
  const dataDir = fs.realpathSync.native(dataDirInput)
  const rows = db.prepare(`
    SELECT id, name, provider_type, credentials, archived, status, status_reason,
           candidate_models, available_models, validation_fingerprint,
           auth_fingerprint, model_validation_json
    FROM model_connections
    ORDER BY id
  `).all() as ConnectionRow[]
  const connections = rows.map(row => {
    let credentials: unknown
    try { credentials = JSON.parse(row.credentials) } catch { throw new Error(`connection credentials are invalid: ${row.id}`) }
    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      archived: row.archived !== 0,
      status: row.status,
      statusReason: row.status_reason,
      candidateModels: row.candidate_models,
      availableModels: row.available_models,
      validationFingerprint: row.validation_fingerprint,
      authFingerprint: row.auth_fingerprint,
      modelValidationJson: row.model_validation_json,
      credentials,
    }
  })

  const parsedStrategies = readStrategiesStrict(path.join(dataDir, 'strategies'))
  const strategy: Record<string, unknown> = {}
  for (const [name, parsed] of [...parsedStrategies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) strategy[name] = parsed

  const vertexFiles: Record<string, unknown> = {}
  const legacyVertex = readCredentialFile(path.join(dataDir, 'vertex-credentials.json'), dataDir)
  for (const row of rows.filter(row => row.provider_type === 'vertex')) {
    const value = readCredentialFile(path.join(dataDir, `vertex-credentials-${row.id}.json`), dataDir)
    if (value) vertexFiles[row.id] = value
  }

  return createMetabolismWorkerRuntimeSnapshot({
    runtimeConfig: config,
    connections,
    strategy,
    credentials: { legacyVertex, vertexFiles },
    authorizedRoots: { dataDir },
  }, runtimeRevision)
}
