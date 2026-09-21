import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readReleaseWorkflow } from '../helpers/release-workflow'
// @ts-expect-error plain ESM release verifier
import { assertAcceptedReleaseCandidate, verifyAcceptedReleaseArtifacts } from '../../scripts/verify-agent-host-release-artifacts.mjs'

const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const sourceCommit = '1'.repeat(40)
const appVersion = '0.2.92'
const candidate = {
  version: appVersion, sourceCommit, bundleSha256: hash('accepted app A'), executableSha256: hash('executable A'),
  teamId: 'Z4U232GXH5', signingIdentity: 'Developer ID Application: Tide Mind (Z4U232GXH5)', cdhash: '2'.repeat(40),
}
const index = { evidenceClass: 'real_host', appVersion, sourceCommit,
  candidateAppsByArchitecture: { arm64: candidate, x64: { ...candidate, bundleSha256: hash('accepted x64 app') } },
}
const artifacts = { dmg: Buffer.from('DMG wrapping A'), zip: Buffer.from('ZIP wrapping A') }
const receipt = {
  schemaVersion: 1, sourceCommit, appVersion, architecture: 'arm64', candidateBundleSha256: candidate.bundleSha256,
  executableSha256: candidate.executableSha256, teamId: candidate.teamId, signingIdentity: candidate.signingIdentity,
  cdhash: candidate.cdhash, dmgSha256: hash(artifacts.dmg), zipSha256: hash(artifacts.zip), verifiedAt: '2026-09-05T00:00:00Z',
}
const input = { index, receipt, architecture: 'arm64', appVersion, sourceCommit,
  readArtifact: (extension: 'dmg' | 'zip') => artifacts[extension],
}

describe('accepted candidate release artifacts', () => {
  it('accepts the arm64-only release through the CLI and rejects missing arm64 evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-arm64-release-'))
    try {
      fs.mkdirSync(path.join(directory, 'provenance'))
      const indexPath = path.join(directory, 'index.json')
      fs.writeFileSync(indexPath, JSON.stringify({ ...index, candidateAppsByArchitecture: { arm64: candidate } }))
      const receiptPath = path.join(directory, 'provenance', 'mac-arm64.json')
      fs.writeFileSync(receiptPath, JSON.stringify(receipt))
      for (const extension of ['dmg', 'zip'] as const) {
        fs.writeFileSync(path.join(directory, `Tide.Mind-${appVersion}-arm64.${extension}`), artifacts[extension])
      }
      const args = ['scripts/verify-agent-host-release-artifacts.mjs', '--release-dir', directory,
        '--acceptance-index', indexPath, '--app-version', appVersion, '--source-commit', sourceCommit]
      expect(execFileSync(process.execPath, args, { encoding: 'utf8' })).toContain('verified arm64 release artifacts')
      fs.writeFileSync(indexPath, JSON.stringify({ ...index, candidateAppsByArchitecture: {} }))
      expect(() => execFileSync(process.execPath, args, { stdio: 'pipe' })).toThrow(/no matching real-host acceptance/)
      fs.writeFileSync(indexPath, JSON.stringify({ ...index, candidateAppsByArchitecture: { arm64: candidate } }))
      fs.unlinkSync(receiptPath)
      expect(() => execFileSync(process.execPath, args, { stdio: 'pipe' })).toThrow(/mac-arm64.json/)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts only the accepted candidate and the exact verified container bytes', () => {
    expect(() => verifyAcceptedReleaseArtifacts(input)).not.toThrow()
    expect(() => verifyAcceptedReleaseArtifacts({ ...input,
      readArtifact: () => Buffer.from('changed container'),
    })).toThrow(/receipt mismatch/)
  })

  it('rejects rebuilt app B even when its identity and self-generated container hashes are valid', () => {
    const readArtifact = () => Buffer.from('new, correctly signed container B')
    const replacement = { ...receipt, candidateBundleSha256: hash('app B'),
      dmgSha256: hash(readArtifact()), zipSha256: hash(readArtifact()),
    }
    expect(() => verifyAcceptedReleaseArtifacts({ ...input, receipt: replacement, readArtifact }))
      .toThrow(/bundleSha256 differs from accepted app/)
    expect(() => assertAcceptedReleaseCandidate(index, { ...candidate, bundleSha256: hash('app B') }, 'arm64', appVersion, sourceCommit))
      .toThrow(/differs from accepted app/)
  })

  it('rejects receipt reuse across architecture, source, and acceptance classes', () => {
    expect(() => verifyAcceptedReleaseArtifacts({ ...input, architecture: 'x64' })).toThrow(/invalid/)
    expect(() => verifyAcceptedReleaseArtifacts({ ...input, sourceCommit: '3'.repeat(40) })).toThrow(/invalid/)
    expect(() => verifyAcceptedReleaseArtifacts({
      ...input,
      receipt: { ...receipt, verificationClass: 'private_rc_candidate' },
    })).toThrow(/invalid accepted release receipt/)
    expect(() => verifyAcceptedReleaseArtifacts({ ...input, index: { ...index, evidenceClass: 'fixture' } }))
      .toThrow(/no matching real-host acceptance/)
  })

  it('promotes the accepted app and checks both extracted containers before writing a receipt', () => {
    const workflow = readReleaseWorkflow(path.resolve('.'))
    expect(workflow).toContain('--prepackaged "$TIDEMIND_ACCEPTED_APP"')
    expect(workflow).toContain('verify-agent-host-release-artifacts.mjs')
    expect(workflow).toContain('--app "$TIDEMIND_ACCEPTED_APP"')
    const verifier = fs.readFileSync('scripts/verify-mac-release-assets.mjs', 'utf8')
    const receiptWrite = verifier.indexOf('fs.writeFileSync(resolvedReceipt')
    for (const check of ['assertAcceptedReleaseCandidate(acceptanceIndex, dmgCandidate', 'assertAcceptedReleaseCandidate(acceptanceIndex, zipCandidate']) {
      expect(verifier.indexOf(check)).toBeGreaterThan(0)
      expect(verifier.indexOf(check)).toBeLessThan(receiptWrite)
    }
  })
})
