import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { ensureSchema } from '../src/db/schema.js'

it('initializes vector capability on the first authorized request after lazy MCP startup', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lazy-vec-'))
  const data = path.join(home, '.tidemind'); fs.mkdirSync(path.join(data, 'graph'), { recursive: true })
  fs.writeFileSync(path.join(data, 'config.toml'), `[general]\ndata_dir=${JSON.stringify(data)}\n[embedding]\nprovider="ollama"\nmodel="test"\ndimensions=4\n`)
  const dbPath = path.join(data, 'graph', 'brain.sqlite')
  const seed = new Database(dbPath); ensureSchema(seed)
  seed.prepare("INSERT INTO nodes(id,type,content,created,updated) VALUES ('vec-init-probe','fact','synthetic vector initialization probe',datetime('now'),datetime('now'))").run()
  seed.close()
  const child = spawn(path.resolve('node_modules/.bin/tsx'), [path.resolve('src/index.ts')], {
    env: { ...process.env, HOME: home, EB_AGENT_ID: 'eb_1234abcd', EB_ACTIVITY_GENERATION_TOKEN: '', EB_HOST_VARIANT: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''; let diagnostics = ''; let sequence = 0
  const pending = new Map<number, (value: any) => void>()
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id) } catch {}
    }
  })
  child.stderr.on('data', chunk => { diagnostics += String(chunk) })
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${diagnostics}`)), 15000)
    pending.set(id, value => { clearTimeout(timer); resolve(value) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const hasVectorTable = () => {
    const db = new Database(dbPath, { readonly: true })
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='nodes_vec'").get() } finally { db.close() }
  }
  try {
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lazy-vector-test', version: '1' } })
    expect(initialized.error, diagnostics).toBeUndefined()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    expect(hasVectorTable()).toBe(false)
    const response = await request('tools/call', { name: 'brain_recall', arguments: { node_id: 'vec-init-probe' } })
    expect(response.error, diagnostics).toBeUndefined()
    expect(response.result?.isError, diagnostics).not.toBe(true)
    expect(hasVectorTable(), diagnostics).toBe(true)
  } finally {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    await closed; clearTimeout(force)
    fs.rmSync(home, { recursive: true, force: true })
  }
})
