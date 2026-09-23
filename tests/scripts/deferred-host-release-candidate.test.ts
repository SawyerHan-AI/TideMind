import { describe, expect, it } from 'vitest'
import {
  validateDeferredCandidateVerification,
  validateDeferredHostReleaseWaiver,
  validateDeferredUploadReceipt,
} from '../../scripts/verify-deferred-host-release-candidate.mjs'

const sourceCommit = 'e57c7589c2b77d9fa3a8cab0cc47e4f4a1b33447'
const waiver = {
  schemaVersion: 1,
  kind: 'deferred_real_host_acceptance',
  appVersion: '0.2.92',
  sourceCommit,
  candidatePublicCommit: '18dbab8f7dbd144f052571f5d20ab44438dfab77',
  candidateRunId: '35841255325',
  candidateRunAttempt: '1',
  artifactId: '10741682400',
  artifactDigest: '98e5da69bcc131ba39231127a8b683ff89fc54980a0347f9d5ed19fad689773f',
  uploadReceiptArtifactId: '10741193722',
  uploadReceiptArtifactDigest: 'cfe1d3bbb2fbeae5e6c89d0e73ae696862ebfa5967b977ddcaf19f5d020628ae',
  candidateBundleSha256: 'dcfe40b643e288b2dd4f43564a863c8d5e19bbd031f7d0916069be9bd01f47d8',
  executableSha256: '76441162132e9e3ef34fc96e3bb2efd55bef005728229a0f683bc5df0b4649d9',
  teamId: 'Z4U232GXH5',
  cdhash: '5d82f683add78d7d640ee702d7b0a217dbcb60e1',
  dmgSha256: '186516c5efc2a446dee748f1dbf39b2bea5271ec82572351e4e7c811b7bf1e6d',
  zipSha256: 'e221b4cff7834ecaa358ad84ec497988b3ae28674517e8662b3c89f216165307',
  acceptanceStatus: 'not_performed',
  decision: 'User directed publication without real-host acceptance. This record is not real-host evidence.',
}

function uploadReceipt() {
  return {
    schemaVersion: 1,
    purpose: 'mac_rc_upload',
    sourceCommit,
    publicCommit: waiver.candidatePublicCommit,
    appVersion: '0.2.92',
    architecture: 'arm64',
    repository: 'SawyerHan-AI/TideMind',
    runId: waiver.candidateRunId,
    runAttempt: waiver.candidateRunAttempt,
    artifactId: waiver.artifactId,
    artifactUrl: `https://github.com/SawyerHan-AI/TideMind/actions/runs/${waiver.candidateRunId}/artifacts/${waiver.artifactId}`,
    artifactDigest: waiver.artifactDigest,
  }
}

function candidateVerification() {
  return {
    schemaVersion: 1,
    verificationClass: 'private_rc_candidate',
    sourceCommit,
    appVersion: '0.2.92',
    architecture: 'arm64',
    candidateBundleSha256: waiver.candidateBundleSha256,
    executableSha256: waiver.executableSha256,
    teamId: waiver.teamId,
    signingIdentity: 'Developer ID Application: sawyer han (Z4U232GXH5)',
    cdhash: waiver.cdhash,
    dmgSha256: waiver.dmgSha256,
    zipSha256: waiver.zipSha256,
    verifiedAt: '2026-09-23T09:23:22.443Z',
  }
}

describe('0.2.92 deferred host acceptance release boundary', () => {
  it('requires an explicit not-performed waiver bound to the source commit', () => {
    expect(validateDeferredHostReleaseWaiver(waiver, sourceCommit)).toEqual(waiver)
    expect(() => validateDeferredHostReleaseWaiver({ ...waiver, acceptanceStatus: 'passed' }, sourceCommit))
      .toThrow('waiver acceptance status mismatch')
    expect(() => validateDeferredHostReleaseWaiver(waiver, 'f'.repeat(40))).toThrow('source commit mismatch')
    expect(() => validateDeferredHostReleaseWaiver({ ...waiver, secret: 'extra' }, sourceCommit))
      .toThrow('shape is invalid')
  })

  it('rejects a candidate artifact from another run, attempt or digest', () => {
    expect(() => validateDeferredUploadReceipt(uploadReceipt(), waiver)).not.toThrow()
    expect(() => validateDeferredUploadReceipt({ ...uploadReceipt(), runAttempt: '2' }, waiver))
      .toThrow('runAttempt mismatch')
    expect(() => validateDeferredUploadReceipt({ ...uploadReceipt(), artifactDigest: '0'.repeat(64) }, waiver))
      .toThrow('artifactDigest mismatch')
  })

  it('rejects a different signed physical App or distribution container', () => {
    expect(() => validateDeferredCandidateVerification(candidateVerification(), waiver)).not.toThrow()
    expect(() => validateDeferredCandidateVerification({ ...candidateVerification(), candidateBundleSha256: '0'.repeat(64) }, waiver))
      .toThrow('candidateBundleSha256 mismatch')
    expect(() => validateDeferredCandidateVerification({ ...candidateVerification(), zipSha256: '0'.repeat(64) }, waiver))
      .toThrow('zipSha256 mismatch')
    expect(() => validateDeferredCandidateVerification({ ...candidateVerification(), signingIdentity: 'Developer ID Application: other (OTHER)' }, waiver))
      .toThrow('signing identity is invalid')
  })
})
