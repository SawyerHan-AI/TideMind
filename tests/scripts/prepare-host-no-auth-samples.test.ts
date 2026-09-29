import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadHostNoAuthSamples, validateHostSampleArtifact, prepareHostNoAuthSamples } from '../../scripts/prepare-host-no-auth-samples.mjs'
import { loadAgentHostAcceptanceRequirements } from '../../scripts/verify-agent-integration-host-acceptance.mjs'
import { extractPartialCandidateAppArchive } from '../../scripts/verify-partial-auth-release.mjs'

const roots: string[] = []
const hash = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
function temp() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-no-auth-samples-'))); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })

describe('frozen no-auth Desktop sample preparation', () => {
  it('binds the two Apps / three targets to the actual complete frozen ARM receipts', () => {
    const samples = loadHostNoAuthSamples()
    const requirements = loadAgentHostAcceptanceRequirements()
    expect(samples.map((sample: any) => sample.catalogIds)).toEqual([['codex-desktop'], ['claude-cowork-local', 'claude-desktop-legacy']])
    for (const sample of samples) {
      for (const catalogId of sample.catalogIds) {
        const targets = requirements.targets.filter((target: any) => target.catalogId === catalogId && target.architecture === 'arm64')
        expect(targets.flatMap((target: any) => target.acceptedDistributionArtifacts)).toContainEqual(sample.receipt)
      }
    }
  })

  it.each(['artifact-hash', 'publisher', 'catalog', 'duplicate-app', 'unapproved-host'])(
    'rejects valid-looking recipe drift: %s', drift => {
      const filename = path.resolve('scripts/host-no-auth-desktop-samples.json')
      const recipe = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (drift === 'artifact-hash') recipe.samples[0].receipt.artifactSha256 = 'a'.repeat(64)
      if (drift === 'publisher') recipe.samples[0].receipt.signedCode.teamIdentifier = 'OTHER12345'
      if (drift === 'catalog') recipe.samples[0].catalogIds = ['cursor-desktop']
      if (drift === 'duplicate-app') recipe.samples[1] = recipe.samples[0]
      if (drift === 'unapproved-host') recipe.samples[0].sourceUrl = 'https://unapproved.invalid/sample.zip'
      const originalRead = fs.readFileSync
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        if (String(args[0]).endsWith('/host-no-auth-desktop-samples.json')) return JSON.stringify(recipe)
        return originalRead(...args)
      })
      expect(loadHostNoAuthSamples).toThrow()
    },
  )

  it('checks exact bytes and refuses file or ancestor symlinks without following them', () => {
    const root = temp(), archive = path.join(root, 'sample.zip'), original = Buffer.from('original')
    fs.writeFileSync(archive, original)
    const receipt = { artifactSizeBytes: original.length, artifactSha256: hash(original) }
    expect(() => validateHostSampleArtifact(archive, receipt)).not.toThrow()
    fs.writeFileSync(archive, 'tampered')
    expect(() => validateHostSampleArtifact(archive, receipt)).toThrow(/SHA-256/)
    fs.writeFileSync(archive, original)
    fs.symlinkSync(archive, path.join(root, 'linked.zip'))
    expect(() => validateHostSampleArtifact(path.join(root, 'linked.zip'), receipt)).toThrow()
    const real = path.join(root, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'sample.zip'), original)
    fs.symlinkSync(real, path.join(root, 'linked-dir'))
    expect(() => validateHostSampleArtifact(path.join(root, 'linked-dir/sample.zip'), receipt)).toThrow()
  })

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('rejects an output-parent symlink before any download or App staging', async () => {
    const root = temp(), workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside')
    fs.mkdirSync(workspace); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(workspace, 'redirect'))
    const download = vi.fn(async () => { throw new Error('unexpected network attempt') }); vi.stubGlobal('fetch', download)
    await expect(prepareHostNoAuthSamples({ workspace, output: path.join(workspace, 'redirect/result.json') })).rejects.toThrow(/canonical|symlink/)
    expect(download).not.toHaveBeenCalled()
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.existsSync(path.join(workspace, 'home'))).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('uses the strict fixed-snapshot extractor for both reviewed App roots and safe framework links', () => {
    const root = temp()
    const python = String.raw`import sys,zipfile,stat,json
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name,kind,body in json.loads(sys.argv[2]):
  i=zipfile.ZipInfo(name);i.create_system=3
  i.external_attr=((stat.S_IFDIR|0o755) if kind=='dir' else (stat.S_IFLNK|0o777) if kind=='link' else (stat.S_IFREG|0o644))<<16
  z.writestr(i,body)
`
    for (const app of ['ChatGPT.app', 'Claude.app']) {
      const common = [[`${app}/`, 'dir', ''], [`${app}/Contents/`, 'dir', ''],
        [`${app}/Contents/Versions/`, 'dir', ''], [`${app}/Contents/Versions/A/`, 'dir', ''],
        [`${app}/Contents/Versions/A/engine`, 'file', 'fixture; never executed'],
        [`${app}/Contents/Versions/Current`, 'link', 'A'], [`${app}/Contents/Engine`, 'link', 'Versions/Current/engine']]
      const cases = [[], [[`${app}/Contents/escape`, 'link', '../../outside']],
        [[`${app}/Contents/abs`, 'link', '/tmp/outside']], [[`${app}/Contents/missing`, 'link', 'no-such-file']],
        [[`${app}/Contents/Versions/Current/child`, 'file', 'must not follow symlink parent']],
        [[`${app}/Contents/a`, 'link', 'b'], [`${app}/Contents/b`, 'link', 'a']],
        [['Other.app/', 'dir', '']]]
      for (const [index, added] of cases.entries()) {
        const archive = path.join(root, `${app}-${index}.zip`), destination = path.join(root, `${app}-${index}-out`), snapshot = path.join(root, `${app}-${index}-snapshot.zip`)
        execFileSync('/usr/bin/python3', ['-I', '-S', '-c', python, archive, JSON.stringify([...common, ...added])])
        const extract = () => extractPartialCandidateAppArchive(archive, hash(fs.readFileSync(archive)), destination, snapshot, app)
        if (index === 0) {
          expect(extract().symlinks).toBe(2)
          expect(fs.readlinkSync(path.join(destination, app, 'Contents/Engine'))).toBe('Versions/Current/engine')
        } else {
          expect(extract).toThrow()
          expect(fs.existsSync(destination)).toBe(false)
        }
      }
    }
    expect(fs.existsSync(path.join(root, 'outside'))).toBe(false)
    expect(() => extractPartialCandidateAppArchive('unused', 'a'.repeat(64), 'unused', 'unused', 'Other.app')).toThrow('unreviewed App ZIP root')
  })
})
