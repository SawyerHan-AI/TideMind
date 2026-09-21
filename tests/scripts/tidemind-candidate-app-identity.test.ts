import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error local plain-ESM release helper has no declaration file
import {
  hashPhysicalAppBundle,
  TIDEMIND_RELEASE_BUNDLE_ID,
  TIDEMIND_RELEASE_TEAM_ID,
} from '../../scripts/tidemind-candidate-app-identity.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('physical Tide Mind candidate identity', () => {
  it('uses the repository-authoritative bundle and Developer ID Team', () => {
    expect(TIDEMIND_RELEASE_BUNDLE_ID).toBe('com.tidemind.app')
    expect(TIDEMIND_RELEASE_TEAM_ID).toBe('Z4U232GXH5')
  })

  it('hashes physical paths, modes, symlink targets, and file bytes deterministically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-candidate-hash-'))
    roots.push(root)
    const app = path.join(root, 'Tide Mind.app')
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
    const executable = path.join(app, 'Contents', 'MacOS', 'Tide Mind')
    fs.writeFileSync(executable, 'candidate')
    fs.chmodSync(executable, 0o755)
    fs.symlinkSync('MacOS/Tide Mind', path.join(app, 'Contents', 'Current'))
    const first = hashPhysicalAppBundle(app)
    expect(hashPhysicalAppBundle(app)).toBe(first)
    fs.chmodSync(executable, 0o644)
    expect(hashPhysicalAppBundle(app)).not.toBe(first)
  })
})
