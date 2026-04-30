import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readJsonSafe,
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
})
