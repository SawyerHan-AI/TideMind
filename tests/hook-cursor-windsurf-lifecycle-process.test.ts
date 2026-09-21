import { spawn } from 'node:child_process'
import { seedLifecycle } from './fixtures/seed-managed-lifecycle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureSchema } from '../src/db/schema.js'

describe('Cursor and Devin lifecycle stdout delivery boundary', { timeout: 30_000 }, () => {
  let isolatedHome: string
  let databasePath: string

  beforeAll(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-hook-epipe-'))
    const dataDir = path.join(isolatedHome, '.tidemind')
    const graphDir = path.join(dataDir, 'graph')
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.toml'), `[general]\ndata_dir = ${JSON.stringify(dataDir)}\n`)
    databasePath = path.join(graphDir, 'brain.sqlite')
    const db = new Database(databasePath)
    ensureSchema(db)
    seedLifecycle(db, 'eb_cursor_epipe', 'cursor', 'cursor-desktop')
    seedLifecycle(db, 'eb_windsurf_epipe', 'windsurf', 'windsurf-desktop')
    db.close()
  })

  afterAll(() => fs.rmSync(isolatedHome, { recursive: true, force: true }))

  for (const fixture of [
    {
      name: 'Cursor',
      source: 'src/hook-cursor-lifecycle.ts',
      args: ['--event', 'sessionEnd', '--agent-id', 'eb_cursor_epipe', '--activity-generation-token', 'generation_eb_cursor_epipe'],
      payload: { hook_event_name: 'sessionEnd', conversation_id: 'cursor-session', session_id: 'cursor-session', cursor_version: '3.10.20' },
      agentId: 'eb_cursor_epipe',
    },
    {
      name: 'Devin',
      source: 'src/hook-windsurf-lifecycle.ts',
      args: ['--event', 'SessionEnd', '--agent-id', 'eb_windsurf_epipe', '--activity-generation-token', 'generation_eb_windsurf_epipe'],
      payload: { hook_event_name: 'SessionEnd', session_id: 'devin-session', reason: 'logout' },
      agentId: 'eb_windsurf_epipe',
    },
  ] as const) {
    it(`does not let a real ${fixture.name} EPIPE mint lifecycle evidence`, async () => {
      const child = spawn(
        path.resolve('node_modules/.bin/tsx'),
        [path.resolve(fixture.source), ...fixture.args],
        {
          cwd: path.resolve('.'),
          env: { ...process.env, HOME: isolatedHome },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const stderr: Buffer[] = []
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      child.stdout.destroy()
      child.stdin.end(JSON.stringify(fixture.payload))
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      const diagnostics = Buffer.concat(stderr).toString('utf8')
      expect(result.code === 0 && result.signal === null).toBe(false)
      expect(diagnostics).toMatch(/(?:fatal error|output failed).*(?:EPIPE|write)/u)
      const db = new Database(databasePath, { readonly: true })
      try {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_host_activity_evidence
          WHERE agent_id = ? AND signal_name = 'session_end'`).get(fixture.agentId)).toEqual({ count: 0 })
      } finally {
        db.close()
      }
    })
  }
})
