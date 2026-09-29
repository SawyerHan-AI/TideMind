import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parse, stringify } from 'smol-toml'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const within = (root, file) => file.startsWith(root + path.sep)
function safeFile(file, home) {
  if (path.resolve(file).split(path.sep).some(segment => segment.endsWith('.app'))) throw new Error('CAS must not touch a signed App bundle')
  if (!within(home, path.resolve(file)) || fs.realpathSync(file) !== path.resolve(file)) throw new Error('CAS target is not canonical inside isolated HOME')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('CAS target is not a bounded regular file')
}
export function changeOwnedCodexTable(bytes, selector, agentId, nonce) {
  if (selector !== 'mcp_servers.tidemind-' + agentId) throw new Error('CAS selector does not identify the actual Agent table')
  const config = parse(bytes.toString('utf8')), key = 'tidemind-' + agentId, entry = config.mcp_servers?.[key]
  if (!entry || typeof entry !== 'object' || entry.env?.EB_AGENT_ID !== agentId) throw new Error('CAS owned table does not contain actual Agent identity')
  if (entry.env.TIDEMIND_CAS_OBSERVATION !== undefined) throw new Error('CAS observation key already exists')
  entry.env.TIDEMIND_CAS_OBSERVATION = nonce
  const result = Buffer.from(stringify(config))
  if (parse(result.toString('utf8')).mcp_servers[key].env.TIDEMIND_CAS_OBSERVATION !== nonce) throw new Error('CAS TOML transformation failed')
  return result
}
export function changeGeneratedZipComment(bytes, nonce) {
  let eocd = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { eocd = index; break }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) throw new Error('CAS archive is not a supported single-disk ZIP')
  if (bytes.readUInt32LE(eocd + 12) + bytes.readUInt32LE(eocd + 16) !== eocd) throw new Error('CAS archive central directory does not end at EOCD')
  const comment = Buffer.concat([bytes.subarray(eocd + 22), Buffer.from('\nTideMind no-auth CAS ' + nonce)])
  if (comment.length > 65535) throw new Error('CAS ZIP comment exceeds format bound')
  const header = Buffer.from(bytes.subarray(0, eocd + 22))
  header.writeUInt16LE(comment.length, eocd + 20)
  return Buffer.concat([header, comment])
}
export function replaceFileIfHash(file, expectedHash, bytes, home) {
  safeFile(file, home)
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd), current = fs.lstatSync(file)
    if (!before.isFile() || before.ino !== current.ino || before.dev !== current.dev || before.size > 8 * 1024 * 1024) throw new Error('CAS target changed while opening')
    const previous = Buffer.alloc(before.size)
    let read = 0
    while (read < previous.length) { const count = fs.readSync(fd, previous, read, previous.length - read, read); if (!count) throw new Error('CAS short read'); read += count }
    if (hash(previous) !== expectedHash) throw new Error('CAS hash precondition mismatch; external bytes preserved')
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset)
    fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  safeFile(file, home)
  if (hash(fs.readFileSync(file)) !== hash(bytes)) throw new Error('CAS write readback mismatch')
}
export async function observeOwnedCas({ catalogId, home, detail, preview, nonce, output, submit, record, signal, deferRestore }) {
  const agentId = detail.technical?.agentId
  if (typeof agentId !== 'string' || detail.installation?.desiredState !== 'managed') throw new Error('CAS requires a real managed Agent')
  const selector = catalogId === 'codex-desktop' ? 'mcp_servers.tidemind-' + agentId : catalogId === 'claude-cowork-local' ? 'claude-cowork-plugin:' + agentId : null
  if (!selector) throw new Error('no reviewed owned CAS recipe for target')
  const component = detail.technical.components.find(item => item.ownershipSelector === selector && item.ownedHash)
  if (!component?.targetLabel?.startsWith('~/')) throw new Error('CAS has no owned task-HOME target descriptor')
  const target = path.resolve(home, component.targetLabel.slice(2))
  if (!preview.installations.some(item => item.installationId === detail.installation.id && (item.targets.some(value => value.targetLabel === component.targetLabel) || (item.requiredUserActionDetails ?? []).some(action => action.kind === 'manual_file_removal' && action.physicalTargetLabel === component.targetLabel && action.ownedFragmentHash === component.ownedHash)))) throw new Error('CAS target absent from real disconnect plan')
  safeFile(target, home)
  const original = fs.readFileSync(target), originalHash = hash(original)
  const zip = catalogId === 'claude-cowork-local'
  if (zip && component.ownedHash !== originalHash) throw new Error('Cowork CAS archive already differs from ownership baseline')
  if (zip && !target.endsWith('.plugin')) throw new Error('Cowork CAS is restricted to generated .plugin archives')
  if (zip) execFileSync('/usr/bin/unzip', ['-tqq', target], { timeout: 10000, stdio: 'pipe' })
  const modified = zip ? changeGeneratedZipComment(original, nonce) : changeOwnedCodexTable(original, selector, agentId, nonce), modifiedHash = hash(modified)
  const backupFd = fs.openSync(path.join(output, 'cas-original.bin'), 'wx', 0o600)
  try { fs.writeFileSync(backupFd, original); fs.fsyncSync(backupFd) } finally { fs.closeSync(backupFd) }
  record('owned_cas_precondition', { target, selector, originalHash, modifiedHash, field: zip ? 'ZIP EOCD comment; entry bytes unchanged' : 'owned MCP table env.TIDEMIND_CAS_OBSERVATION', planHash: preview.planHash, backupFile: 'cas-original.bin' })
  let changed = false, rejection, submitted = false, settled = false
  try {
    if (signal.aborted) throw new Error('CAS cancelled before mutation')
    replaceFileIfHash(target, originalHash, modified, home); changed = true
    if (zip) execFileSync('/usr/bin/unzip', ['-tqq', target], { timeout: 10000, stdio: 'pipe' })
    if (signal.aborted) throw new Error('CAS cancelled before submission')
    try { submitted = true; const value = await submit(preview.planHash, detail.installation.id); settled = true; rejection = { kind: 'response', value }; if (value?.planHash !== preview.planHash || !Array.isArray(value.results) || value.results.length !== 1 || value.results[0].installationId !== detail.installation.id || !['failed','superseded','needs_recovery'].includes(value.results[0].status)) throw new Error('CAS old plan did not reject owned change') }
    catch (error) { if (error.message === 'CAS old plan did not reject owned change' || !/precondition|conflict|stale|expired|hash.*mismatch|plan.*changed|changed.*plan/iu.test(error.message)) throw error; settled = true; rejection = { kind: 'exception', message: error.message } }
    safeFile(target, home)
    const afterHash = hash(fs.readFileSync(target))
    record('owned_cas_submission', { submitted, rejection, afterHash, modifiedHash, acceptanceStatus: 'not_evaluated' })
    if (afterHash !== modifiedHash) throw new Error('CAS submission changed the external modification')
  } finally {
    if (changed) {
      const restore = () => {
        // Never overwrite a third-party write made after our controlled mutation.
        try { replaceFileIfHash(target, modifiedHash, original, home); record('owned_cas_restored', { restoredHash: hash(fs.readFileSync(target)), originalHash }) }
        catch (error) { record('owned_cas_restore_refused', { message: error.message, backupFile: 'cas-original.bin' }); throw error }
      }
      if (submitted && !settled) {
        record('owned_cas_restore_deferred', { reason: 'submission outcome unknown; restore only after the candidate process group exits', backupFile: 'cas-original.bin' })
        deferRestore?.(restore)
      } else restore()
    }
  }
}
