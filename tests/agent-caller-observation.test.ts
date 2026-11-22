import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AGENT_CALLER_OBSERVATION_SCHEMA_SQL, attributeCaller, callerWasDisconnected, configurationOwnerId, observeCallerAncestry, recordCallerObservation } from '../src/agent-caller-observation'

function ledger() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE agent_installations (id TEXT, host_variant TEXT, app_path TEXT, executable_path TEXT, health_state TEXT,
    desired_state TEXT DEFAULT 'managed', tombstoned_at TEXT, family TEXT DEFAULT 'fixture', config_root TEXT,
    runtime_realm TEXT DEFAULT 'local_macos', os_user_identity TEXT DEFAULT 'synthetic')`)
  const add = db.prepare('INSERT INTO agent_installations(id,host_variant,app_path,executable_path,health_state) VALUES (?,?,?,?,?)')
  add.run('devin', 'windsurf-desktop', '/Applications/Devin.app', '/Applications/Devin.app/Contents/MacOS/Devin', 'discovered')
  add.run('cursor', 'cursor-desktop', '/Applications/Cursor.app', '/Applications/Cursor.app/Contents/MacOS/Cursor', 'discovered')
  add.run('qwen', 'qwen-code-cli', null, '/opt/npm/lib/node_modules/qwen/cli.js', 'discovered')
  add.run('agy', 'antigravity-cli', null, '/Users/fixture/.local/bin/agy', 'discovered')
  add.run('gone', 'zcode-desktop', '/Applications/ZCode.app', null, 'absent')
  return db
}
const chain = (...executables: Array<string | [string, string]>) => executables.map((entry, index) => ({
  pid: 100 + index, executable: typeof entry === 'string' ? entry : entry[0], args: typeof entry === 'string' ? entry : entry[1],
}))

describe('caller attribution', () => {
  it('credits the host that started the process even when another host configuration was loaded', () => {
    const db = ledger()
    expect(attributeCaller(db, chain(
      '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
      '/Applications/Devin.app/Contents/MacOS/Devin',
    ))).toEqual({ installationId: 'devin', hostVariant: 'windsurf-desktop', level: 'verified' })
    expect(attributeCaller(db, chain('/bin/sh', '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper')))
      .toMatchObject({ installationId: 'cursor', level: 'verified' })
  })

  it('treats a native CLI as verified and an interpreter-run CLI as inferred', () => {
    const db = ledger()
    expect(attributeCaller(db, chain('/Users/fixture/.local/bin/agy', '/bin/zsh'))).toMatchObject({ installationId: 'agy', level: 'verified' })
    expect(attributeCaller(db, chain(['/usr/local/bin/node', '/usr/local/bin/node /opt/npm/lib/node_modules/qwen/cli.js --flag'])))
      .toMatchObject({ installationId: 'qwen', level: 'inferred' })
    // A longer path that merely starts with the registered one is a different program.
    expect(attributeCaller(db, chain(['/usr/local/bin/node', '/usr/local/bin/node /opt/npm/lib/node_modules/qwen/cli.js.bak'])).level).toBe('unidentified')
    expect(attributeCaller(db, chain(['/usr/local/bin/node', 'node "/opt/npm/lib/node_modules/qwen/cli.js"'])).level).toBe('inferred')
  })

  it('leaves unknown, undiscovered and unreadable callers unidentified', () => {
    const db = ledger()
    const unidentified = { installationId: null, hostVariant: null, level: 'unidentified' }
    expect(attributeCaller(db, chain('/usr/bin/python3', '/sbin/launchd'))).toEqual(unidentified)
    expect(attributeCaller(db, chain('/Applications/ZCode.app/Contents/MacOS/ZCode'))).toEqual(unidentified)
    expect(attributeCaller(db, [])).toEqual(unidentified)
    expect(attributeCaller(new Database(':memory:'), chain('/Applications/Devin.app/Contents/MacOS/Devin'))).toEqual(unidentified)
  })

  it('reads a bounded chain and survives a failing reader', () => {
    const table: Record<number, { ppid: number; executable: string; args: string }> = {
      10: { ppid: 9, executable: '/a', args: '/a' }, 9: { ppid: 1, executable: '/b', args: '/b' },
    }
    expect(observeCallerAncestry(10, pid => table[pid] ?? null).map(item => item.executable)).toEqual(['/a', '/b'])
    expect(observeCallerAncestry(10, () => { throw new Error('denied') })).toEqual([])
    expect(observeCallerAncestry(5, pid => ({ ppid: pid + 1, executable: '/loop', args: '' })).length).toBe(8)
  })

  it('accumulates use under the actual caller, not the configured identity', () => {
    const db = ledger(); db.exec(AGENT_CALLER_OBSERVATION_SCHEMA_SQL)
    const devin = { installationId: 'devin', hostVariant: 'windsurf-desktop', level: 'verified' as const }
    recordCallerObservation(db, 'eb_cursor', 'brain_recall', devin, '2026-01-01T00:00:00.000Z')
    recordCallerObservation(db, 'eb_cursor', 'brain_recall', devin, '2026-01-02T00:00:00.000Z')
    recordCallerObservation(db, 'eb_cursor', 'brain_recall', { installationId: null, hostVariant: null, level: 'unidentified' })
    expect(db.prepare(`SELECT caller_installation_id AS caller, use_count AS n, last_observed_at AS last
      FROM agent_caller_observations WHERE caller_installation_id='devin'`).get())
      .toEqual({ caller: 'devin', n: 2, last: '2026-01-02T00:00:00.000Z' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_caller_observations').get()).toEqual({ n: 2 })
    expect(() => recordCallerObservation(new Database(':memory:'), 'a', 'brain_recall', devin)).not.toThrow()
  })

  it('flags only a verified caller whose own connection the user removed', () => {
    const db = ledger()
    const devin = { installationId: 'devin', hostVariant: 'windsurf-desktop', level: 'verified' as const }
    expect(callerWasDisconnected(db, devin)).toBe(false)
    db.prepare("UPDATE agent_installations SET desired_state='removed' WHERE id='devin'").run()
    expect(callerWasDisconnected(db, devin)).toBe(true)
    expect(callerWasDisconnected(db, { ...devin, level: 'inferred' })).toBe(false)
    // A reinstalled, managed record of the same bundle outranks the removed one.
    db.prepare("INSERT INTO agent_installations(id,host_variant,app_path,executable_path,health_state) VALUES ('devin-new','windsurf-desktop','/Applications/Devin.app',NULL,'discovered')").run()
    const current = attributeCaller(db, [{ pid: 1, executable: '/Applications/Devin.app/Contents/MacOS/Devin', args: '' }])
    expect(current.installationId).toBe('devin-new')
    expect(callerWasDisconnected(db, current)).toBe(false)
    expect(callerWasDisconnected(db, { installationId: null, hostVariant: null, level: 'unidentified' })).toBe(false)
    expect(callerWasDisconnected(db, { ...devin, installationId: 'never-seen' })).toBe(false)
  })

  it('treats a CLI beside its desktop app as an entry point of the app connection', () => {
    const db = ledger()
    db.prepare("UPDATE agent_installations SET family='windsurf', config_root='/Users/fixture/.config/devin' WHERE id='devin'").run()
    db.prepare(`INSERT INTO agent_installations(id,host_variant,app_path,executable_path,health_state,desired_state,family,config_root)
      VALUES ('devin-cli','devin-cli',NULL,'/Users/fixture/.local/share/devin/cli/bin/devin','discovered','unmanaged','windsurf','/Users/fixture/.config/devin')`).run()
    const cli = attributeCaller(db, [{ pid: 1, executable: '/Users/fixture/.local/share/devin/cli/bin/devin', args: 'devin' }])
    expect(cli).toEqual({ installationId: 'devin-cli', hostVariant: 'devin-cli', level: 'verified' })
    expect(configurationOwnerId(db, 'devin-cli')).toBe('devin')
    expect(configurationOwnerId(db, 'devin')).toBe('devin')
    expect(configurationOwnerId(db, 'qwen')).toBe('qwen')
    expect(callerWasDisconnected(db, cli)).toBe(false)
    // Disconnecting the app disconnects the entry point that reads its configuration.
    db.prepare("UPDATE agent_installations SET desired_state='removed' WHERE id='devin'").run()
    expect(configurationOwnerId(db, 'devin-cli')).toBe('devin-cli')
    expect(callerWasDisconnected(db, cli)).toBe(true)
    // A never-connected product is not a disconnected one.
    db.prepare("UPDATE agent_installations SET desired_state='unmanaged' WHERE id='devin'").run()
    expect(callerWasDisconnected(db, cli)).toBe(false)
  })
})
