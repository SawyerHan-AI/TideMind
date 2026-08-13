import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

const temporaryDirectories: string[] = []

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-release-metadata-'))
  temporaryDirectories.push(directory)
  for (const [arch, offset] of [['x64', 1], ['arm64', 2]] as const) {
    const zipName = `Tide.Mind-0.2.89-${arch}.zip`
    const dmgName = `Tide.Mind-0.2.89-${arch}.dmg`
    const zip = Buffer.from(`${arch}-zip-asset`)
    const dmg = Buffer.from(`${arch}-dmg-asset`)
    fs.writeFileSync(path.join(directory, zipName), zip)
    fs.writeFileSync(path.join(directory, dmgName), dmg)
    fs.writeFileSync(path.join(directory, `latest-mac-${arch}.yml`), yaml.dump({
      version: '0.2.89',
      files: [
        { url: zipName, sha512: crypto.createHash('sha512').update(zip).digest('base64'), size: zip.length },
        { url: dmgName, sha512: crypto.createHash('sha512').update(dmg).digest('base64'), size: dmg.length },
      ],
      path: `Tide.Mind-0.2.89-${arch}.zip`,
      sha512: `${arch}-zip`,
      releaseDate: `2026-08-12T00:00:0${offset}.000Z`,
    }))
  }
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('macOS update metadata merger', () => {
  it('preserves both architectures and the legacy x64 primary path', () => {
    const directory = fixture()
    execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', directory])
    const merged = yaml.load(fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf8')) as {
      version: string
      files: Array<{ url: string }>
      path: string
      releaseDate: string
    }
    expect(merged.version).toBe('0.2.89')
    expect(merged.files.map((entry) => entry.url)).toEqual([
      'Tide.Mind-0.2.89-x64.zip',
      'Tide.Mind-0.2.89-x64.dmg',
      'Tide.Mind-0.2.89-arm64.zip',
      'Tide.Mind-0.2.89-arm64.dmg',
    ])
    expect(merged.path).toBe('Tide.Mind-0.2.89-x64.zip')
    expect(merged.releaseDate).toBe('2026-08-12T00:00:02.000Z')
  })

  it('rejects a document whose filename and artifact architecture disagree', () => {
    const directory = fixture()
    const arm64 = yaml.load(fs.readFileSync(path.join(directory, 'latest-mac-arm64.yml'), 'utf8')) as {
      files: Array<{ url: string }>
    }
    arm64.files = arm64.files.map((entry) => ({ ...entry, url: entry.url.replace('arm64', 'x64') }))
    fs.writeFileSync(path.join(directory, 'latest-mac-arm64.yml'), yaml.dump(arm64))
    expect(() => execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', directory]))
      .toThrow(/does not contain the arm64 ZIP/)
  })

  it.each([
    ['size', (entry: { size: number; sha512: string }) => { entry.size += 1 }],
    ['sha512', (entry: { size: number; sha512: string }) => { entry.sha512 = 'tampered' }],
  ])('rejects metadata whose %s does not match the downloaded asset', (_field, mutate) => {
    const directory = fixture()
    const x64Path = path.join(directory, 'latest-mac-x64.yml')
    const x64 = yaml.load(fs.readFileSync(x64Path, 'utf8')) as { files: Array<{ size: number; sha512: string }> }
    mutate(x64.files[0])
    fs.writeFileSync(x64Path, yaml.dump(x64))
    expect(() => execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', directory]))
      .toThrow(/mismatch/)
  })

  it('rejects missing assets and path traversal', () => {
    const directory = fixture()
    const x64Path = path.join(directory, 'latest-mac-x64.yml')
    const x64 = yaml.load(fs.readFileSync(x64Path, 'utf8')) as { files: Array<{ url: string }> }
    fs.unlinkSync(path.join(directory, x64.files[0].url))
    expect(() => execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', directory]))
      .toThrow(/artifact is missing/)
    x64.files[0].url = '../escape.zip'
    fs.writeFileSync(x64Path, yaml.dump(x64))
    expect(() => execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', directory]))
      .toThrow(/must be a basename/)
  })
})
