import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readJsonSafe,
  readJsonStrict,
  unlinkIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from '../../client/electron/ipc/agent-plugins/fs-utils'

describe('agent plugin fs utils', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-fs-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes files atomically into nested directories', () => {
    const target = path.join(tmpDir, 'nested', 'file.txt')

    writeFileAtomic(target, 'hello')

    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
    expect(fs.readdirSync(path.dirname(target)).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it('reads json with a safe fallback', () => {
    const target = path.join(tmpDir, 'config.json')
    const fallback = { ok: false }

    expect(readJsonSafe(target, fallback)).toBe(fallback)
    fs.writeFileSync(target, '{')
    expect(readJsonSafe(target, fallback)).toBe(fallback)

    writeJsonAtomic(target, { ok: true, count: 2 })
    expect(readJsonSafe(target, fallback)).toEqual({ ok: true, count: 2 })
  })

  it('ignores missing files when unlinking generated artifacts', () => {
    const target = path.join(tmpDir, 'gone.txt')

    expect(() => unlinkIfExists(target)).not.toThrow()
    writeFileAtomic(target, 'bye')
    unlinkIfExists(target)
    expect(fs.existsSync(target)).toBe(false)
  })

  describe('readJsonStrict (third-party config files)', () => {
    it('returns whenMissing when file does not exist', () => {
      const target = path.join(tmpDir, 'absent.json')
      const fallback = { mcpServers: {} }
      expect(readJsonStrict(target, fallback)).toBe(fallback)
    })

    it('parses valid JSON normally', () => {
      const target = path.join(tmpDir, 'good.json')
      fs.writeFileSync(target, JSON.stringify({ a: 1 }))
      expect(readJsonStrict(target, {})).toEqual({ a: 1 })
    })

    it('throws and writes a backup when JSON is malformed (does NOT silently fall back)', () => {
      const target = path.join(tmpDir, 'broken.json')
      const original = '{"mcpServers": { "pencil": ... broken'
      fs.writeFileSync(target, original)

      expect(() => readJsonStrict(target, {})).toThrow(/Refused to overwrite/)

      // Original file untouched
      expect(fs.readFileSync(target, 'utf-8')).toBe(original)

      // A .bak sibling exists with the original content
      const baks = fs.readdirSync(tmpDir).filter(n => n.startsWith('broken.json.tidemind-backup-') && n.endsWith('.bak'))
      expect(baks.length).toBe(1)
      expect(fs.readFileSync(path.join(tmpDir, baks[0]), 'utf-8')).toBe(original)
    })
  })
})
