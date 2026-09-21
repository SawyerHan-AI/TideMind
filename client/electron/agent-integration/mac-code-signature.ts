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
