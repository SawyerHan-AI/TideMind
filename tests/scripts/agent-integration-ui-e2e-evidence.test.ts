import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  validateAgentIntegrationUiE2eReceipt,
  verifyAgentIntegrationUiE2eEvidence,
  writeAgentIntegrationUiE2eEvidence,
} from '../../scripts/agent-integration-ui-e2e-evidence.mjs'

interface PathPrivacyFixture {
  readonly unsafe: ReadonlyArray<{
    readonly name: string
    readonly input: string
    readonly forbidden: readonly string[]
  }>
  readonly safe: ReadonlyArray<{ readonly name: string; readonly input: string }>
}
const PATH_V13_FIXTURE = JSON.parse(fs.readFileSync(
  new URL('../fixtures/agent-integration-path-privacy-v13.json', import.meta.url),
  'utf8',
)) as PathPrivacyFixture

describe('Agent Integration UI E2E retained evidence', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function fixture() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-evidence-test-'))
    roots.push(parent)
    const auditRoot = path.join(parent, 'audit')
    const artifactsDir = path.join(auditRoot, 'artifacts')
    const evidenceDir = path.join(parent, 'retained')
    fs.mkdirSync(artifactsDir, { recursive: true })
    fs.writeFileSync(path.join(artifactsDir, '01-wide.png'), Buffer.alloc(64, 1))
    fs.writeFileSync(path.join(artifactsDir, '02-detail.png'), Buffer.alloc(96, 2))
    return { parent, auditRoot, artifactsDir, evidenceDir }
  }

  function manifestSha256(evidenceDir: string) {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(evidenceDir, 'evidence-manifest.json')))
      .digest('hex')
  }

  it('exports relative screenshots and a manifest without temporary absolute paths', () => {
    const value = fixture()
    const report = {
      ok: true,
      auditRoot: value.auditRoot,
      screenshots: [path.join(value.artifactsDir, '01-wide.png')],
      verification: {
        skillPath: path.join(value.auditRoot, 'home', '.zcode', 'skills', 'tidemind', 'SKILL.md'),
      },
    }
    const manifest = writeAgentIntegrationUiE2eEvidence({ ...value, report })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    expect(serialized).not.toContain(value.auditRoot)
    expect(JSON.parse(serialized)).toMatchObject({
      auditRoot: '<isolated-audit-root>',
      screenshots: ['screenshots/01-wide.png', 'screenshots/02-detail.png'],
      verification: { skillPath: '<isolated-audit-root>/home/.zcode/skills/tidemind/SKILL.md' },
    })
    expect(manifest.files.map(file => file.path)).toEqual([
      'ui-e2e-report.json',
      'screenshots/01-wide.png',
      'screenshots/02-detail.png',
    ])
    expect(manifest.directories).toEqual([
      { path: '.', mode: '0700' },
      { path: 'screenshots', mode: '0700' },
    ])
    for (const directory of manifest.directories) {
      const retained = directory.path === '.'
        ? value.evidenceDir
        : path.join(value.evidenceDir, directory.path)
      expect(fs.statSync(retained).mode & 0o777).toBe(0o700)
    }
    for (const file of manifest.files) {
      const retained = path.join(value.evidenceDir, file.path)
      expect(file.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(retained)).digest('hex'))
      expect(file.mode).toBe('0600')
      expect(fs.statSync(retained).mode & 0o777).toBe(0o600)
    }
    expect(verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256: manifestSha256(value.evidenceDir),
    }).files).toEqual(manifest.files.map(file => file.path).sort())
  })

  it('redacts multiple embedded local paths while preserving public URLs, regex text, and audit markers', () => {
    const value = fixture()
    const outside = path.join(value.parent, 'Privacy Canary', 'secret.json')
    const report = {
      ok: false,
      diagnostic: `inside: "${path.join(value.auditRoot, 'home', 'Agent Secrets', 'config.json')}"; outside: "${outside}"; URL https://example.com/docs/path?q=1; regex \\d+\\w+; marker <isolated-audit-root>/already-safe`,
    }
    writeAgentIntegrationUiE2eEvidence({ ...value, report })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    expect(serialized).not.toContain(value.auditRoot)
    expect(serialized).not.toContain('Privacy Canary')
    expect(serialized).toContain('<isolated-audit-root>/home/Agent Secrets/config.json')
    expect(serialized.match(/<local-path>/gu)?.length).toBeGreaterThanOrEqual(1)
    expect(serialized).toContain('https://example.com/docs/path?q=1')
    expect(serialized).toContain('\\\\d+\\\\w+')
    expect(serialized).toContain('<isolated-audit-root>/already-safe')
  })

  it.each([
    ['leading-punctuation POSIX', 'location: "/[Privacy Canary]/private/secret-evidence.json"'],
    ['leading-punctuation home', 'location: 【~/{Privacy Canary}/private/secret-evidence.json】'],
    ['leading-punctuation Windows', String.raw`location: C:\!Privacy Canary\private\secret-evidence.json`],
    ['UNC', String.raw`location: \\privacy-server\private-share\Privacy Canary\secret-evidence.json`],
    ['file URL', 'location: file:///Users/Privacy%20Canary/private/secret-evidence.json'],
    ['single-slash drive', 'location: C:/Users/Privacy Canary/private/secret-evidence.json'],
    ['double-slash drive', 'location: C://Users/Privacy Canary/private/secret-evidence.json'],
  ])('redacts embedded %s with the durable v10 path grammar', (_label, diagnostic) => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: false, diagnostic } })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    expect(serialized).toContain('<local-path>')
    expect(serialized).not.toContain('Privacy Canary')
    expect(serialized).not.toContain('Privacy%20Canary')
    expect(serialized).not.toContain('secret-evidence.json')
  })

  it('preserves URL, protocol-relative, regex and marker negatives while continuing after URL whitespace', () => {
    const value = fixture()
    const report = {
      ok: false,
      messages: [
        'public: https://example.com/docs/path?q=1',
        'custom: custom+scheme://example.test/[public],;path',
        'network: //cdn.example.com/public/path',
        String.raw`regex: \\d+\\w+ and \\p{L}+\\s+`,
        'marker: <isolated-audit-root>/already-safe',
        'continued: https://example.com/docs then /Users/Privacy Canary/private/secret-after-url.json',
        'userinfo: https://alice:hunter2@example.com/private',
        'query: https://example.com/docs?next=/Users/public&target=C:/Users/public',
        'fragment: https://example.com/docs#/Users/public/config.json',
      ],
    }
    writeAgentIntegrationUiE2eEvidence({ ...value, report })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    for (const safe of [
      'https://example.com/docs/path?q=1',
      'custom+scheme://example.test/[public],;path',
      '//cdn.example.com/public/path',
      '<isolated-audit-root>/already-safe',
    ]) expect(serialized).toContain(safe)
    expect((JSON.parse(serialized) as { messages: string[] }).messages[3]).toBe(report.messages[3])
    expect(serialized).toContain('https://example.com/docs then <local-path>')
    expect(serialized).toContain('https://<redacted-credential>@example.com/private')
    expect(serialized).not.toContain('Privacy Canary')
    expect(serialized).not.toContain('hunter2')
  })

  it.each([
    ['semicolon', 'url=https://example.com/docs;path=/Users/Privacy Canary/semicolon.json'],
    ['comma', 'url=https://example.com/docs,target=/private/tmp/Privacy Canary/comma.json'],
    ['pipe', String.raw`url=https://example.com/docs|target=C:\Users\Privacy Canary\pipe.json`],
    ['arrow', 'url=https://example.com/docs→target=/Users/Privacy Canary/arrow.json'],
    ['custom scheme', 'url=custom+scheme://example.test/docs=>target=~/Privacy Canary/custom.json'],
  ])('redacts a %s diagnostic path assignment with no whitespace after a URL', (_label, diagnostic) => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: false, diagnostic } })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    expect(serialized).toContain('<local-path>')
    expect(serialized).not.toContain('Privacy Canary')
    expect(serialized).not.toMatch(/semicolon\.json|comma\.json|pipe\.json|arrow\.json|custom\.json/u)
  })

  it.each(PATH_V13_FIXTURE.unsafe)(
    'redacts the complete v13 $name token using the shared privacy contract',
    ({ input, forbidden }) => {
      const value = fixture()
      writeAgentIntegrationUiE2eEvidence({
        ...value,
        report: { ok: false, diagnostic: `diagnostic: ${input}` },
      })
      const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
      expect(serialized).toContain('<local-path>')
      for (const canary of forbidden) expect(serialized).not.toContain(canary)
    },
  )

  it.each(PATH_V13_FIXTURE.safe)(
    'preserves the v13 $name negative using the shared privacy contract',
    ({ input }) => {
      const value = fixture()
      writeAgentIntegrationUiE2eEvidence({
        ...value,
        report: { ok: false, diagnostic: `diagnostic: ${input}` },
      })
      const report = JSON.parse(fs.readFileSync(
        path.join(value.evidenceDir, 'ui-e2e-report.json'),
        'utf8',
      )) as { diagnostic: string }
      expect(report.diagnostic).toBe(`diagnostic: ${input}`)
    },
  )

  it('replaces path-bearing object keys deterministically without dropping colliding private classes', () => {
    const value = fixture()
    const exactRoot = value.auditRoot
    const contained = path.join(value.auditRoot, 'home', 'Private Key One', 'secret.json')
    const sibling = `${value.auditRoot}-sibling/Private Key Two/secret.json`
    const outside = path.join(value.parent, 'Privacy Key Three', 'secret.json')
    const windows = String.raw`C:\Users\Privacy Key Four\secret.json`
    const dynamicKeys = [exactRoot, contained, sibling, outside, windows]
    writeAgentIntegrationUiE2eEvidence({
      ...value,
      report: {
        ok: false,
        diagnostics: Object.fromEntries(dynamicKeys.map((key, index) => [key, `value-${index}`])),
      },
    })

    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    const report = JSON.parse(serialized) as {
      ok: boolean
      diagnostics: Record<string, string>
    }
    expect(report.ok).toBe(false)
    expect(Object.keys(report.diagnostics)).toHaveLength(dynamicKeys.length)
    expect(Object.keys(report.diagnostics).every(
      key => /^_redacted_key_sha256_[a-f0-9]{64}$/u.test(key),
    )).toBe(true)
    expect(Object.values(report.diagnostics).sort()).toEqual(dynamicKeys.map((_key, index) => `value-${index}`))
    for (const canary of [value.auditRoot, 'Private Key One', 'Private Key Two', 'Privacy Key Three', 'Privacy Key Four']) {
      expect(serialized).not.toContain(canary)
    }
  })

  it('leaves the fixed final-producer object keys unchanged', () => {
    const value = fixture()
    const report = {
      ok: true,
      uiAssertions: { initialScan: { exactGeneration: true } },
      verification: { mutationCount: 2 },
    }
    writeAgentIntegrationUiE2eEvidence({ ...value, report })
    expect(JSON.parse(fs.readFileSync(
      path.join(value.evidenceDir, 'ui-e2e-report.json'),
      'utf8',
    ))).toMatchObject(report)
  })

  it('fails closed when a redacted dynamic key would collide with an existing literal key', () => {
    const value = fixture()
    const sensitiveKey = path.join(value.auditRoot, 'Private Collision Key', 'secret.json')
    const placeholder = `_redacted_key_sha256_${crypto.createHash('sha256')
      .update(sensitiveKey)
      .digest('hex')}`
    expect(() => writeAgentIntegrationUiE2eEvidence({
      ...value,
      report: {
        diagnostics: {
          [placeholder]: 'public-literal',
          [sensitiveKey]: 'private-value',
        },
      },
    })).toThrow(/object-key redaction collision/u)
    expect(fs.existsSync(value.evidenceDir)).toBe(false)
  })

  it('replaces only canonical audit-root-contained absolute tokens and rejects marker lookalikes', () => {
    const value = fixture()
    const unicodeDir = path.join(value.auditRoot, 'Private Space', '隐私目录')
    fs.mkdirSync(unicodeDir, { recursive: true })
    const contained = path.join(unicodeDir, 'secret.json')
    const sibling = `${value.auditRoot}-sibling`
    const fakeMarkerPath = path.join(value.parent, '<isolated-audit-root>', 'secret.json')
    writeAgentIntegrationUiE2eEvidence({
      ...value,
      report: {
        diagnostic: `inside="${contained}"; sibling="${sibling}/secret.json"; fake="${fakeMarkerPath}"; marker=<isolated-audit-root>/already-safe`,
      },
    })
    const serialized = fs.readFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'utf8')
    expect(serialized).toContain('<isolated-audit-root>/Private Space/隐私目录/secret.json')
    expect(serialized).toContain('marker=<isolated-audit-root>/already-safe')
    expect(serialized.match(/<local-path>/gu)).toHaveLength(2)
    expect(serialized).not.toContain(`${path.basename(value.auditRoot)}-sibling`)
    expect(serialized).not.toContain(`${path.sep}<isolated-audit-root>${path.sep}secret.json`)
  })

  it.each([
    ['missing isolation', { protocolVersion: 1, gate: 'agent-integration-electron-ui-e2e', status: 'passed', writesRealAgentConfiguration: false }],
    ['tampered isolation', { protocolVersion: 1, gate: 'agent-integration-electron-ui-e2e', status: 'passed', isolation: 'real-home', writesRealAgentConfiguration: false }],
    ['missing write boundary', { protocolVersion: 1, gate: 'agent-integration-electron-ui-e2e', status: 'passed', isolation: 'temporary-home-physical-sqlite-real-electron' }],
    ['real config write', { protocolVersion: 1, gate: 'agent-integration-electron-ui-e2e', status: 'passed', isolation: 'temporary-home-physical-sqlite-real-electron', writesRealAgentConfiguration: true }],
  ])('rejects a UI E2E receipt with %s', (_label, receipt) => {
    expect(validateAgentIntegrationUiE2eReceipt(receipt).length).toBeGreaterThan(0)
  })

  it('accepts the exact isolated UI E2E receipt contract', () => {
    expect(validateAgentIntegrationUiE2eReceipt({
      protocolVersion: 1,
      gate: 'agent-integration-electron-ui-e2e',
      status: 'passed',
      isolation: 'temporary-home-physical-sqlite-real-electron',
      writesRealAgentConfiguration: false,
    })).toEqual([])
  })

  it('refuses an absolute report path outside the audit root and removes partial evidence', () => {
    const value = fixture()
    expect(() => writeAgentIntegrationUiE2eEvidence({
      ...value,
      report: { ok: false, leakedPath: path.join(value.parent, 'outside-secret') },
    })).toThrow(/refuses an absolute path outside the audit root/)
    expect(fs.existsSync(value.evidenceDir)).toBe(false)
  })

  it('refuses to overwrite an existing evidence directory', () => {
    const value = fixture()
    fs.mkdirSync(value.evidenceDir)
    expect(() => writeAgentIntegrationUiE2eEvidence({
      ...value,
      report: { ok: true },
    })).toThrow(/already exists/)
  })

  it.each([
    ['report content drift', (value: ReturnType<typeof fixture>) => fs.appendFileSync(path.join(value.evidenceDir, 'ui-e2e-report.json'), 'drift')],
    ['same-size screenshot hash drift', (value: ReturnType<typeof fixture>) => {
      const screenshot = path.join(value.evidenceDir, 'screenshots', '01-wide.png')
      const bytes = fs.readFileSync(screenshot)
      bytes[0] ^= 0xff
      fs.writeFileSync(screenshot, bytes)
    }],
    ['file mode drift', (value: ReturnType<typeof fixture>) => fs.chmodSync(path.join(value.evidenceDir, 'screenshots', '01-wide.png'), 0o644)],
    ['extra file', (value: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(value.evidenceDir, 'extra.txt'), 'unexpected')],
  ])('rejects %s after the receipt-bound manifest was created', (_name, mutate) => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: true } })
    const expectedManifestSha256 = manifestSha256(value.evidenceDir)
    mutate(value)
    expect(() => verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256,
    })).toThrow(/evidence (?:metadata|file set)/)
  })

  it.each([
    ['manifest mode drift', (value: ReturnType<typeof fixture>) => fs.chmodSync(path.join(value.evidenceDir, 'evidence-manifest.json'), 0o644)],
    ['extra empty directory', (value: ReturnType<typeof fixture>) => fs.mkdirSync(path.join(value.evidenceDir, 'unexpected'))],
  ])('rejects %s as an unbound evidence entry', (_name, mutate) => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: true } })
    const expectedManifestSha256 = manifestSha256(value.evidenceDir)
    mutate(value)
    expect(() => verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256,
    })).toThrow(/evidence (?:manifest mode|directory set)/)
  })

  it.each([
    ['root 0755', '.', 0o755],
    ['root 0777', '.', 0o777],
    ['root other mode', '.', 0o750],
    ['screenshots 0755', 'screenshots', 0o755],
    ['screenshots 0777', 'screenshots', 0o777],
    ['screenshots other mode', 'screenshots', 0o750],
  ] as const)('rejects %s directory mode drift after manifest creation', (_name, relative, mode) => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: true } })
    const expectedManifestSha256 = manifestSha256(value.evidenceDir)
    fs.chmodSync(relative === '.' ? value.evidenceDir : path.join(value.evidenceDir, relative), mode)
    expect(() => verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256,
    })).toThrow(/evidence directory metadata mismatch/)
  })

  it('rejects a drifted manifest even when its newly described files are internally consistent', () => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: true } })
    const expectedManifestSha256 = manifestSha256(value.evidenceDir)
    const manifestPath = path.join(value.evidenceDir, 'evidence-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.note = 'post-receipt drift'
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
    expect(() => verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256,
    })).toThrow(/manifest digest mismatch/)
  })

  it('rejects symlink substitution inside retained evidence', () => {
    const value = fixture()
    writeAgentIntegrationUiE2eEvidence({ ...value, report: { ok: true } })
    const expectedManifestSha256 = manifestSha256(value.evidenceDir)
    const screenshot = path.join(value.evidenceDir, 'screenshots', '01-wide.png')
    const replacement = path.join(value.parent, 'replacement.png')
    fs.writeFileSync(replacement, Buffer.alloc(64, 1))
    fs.unlinkSync(screenshot)
    fs.symlinkSync(replacement, screenshot)
    expect(() => verifyAgentIntegrationUiE2eEvidence({
      evidenceDir: value.evidenceDir,
      expectedManifestSha256,
    })).toThrow(/refuses symlink/)
  })
})
