import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getClientDb, closeClientDb } from '../../client/electron/db'
import { CURRENT_SCHEMA_VERSION, ensureSchema } from '../../src/db/schema'
import { RECOVERY_LINEAGE } from '../../src/db/schema41-recovery'

const roots: string[] = []
afterEach(() => {
  closeClientDb()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Electron first-run database handoff', () => {
  it('uses the client old-database entry and paired backup for a synthetic database marked v35', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-electron-old-db-')); roots.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dataDir = path.join(home, '.tidemind'), graph = path.join(dataDir, 'graph')
    fs.mkdirSync(graph, { recursive: true })
    const config = '[general]\ndata_dir = ' + JSON.stringify(dataDir) + '\n'
    fs.writeFileSync(path.join(dataDir, 'config.toml'), config)
    const filename = path.join(graph, 'brain.sqlite')
    const prior = new Database(filename)
    // Current structure with a v35 marker exercises client migration routing and backup,
    // not an authentic historical v35 schema. Signed historical App acceptance covers that.
    ensureSchema(prior)
    prior.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES('history','fact','preserved old memory','2026-09-01','2026-09-01')").run()
    prior.prepare("UPDATE metadata SET value='35' WHERE key='schema_version'").run()
    prior.prepare("DELETE FROM metadata WHERE key='schema_lineage'").run()
    prior.close()

    const client = getClientDb(dataDir)
    expect(client.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: String(CURRENT_SCHEMA_VERSION) })
    expect(client.prepare("SELECT value FROM metadata WHERE key='schema_lineage'").get()).toEqual({ value: RECOVERY_LINEAGE })
    expect(client.prepare("SELECT content FROM nodes WHERE id='history'").get()).toEqual({ content: 'preserved old memory' })
    const backup = fs.readdirSync(graph).find(name => name.startsWith('brain.backup-'))!
    expect(backup).toBeTruthy()
    const snapshot = new Database(path.join(graph, backup), { readonly: true })
    try {
      expect(snapshot.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: '35' })
      expect(snapshot.prepare("SELECT content FROM nodes WHERE id='history'").get()).toEqual({ content: 'preserved old memory' })
    } finally { snapshot.close() }
    expect(fs.readFileSync(path.join(graph, backup.replace('brain.backup-', 'config.backup-').replace('.sqlite', '.toml')), 'utf8')).toBe(config)
  })

  it('finishes the authoritative schema before a daemon/MCP process opens beside its long-lived connection', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-electron-new-db-')); roots.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dataDir = path.join(home, '.tidemind')
    fs.mkdirSync(dataDir)
    const config = path.join(dataDir, 'config.toml')
    fs.writeFileSync(config, `[general]\ndata_dir = ${JSON.stringify(dataDir)}\n`)
    const filename = path.join(dataDir, 'graph', 'brain.sqlite')
    expect(fs.existsSync(filename)).toBe(false)

    // No mocks for the client/schema/migration/database entrypoints.
    const client = getClientDb(dataDir)
    expect(client.open).toBe(true)
    expect(client.prepare("SELECT value FROM metadata WHERE key='schema_version'").get())
      .toEqual({ value: String(CURRENT_SCHEMA_VERSION) })
    expect(client.prepare("SELECT value FROM metadata WHERE key='schema_lineage'").get())
      .toEqual({ value: RECOVERY_LINEAGE })
    // This core table is absent from the former client-only inline DDL.
    expect(client.prepare("SELECT name FROM sqlite_master WHERE name='tag_usage'").get()).toBeTruthy()

    const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
    const child = `
      import { loadConfig } from './src/config.ts';
      import { getDb, closeDb } from './src/db/connection.ts';
      loadConfig(process.env.TIDEMIND_TEST_CONFIG);
      const db = getDb();
      db.prepare("INSERT INTO metadata(key,value) VALUES('first_run_peer','opened')").run();
      process.stdout.write(JSON.stringify(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()));
      closeDb();
    `
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: projectRoot, env: { ...process.env, HOME: home, TIDEMIND_TEST_CONFIG: config },
      encoding: 'utf8', timeout: 30_000,
    })
    expect(JSON.parse(output)).toEqual({ value: String(CURRENT_SCHEMA_VERSION) })
    expect(client.open).toBe(true)
    expect(client.prepare("SELECT value FROM metadata WHERE key='first_run_peer'").get()).toEqual({ value: 'opened' })
    expect(fs.readdirSync(path.dirname(filename)).some(name => name.startsWith('brain.backup-'))).toBe(false)
  }, 40_000)
})
