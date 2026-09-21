import { describe, expect, it } from 'vitest'

// @ts-expect-error local plain-ESM release helper has no declaration file
import {
  validateCandidateArchiveEntries,
  validateCandidateTransferReceipt,
} from '../../scripts/agent-host-candidate-transfer.mjs'

const sourceCommit = 'a'.repeat(40)
const receipt = {
  schemaVersion: 1,
  architecture: 'arm64',
  appVersion: '0.2.92',
  sourceCommit,
  candidateBundleSha256: 'b'.repeat(64),
  archiveSha256: 'c'.repeat(64),
  archiveBytes: 123,
  transferTag: 'agent-host-candidate-v0.2.92-aaaaaaaaaaaa',
  assetName: 'Tide.Mind-0.2.92-arm64-aaaaaaaaaaaa.zip',
  appBundleName: 'Tide Mind.app',
}

describe('Agent host candidate transfer contract', () => {
  it('binds the private archive to source, version and physical app hash', () => {
    expect(validateCandidateTransferReceipt(receipt, { architecture: 'arm64', appVersion: '0.2.92', sourceCommit }))
      .toEqual(receipt)
    expect(() => validateCandidateTransferReceipt(receipt, {
      architecture: 'arm64', appVersion: '0.2.92', sourceCommit: 'd'.repeat(40),
    })).toThrow(/sourceCommit does not match/)
    expect(() => validateCandidateTransferReceipt(receipt, {
      architecture: 'x64', appVersion: '0.2.92', sourceCommit,
    })).toThrow(/architecture does not match/)
    expect(() => validateCandidateTransferReceipt({ ...receipt, archiveSha256: '0'.repeat(64) }, {
      architecture: 'arm64', appVersion: '0.2.92', sourceCommit,
    })).not.toThrow()
    expect(() => validateCandidateTransferReceipt({ ...receipt, archiveSha256: 'short' }, {
      architecture: 'arm64', appVersion: '0.2.92', sourceCommit,
    })).toThrow(/archiveSha256 is invalid/)
  })

  it('rejects absolute, traversal and sibling archive entries', () => {
    expect(() => validateCandidateArchiveEntries([
      'Tide Mind.app/',
      'Tide Mind.app/Contents/Info.plist',
    ])).not.toThrow()
    for (const unsafe of [
      '/tmp/escape',
      '../escape',
      'Tide Mind.app/../../escape',
      'Other.app/Contents/Info.plist',
    ]) {
      expect(() => validateCandidateArchiveEntries([unsafe])).toThrow(/unsafe|escapes/)
    }
  })

  it('rejects receipt fields that are not part of the frozen contract', () => {
    expect(() => validateCandidateTransferReceipt({ ...receipt, repositoryPath: '/tmp/app' }, {
      architecture: 'arm64', appVersion: '0.2.92', sourceCommit,
    })).toThrow(/shape is invalid/)
  })
})
