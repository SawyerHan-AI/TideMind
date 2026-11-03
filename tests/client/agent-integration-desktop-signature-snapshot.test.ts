import { describe, expect, it, vi } from 'vitest'
import { inspectMacAppSignature, inspectMacDesktopSignatureSnapshot } from '../../client/electron/agent-integration/mac-code-signature'
import { signedCodePortableArtifactFingerprint, desktopSnapshotPortableArtifactFingerprint } from '../../client/electron/agent-integration/discovery'

function runnerFor(options: { changedReceipt?: boolean; failure?: Error } = {}) {
  let reads=0
  return vi.fn(async (args: readonly string[], _timeoutMs: number) => {
    if(args.includes('--verbose=4')){
      reads++
      return {stdout:'',stderr:`Identifier=dev.zcode.app\nTeamIdentifier=8A5X4JJ39T\nCDHash=${reads>1&&options.changedReceipt?'b':'a'}${'a'.repeat(39)}\n`}
    }
    if(args.includes('-r-'))return {stdout:'',stderr:'designated => identifier "dev.zcode.app" and anchor apple generic\n'}
    if(options.failure)throw options.failure
    return {stdout:'',stderr:''}
  })
}

describe('Desktop signed snapshot boundary',()=>{
  it('keeps the old strict helper and signed CLI digest contract unchanged',async()=>{
    const run=runnerFor()
    const strict=await inspectMacAppSignature('/tmp/official-cli',{timeoutMs:20000},run)
    expect(strict.verificationBoundary).toBe('strict_final')
    expect(run.mock.calls.filter(([args])=>args.includes('--verify'))).toHaveLength(2)
    const executable={sha256:'1'.repeat(64),size:128,executable:true,fingerprint:'physical'}
    const prior=signedCodePortableArtifactFingerprint({version:'1.0.0',executable,signature:strict})
    const snapshot={...strict,verificationBoundary:'desktop_snapshot' as const}
    expect(desktopSnapshotPortableArtifactFingerprint({version:'1.0.0',executable,signature:snapshot})).toBe(prior)
    expect(signedCodePortableArtifactFingerprint({version:'1.0.0',executable,signature:snapshot})).toBeUndefined()
  })

  it('rejects observable receipt changes without claiming temporary unavailability',async()=>{
    await expect(inspectMacDesktopSignatureSnapshot('/tmp/ZCode.app',{readTimeoutMs:20000},runnerFor({changedReceipt:true})))
      .rejects.toThrow('desktop_signature_receipt_changed_during_verification')
  })

  it.each([
    Object.assign(new Error('terminated'),{killed:true,signal:'SIGKILL'}),
    Object.assign(new Error('spawn unavailable'),{code:'ENOENT'}),
  ])('classifies an unavailable native verifier and never retries',async error=>{
    const run=runnerFor({failure:error})
    await expect(inspectMacDesktopSignatureSnapshot('/tmp/ZCode.app',{readTimeoutMs:20000},run))
      .rejects.toMatchObject({name:'DesktopSourceVerificationUnavailable'})
    expect(run.mock.calls.filter(([args])=>args.includes('--verify'))).toHaveLength(1)
  })

  it('preserves definite native signature rejection',async()=>{
    const error=Object.assign(new Error('code object is not signed at all'),{code:1})
    await expect(inspectMacDesktopSignatureSnapshot('/tmp/ZCode.app',{readTimeoutMs:20000},runnerFor({failure:error}))).rejects.toBe(error)
  })

  it('uses one asynchronous full verification, a 60-second native budget, and a distinct snapshot receipt',async()=>{
    const run=runnerFor()
    const result=await inspectMacDesktopSignatureSnapshot('/tmp/ZCode.app',{readTimeoutMs:20000},run)
    expect(run.mock.calls.filter(([args])=>args.includes('--verify'))).toEqual([
      [['--verify','--deep','--strict','/tmp/ZCode.app'],60000],
    ])
    expect(run.mock.calls.filter(([args])=>!args.includes('--verify')).every(([,budget])=>budget===20000)).toBe(true)
    expect(result).toMatchObject({valid:true,verificationBoundary:'desktop_snapshot'})
  })

  it('does not treat native timeout as a changed signature',async()=>{
    const run=runnerFor({failure:Object.assign(new Error('fixture timeout'),{code:'ETIMEDOUT'})})
    await expect(inspectMacDesktopSignatureSnapshot('/tmp/ZCode.app',{readTimeoutMs:20000},run))
      .rejects.toMatchObject({name:'DesktopSourceVerificationUnavailable',reason:'timeout'})
    expect(run.mock.calls.filter(([args])=>args.includes('--verify'))).toHaveLength(1)
  })
})
