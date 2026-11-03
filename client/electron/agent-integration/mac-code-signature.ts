import { execFile, spawnSync } from 'node:child_process'
import type { AppCodeSignatureResult } from './discovery.js'
import { sha256Json } from './fingerprint.js'

export type CodesignRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>

export type CodesignSyncRunner = (
  args: readonly string[],
  timeoutMs: number,
) => { stdout: string; stderr: string }

export const DESKTOP_SIGNATURE_VERIFY_TIMEOUT_MS = 60_000

/** A denied check that could not finish, not evidence of changed source bytes. */
export class DesktopSourceVerificationUnavailable extends Error {
  readonly code = 'DESKTOP_SOURCE_CHECK_UNAVAILABLE'
  constructor(readonly reason: 'timeout' | 'terminated' | 'unavailable') {
    super(`Desktop source verification is temporarily unavailable; check again later (${reason})`)
    this.name = 'DesktopSourceVerificationUnavailable'
  }
}

export function desktopSourceVerificationUnavailable(error: unknown): DesktopSourceVerificationUnavailable | null {
  if(error instanceof DesktopSourceVerificationUnavailable)return error
  const value=error as {name?:unknown;code?:unknown;killed?:unknown;signal?:unknown}|null
  if(value?.name==='DiscoveryTimeoutError'||value?.code==='ETIMEDOUT')return new DesktopSourceVerificationUnavailable('timeout')
  if(value?.killed===true||typeof value?.signal==='string')return new DesktopSourceVerificationUnavailable('terminated')
  if(['EACCES','EPERM','EBUSY','EAGAIN','EMFILE','ENFILE','ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(String(value?.code)))return new DesktopSourceVerificationUnavailable('unavailable')
  return null
}

/** Desktop only: one verified snapshot, not a final synchronous resource boundary. */
export async function inspectMacDesktopSignatureSnapshot(
  appBundleRealpath: string,
  options: { readTimeoutMs: number },
  codesign: CodesignRunner = runCodesign,
): Promise<AppCodeSignatureResult> {
  try {
    const before=await readMacAppSignatureReceipt(appBundleRealpath,options.readTimeoutMs,codesign)
    await codesign(['--verify','--deep','--strict',appBundleRealpath],DESKTOP_SIGNATURE_VERIFY_TIMEOUT_MS)
    const after=await readMacAppSignatureReceipt(appBundleRealpath,options.readTimeoutMs,codesign)
    if(before.identifier!==after.identifier||before.teamIdentifier!==after.teamIdentifier
      ||desktopSignatureReceiptFingerprint(before)!==desktopSignatureReceiptFingerprint(after)) {
      throw new Error('desktop_signature_receipt_changed_during_verification')
    }
    return {valid:true,...after,verificationBoundary:'desktop_snapshot'}
  }catch(error){
    const unavailable=desktopSourceVerificationUnavailable(error)
    if(unavailable)throw unavailable
    // ENOENT here is failure to execute the platform verifier, not a missing
    // bundle: codesign reports an absent target with its ordinary exit status.
    if((error as {code?:unknown}|null)?.code==='ENOENT')throw new DesktopSourceVerificationUnavailable('unavailable')
    throw error
  }
}

export async function inspectMacAppSignature(
  appBundleRealpath: string,
  options: { timeoutMs: number; beforeFinalVerification?: () => Promise<void> },
  codesign: CodesignRunner = runCodesign,
): Promise<AppCodeSignatureResult> {
  const before = await readMacAppSignatureReceipt(appBundleRealpath, options.timeoutMs, codesign)
  await codesign(['--verify', '--deep', '--strict', appBundleRealpath], options.timeoutMs)
  const after = await readMacAppSignatureReceipt(appBundleRealpath, options.timeoutMs, codesign)
  if (desktopSignatureReceiptFingerprint(before) !== desktopSignatureReceiptFingerprint(after)) {
    throw new Error('desktop_signature_receipt_changed_during_verification')
  }
  await options.beforeFinalVerification?.()
  // This must remain the last codesign operation on the successful async path.
  await codesign(['--verify', '--deep', '--strict', appBundleRealpath], options.timeoutMs)
  return { valid: true, ...after, verificationBoundary: 'strict_final' }
}

export function inspectMacAppSignatureSync(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignSyncRunner = runCodesignSync,
): AppCodeSignatureResult {
  const before = readMacAppSignatureReceiptSync(appBundleRealpath, timeoutMs, codesign)
  codesign(['--verify', '--deep', '--strict', appBundleRealpath], timeoutMs)
  const after = readMacAppSignatureReceiptSync(appBundleRealpath, timeoutMs, codesign)
  if (desktopSignatureReceiptFingerprint(before) !== desktopSignatureReceiptFingerprint(after)) {
    throw new Error('desktop_signature_receipt_changed_during_final_verification')
  }
  // This must remain the last codesign operation on the successful sync path.
  codesign(['--verify', '--deep', '--strict', appBundleRealpath], timeoutMs)
  return { valid: true, ...after, verificationBoundary: 'strict_final' }
}

export function desktopSignatureReceiptFingerprint(signature: {
  cdHash?: string
  designatedRequirement?: string
}): string | null {
  const cdHash = signature.cdHash?.trim().toLowerCase()
  const designatedRequirement = signature.designatedRequirement?.trim()
  if (!cdHash || !/^[a-f0-9]{20,128}$/u.test(cdHash)
    || !designatedRequirement || designatedRequirement.length > 8 * 1024) return null
  return sha256Json({ cdHash, designatedRequirement })
}

async function readMacAppSignatureReceipt(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignRunner,
): Promise<{
  identifier?: string
  teamIdentifier?: string
  cdHash?: string
  designatedRequirement?: string
}> {
  const details = await codesign(['-dv', '--verbose=4', appBundleRealpath], timeoutMs)
  const output = `${details.stdout}\n${details.stderr}`
  const requirements = await codesign(['-d', '-r-', appBundleRealpath], timeoutMs)
  const requirementOutput = `${requirements.stdout}\n${requirements.stderr}`
  return {
    identifier: output.match(/^Identifier=(.+)$/mu)?.[1]?.trim(),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim(),
    cdHash: output.match(/^CDHash=([A-Fa-f0-9]+)$/mu)?.[1]?.toLowerCase(),
    designatedRequirement: requirementOutput.match(/^designated => (.+)$/mu)?.[1]?.trim(),
  }
}

function readMacAppSignatureReceiptSync(
  appBundleRealpath: string,
  timeoutMs: number,
  codesign: CodesignSyncRunner,
): {
  identifier?: string
  teamIdentifier?: string
  cdHash?: string
  designatedRequirement?: string
} {
  const details = codesign(['-dv', '--verbose=4', appBundleRealpath], timeoutMs)
  const output = `${details.stdout}\n${details.stderr}`
  const requirements = codesign(['-d', '-r-', appBundleRealpath], timeoutMs)
  const requirementOutput = `${requirements.stdout}\n${requirements.stderr}`
  return {
    identifier: output.match(/^Identifier=(.+)$/mu)?.[1]?.trim(),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim(),
    cdHash: output.match(/^CDHash=([A-Fa-f0-9]+)$/mu)?.[1]?.toLowerCase(),
    designatedRequirement: requirementOutput.match(/^designated => (.+)$/mu)?.[1]?.trim(),
  }
}

function runCodesign(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/codesign', [...args], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

function runCodesignSync(
  args: readonly string[],
  timeoutMs: number,
): { stdout: string; stderr: string } {
  const result = spawnSync('/usr/bin/codesign', [...args], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign failed with status ${result.status ?? 'unknown'}: ${result.stderr}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
