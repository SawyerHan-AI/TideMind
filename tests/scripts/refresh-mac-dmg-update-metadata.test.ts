import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { refreshMacDmgUpdateMetadata } from '../../scripts/refresh-mac-dmg-update-metadata.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('refresh stapled DMG update metadata', () => {
  it('regenerates the blockmap and binds metadata to final DMG bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-dmg-metadata-'))
    roots.push(root)
    const dmgName = 'Tide.Mind-0.2.89-x64.dmg'
    const dmg = path.join(root, dmgName)
    fs.writeFileSync(dmg, 'pre-staple')
    fs.writeFileSync(path.join(root, 'latest-mac.yml'), yaml.dump({
      version: '0.2.89',
      files: [
        { url: 'Tide.Mind-0.2.89-x64.zip', size: 3, sha512: 'zip' },
        { url: dmgName, size: 1, sha512: 'stale' },
      ],
      path: 'Tide.Mind-0.2.89-x64.zip',
      sha512: 'zip',
    }))
    fs.appendFileSync(dmg, '-ticket')

    const refreshed = await refreshMacDmgUpdateMetadata({ releaseDir: root, arch: 'x64', version: '0.2.89' })
    const document = yaml.load(fs.readFileSync(refreshed.metadata, 'utf8')) as any
    const entry = document.files.find((candidate: any) => candidate.url === dmgName)
    expect(entry.size).toBe(fs.statSync(dmg).size)
    expect(entry.sha512).toBe(crypto.createHash('sha512').update(fs.readFileSync(dmg)).digest('base64'))
    expect(fs.statSync(refreshed.blockmap).size).toBeGreaterThan(0)
    expect(document.path).toBe('Tide.Mind-0.2.89-x64.zip')
    expect(document.sha512).toBe('zip')
  })

  it('rejects mismatched versions and non-basename artifact URLs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-dmg-metadata-invalid-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'Tide.Mind-0.2.89-x64.dmg'), 'dmg')
    fs.writeFileSync(path.join(root, 'latest-mac.yml'), yaml.dump({
      version: '0.2.88',
      files: [{ url: '../Tide.Mind-0.2.89-x64.dmg', size: 3, sha512: 'stale' }],
    }))
    await expect(refreshMacDmgUpdateMetadata({ releaseDir: root, arch: 'x64', version: '0.2.89' }))
      .rejects.toThrow('invalid mac update metadata')
    fs.writeFileSync(path.join(root, 'latest-mac.yml'), yaml.dump({
      version: '0.2.89',
      files: [{ url: '../Tide.Mind-0.2.89-x64.dmg', size: 3, sha512: 'stale' }],
    }))
    await expect(refreshMacDmgUpdateMetadata({ releaseDir: root, arch: 'x64', version: '0.2.89' }))
      .rejects.toThrow('expected exactly one')
  })
})
