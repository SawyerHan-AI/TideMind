import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'

const REDACTED_AUDIT_ROOT = '<isolated-audit-root>'
const REDACTED_LOCAL_PATH = '<local-path>'

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function canonicalizeExistingAncestor(candidate) {
  let current = path.resolve(candidate)
  const missing = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`UI E2E evidence path has no existing ancestor: ${candidate}`)
    missing.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

function pathBoundary(character) {
  if (character === undefined) return true
  if (character === '/' || character === '\\') return false
  if ((character.codePointAt(0) ?? 0) <= 0x7f) {
    return /[\s("'`=,:;!?@+#\]{}<>|).-]|\[/u.test(character)
  }
  return /[\p{Z}\p{P}\p{S}]/u.test(character)
}

const PATH_CLOSER_BY_OPENER = Object.freeze({
  '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '{': '}', '<': '>',
  '（': '）', '【': '】', '「': '」', '『': '』', '《': '》', '〈': '〉',
})

function diagnosticSuffixStart(value, index) {
  return /^(?:[,;]\s+|\s+(?:->|=>|→|\|)\s*)(?:[\p{L}_][\p{L}\p{N}_.-]{0,40})\s*[:=]/u.test(value.slice(index))
}

function unquotedPathTerminator(value, index) {
  return value[index] === '\0' || value[index] === '\r' || value[index] === '\n'
    || value[index] === '\t' || diagnosticSuffixStart(value, index)
}

function matchingCloserTerminates(value, index, closer) {
  if (value[index] !== closer) return false
  if (closer === '"' || closer === "'" || closer === '`') return true
  const next = value[index + 1]
  return next === undefined || next === '\0' || next === '\r' || next === '\n' || next === '\t'
    || diagnosticSuffixStart(value, index + 1)
    || /^[.!?。！？]\s*(?:$|[\r\n])/u.test(value.slice(index + 1))
}

const PUNCTUATION_PATH_SEGMENT_START = /[\][{}!?,;:'"]/u

function explicitPathContext(value, pathStart) {
  if (pathStart === 0) return true
  const previous = value[pathStart - 1]
  if (previous !== undefined
    && Object.prototype.hasOwnProperty.call(PATH_CLOSER_BY_OPENER, previous)) return true
  if (previous !== undefined
    && (previous.codePointAt(0) ?? 0) > 0x7f
    && /[\p{P}\p{S}]/u.test(previous)) return true
  return /(?:^|[\s,;|→])(?:[\p{L}_][\p{L}\p{N}_.-]{0,40})\s*[:=]\s*$/u
    .test(value.slice(Math.max(0, pathStart - 64), pathStart))
}

function validPathBodyStart(value, index, separators, allowLeadingSpace = false) {
  let bodyStart = index
  if (value[bodyStart] === ' ') {
    if (!allowLeadingSpace) return false
    while (value[bodyStart] === ' ') bodyStart += 1
  }
  const character = value[bodyStart]
  if (character === undefined || /[\s/\0]/u.test(character)) return false
  if (!PUNCTUATION_PATH_SEGMENT_START.test(character)) return true
  if (character === '?' && (value[bodyStart + 1] === undefined || /\s/u.test(value[bodyStart + 1]))) {
    return false
  }
  if (/[^\s/\\\0]/u.test(value.slice(bodyStart + 1, bodyStart + 65))) return true
  const lineEnd = value.slice(bodyStart).search(/[\0\r\n\t]/u)
  const boundedEnd = lineEnd < 0 ? value.length : bodyStart + lineEnd
  return separators.some(separator => {
    const next = value.indexOf(separator, bodyStart + 1)
    const following = next < 0 ? undefined : value[next + 1]
    return next > bodyStart + 1 && next < boundedEnd
      && following !== undefined && !/[\s/\\\0]/u.test(following)
  })
}

function validFileUrl(candidate) {
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.port) return false
    if (parsed.hostname === '' || parsed.hostname.toLowerCase() === 'localhost') {
      return path.posix.isAbsolute(fileURLToPath(parsed))
    }
    return parsed.pathname.startsWith('/') && parsed.pathname.length > 1
  } catch {
    return false
  }
}

const WINDOWS_GUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
const UNC_SERVER = /^[\p{L}\p{N}\p{M}_$-][\p{L}\p{N}\p{M}._$-]*$/u

function validUncServer(server) {
  return server !== '.' && server !== '..' && UNC_SERVER.test(server)
}

function validUncShare(share) {
  return share.length > 0 && share.trim() === share && share !== '.' && share !== '..'
    && /[\p{L}\p{N}\p{M}_$-]/u.test(share) && !/[\\/:*?"<>|\p{C}]/u.test(share)
}

function validUncAuthority(value, authorityStart) {
  const serverEnd = value.indexOf('\\', authorityStart)
  if (serverEnd <= authorityStart) return false
  const shareEnd = value.indexOf('\\', serverEnd + 1)
  return validUncServer(value.slice(authorityStart, serverEnd))
    && validUncShare(value.slice(serverEnd + 1, shareEnd < 0 ? value.length : shareEnd))
}

function validWindowsNamespaceStart(value, index) {
  const rest = value.slice(index)
  if (!path.win32.isAbsolute(rest)) return false
  if (/^\\\\\?\\UNC\\/iu.test(rest)) return validUncAuthority(value, index + 8)
  if (/^\\\\[^?.][^\\]*\\/u.test(rest)) return validUncAuthority(value, index + 2)
  if (/^\\\\wsl\$\\/iu.test(rest)) return validUncAuthority(value, index + 2)
  if (/^\\\\[?.]\\[A-Za-z]:\\[^\\\s]/u.test(rest)) return true
  if (new RegExp(`^\\\\\\\\\\?\\\\Volume\\{${WINDOWS_GUID}\\}\\\\[^\\\\\\s]`, 'iu').test(rest)) return true
  return /^\\\\\?\\GLOBALROOT\\Device\\[\p{L}\p{N}\p{M}._$-]+\\[^\\\s]/iu.test(rest)
}

function windowsNamespaceMinimumEnd(value, index) {
  const rest = value.slice(index)
  const volume = new RegExp(`^\\\\\\\\\\?\\\\Volume\\{${WINDOWS_GUID}\\}\\\\[^\\\\\\s]`, 'iu').exec(rest)
  if (volume) return index + volume[0].length
  return index + 2
}

function pathEnd(value, start, minimumEnd) {
  const closer = PATH_CLOSER_BY_OPENER[value[start - 1] ?? '']
  let end = minimumEnd
  while (end < value.length) {
    if (closer
      ? matchingCloserTerminates(value, end, closer)
      : unquotedPathTerminator(value, end)) break
    end += 1
  }
  while (end > minimumEnd && /\s/u.test(value[end - 1])) end -= 1
  return end
}

function protocolRelativeNetworkUrl(candidate) {
  try {
    const parsed = new URL(`https:${candidate}`)
    if (parsed.username || parsed.password || !parsed.hostname) return false
    const authority = candidate.slice(2).split('/')[0] ?? ''
    return parsed.hostname.toLowerCase() === 'localhost' || parsed.hostname.includes('.') || authority.includes(':')
  } catch {
    return false
  }
}

function scanUrlTokenEnd(value, start, minimumEnd) {
  const closer = PATH_CLOSER_BY_OPENER[value[start - 1] ?? '']
  let end = minimumEnd
  while (end < value.length) {
    if (/\s|\0/u.test(value[end])) break
    if (closer && value[end] === closer) break
    if (urlDiagnosticPathAssignmentAt(value, end)) break
    end += 1
  }
  return end
}

function startsAbsoluteLocalPath(value, index) {
  if (windowsDriveMinimumEnd(value, index, true) !== null) return true
  if (value.slice(index, index + 7).toLowerCase() === 'file://') {
    return validFileUrl(value.slice(index, pathEnd(value, index, index + 7)))
  }
  if (value[index] === '~' && value[index + 1] === '/') return validPathBodyStart(value, index + 2, ['/'], true)
  if (value[index] === '\\' && value[index + 1] === '\\') return validWindowsNamespaceStart(value, index)
  if (value[index] !== '/') return false
  let bodyStart = index + 1
  while (value[bodyStart] === '/') bodyStart += 1
  const slashCount = bodyStart - index
  if (!validPathBodyStart(value, bodyStart, ['/'], true)) return false
  const candidate = value.slice(index, pathEnd(value, index, bodyStart))
  return slashCount !== 2 || !protocolRelativeNetworkUrl(candidate)
}

function urlDiagnosticPathAssignmentAt(value, index) {
  const match = /^(?:[,;|]|→|->|=>)\s*[\p{L}_][\p{L}\p{N}_.-]{0,40}\s*=\s*/u.exec(value.slice(index))
  return Boolean(match && startsAbsoluteLocalPath(value, index + match[0].length))
}

function redactUrlUserinfo(candidate, prefixLength) {
  const authorityEndOffset = candidate.slice(prefixLength).search(/[/?#]/u)
  const authorityEnd = authorityEndOffset < 0 ? candidate.length : prefixLength + authorityEndOffset
  const userinfoEnd = candidate.lastIndexOf('@', authorityEnd)
  if (userinfoEnd < prefixLength) return candidate
  return `${candidate.slice(0, prefixLength)}<redacted-credential>@${candidate.slice(userinfoEnd + 1)}`
}

function protectedSchemeUrl(value, index, boundary) {
  if (!boundary) return null
  const prefix = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(value.slice(index))?.[0]
  if (!prefix || prefix.toLowerCase() === 'file://') return null
  const end = scanUrlTokenEnd(value, index, index + prefix.length)
  const candidate = value.slice(index, end)
  try {
    const parsed = new URL(candidate)
    return parsed.protocol.toLowerCase() === prefix.slice(0, -2).toLowerCase() && parsed.hostname
      ? { end, sanitized: redactUrlUserinfo(candidate, prefix.length) }
      : null
  } catch {
    return null
  }
}

function windowsDriveMinimumEnd(value, index, boundary) {
  if (!boundary || !/[A-Za-z]/u.test(value[index] ?? '') || value[index + 1] !== ':') return null
  const separator = value[index + 2]
  if (separator !== '\\' && separator !== '/') return null
  const separatorCount = separator === '/' && value[index + 3] === '/' ? 2 : 1
  const bodyStart = index + 2 + separatorCount
  return validPathBodyStart(value, bodyStart, ['\\', '/'], true) ? bodyStart : null
}

function posixMinimumEnd(value, index, boundary) {
  if (!boundary || value[index] !== '/') return null
  let bodyStart = index + 1
  while (value[bodyStart] === '/') bodyStart += 1
  const slashCount = bodyStart - index
  if (!validPathBodyStart(value, bodyStart, ['/'], slashCount > 1 || explicitPathContext(value, index))) {
    return null
  }
  const candidate = value.slice(index, pathEnd(value, index, bodyStart))
  return slashCount === 2 && protocolRelativeNetworkUrl(candidate) ? null : bodyStart
}

/**
 * Evidence diagnostics are not a trusted logging sink. Protect public URLs and
 * the explicit audit marker, then apply the same privacy-first token rules as
 * the durable event boundary to every embedded local path fragment.
 */
function redactEmbeddedAbsolutePaths(input, canonicalAuditRoot) {
  const protectedValues = []
  const protect = value => {
    const index = protectedValues.push(value) - 1
    return `\0TIDEMIND_SAFE_${index}\0`
  }
  let value = input.replace(
    /<isolated-audit-root>(?:\/[A-Za-z0-9._-]+)*(?![A-Za-z0-9._/-])/gu,
    (match, offset, whole) => pathBoundary(offset === 0 ? undefined : whole[offset - 1]) ? protect(match) : match,
  )

  let sanitized = ''
  let index = 0
  while (index < value.length) {
    const current = value[index]
    const boundary = pathBoundary(index === 0 ? undefined : value[index - 1])
    const windowsMinimumEnd = windowsDriveMinimumEnd(value, index, boundary)
    const schemeUrl = windowsMinimumEnd === null ? protectedSchemeUrl(value, index, boundary) : null
    if (schemeUrl) {
      sanitized += schemeUrl.sanitized
      index = schemeUrl.end
      continue
    }
    const fileUrl = boundary && value.slice(index, index + 7).toLowerCase() === 'file://'
    const posixMinimum = posixMinimumEnd(value, index, boundary)
    const home = boundary && current === '~' && value[index + 1] === '/'
      && validPathBodyStart(value, index + 2, ['/'], true)
    const windows = windowsMinimumEnd !== null
    const unc = boundary && current === '\\' && value[index + 1] === '\\'
      && validWindowsNamespaceStart(value, index)
    const tentativeMinimumEnd = fileUrl
      ? index + 7
      : windows
        ? windowsMinimumEnd
        : unc
          ? windowsNamespaceMinimumEnd(value, index)
          : index + 2
    const tentativeEnd = fileUrl || posixMinimum !== null || unc
      ? pathEnd(value, index, tentativeMinimumEnd)
      : tentativeMinimumEnd
    const candidate = value.slice(index, tentativeEnd)
    const validFile = fileUrl && validFileUrl(candidate)
    const posix = posixMinimum !== null
    if (!validFile && !posix && !home && !windows && !unc) {
      sanitized += current
      index += 1
      continue
    }
    const minimumEnd = validFile
      ? index + 7
      : windows
        ? windowsMinimumEnd
        : unc
          ? windowsNamespaceMinimumEnd(value, index)
          : index + 2
    const end = tentativeEnd > minimumEnd ? tentativeEnd : pathEnd(value, index, minimumEnd)
    sanitized += evidencePathReplacement(value.slice(index, end), canonicalAuditRoot, validFile)
    index = end
  }
  return sanitized.replace(/\0TIDEMIND_SAFE_(\d+)\0/gu, (_match, rawIndex) => protectedValues[Number(rawIndex)])
}

function evidencePathReplacement(candidate, canonicalAuditRoot, fileUrl) {
  let localCandidate = candidate
  try {
    if (fileUrl) localCandidate = fileURLToPath(new URL(candidate))
    if (!path.isAbsolute(localCandidate)) return REDACTED_LOCAL_PATH
    const canonicalCandidate = canonicalizeExistingAncestor(localCandidate)
    const relative = path.relative(canonicalAuditRoot, canonicalCandidate)
    if (relative === '') return REDACTED_AUDIT_ROOT
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${REDACTED_AUDIT_ROOT}/${relative.split(path.sep).join('/')}`
    }
  } catch {
    // Invalid or platform-foreign absolute spellings remain local, but never
    // retain their raw suffix in exported evidence.
  }
  return REDACTED_LOCAL_PATH
}

export function validateAgentIntegrationUiE2eReceipt(receipt) {
  const failures = []
  if (receipt?.protocolVersion !== 1 || receipt?.gate !== 'agent-integration-electron-ui-e2e'
    || receipt?.status !== 'passed') failures.push('receipt status')
  if (receipt?.isolation !== 'temporary-home-physical-sqlite-real-electron') {
    failures.push('receipt isolation')
  }
  if (receipt?.writesRealAgentConfiguration !== false) failures.push('receipt real-config boundary')
  return failures
}

function sanitizedEvidenceValue(value, canonicalAuditRoot) {
  if (Array.isArray(value)) return value.map(item => sanitizedEvidenceValue(item, canonicalAuditRoot))
  if (value && typeof value === 'object') {
    const sanitized = Object.create(null)
    const originalKeys = new Map()
    for (const [key, item] of Object.entries(value)) {
      const safeKey = sanitizedEvidenceObjectKey(key, canonicalAuditRoot)
      const existing = originalKeys.get(safeKey)
      if (existing !== undefined && existing !== key) {
        throw new Error(`UI E2E evidence object-key redaction collision: ${safeKey}`)
      }
      originalKeys.set(safeKey, key)
      sanitized[safeKey] = sanitizedEvidenceValue(item, canonicalAuditRoot)
    }
    return sanitized
  }
  if (typeof value !== 'string') return value
  return sanitizedEvidenceString(value, canonicalAuditRoot)
}

function sanitizedEvidenceString(value, canonicalAuditRoot) {
  if (path.isAbsolute(value)) {
    const resolved = canonicalizeExistingAncestor(value)
    const relative = path.relative(canonicalAuditRoot, resolved)
    if (relative === '') return REDACTED_AUDIT_ROOT
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`UI E2E evidence refuses an absolute path outside the audit root: ${value}`)
    }
    return `${REDACTED_AUDIT_ROOT}/${relative.split(path.sep).join('/')}`
  }
  return redactEmbeddedAbsolutePaths(value, canonicalAuditRoot)
}

function sanitizedEvidenceObjectKey(key, canonicalAuditRoot) {
  let sanitized
  try {
    sanitized = sanitizedEvidenceString(key, canonicalAuditRoot)
  } catch {
    // A path outside the audit root is correctly rejected as a standalone
    // value. Keys cannot retain that raw path in an exception or a placeholder,
    // so collapse it to the same private class before deriving the key below.
    sanitized = REDACTED_LOCAL_PATH
  }
  if (sanitized === key) return key
  const digest = crypto.createHash('sha256').update(key).digest('hex')
  return `_redacted_key_sha256_${digest}`
}

function evidenceFileRecord(evidenceDir, relative) {
  const absolute = path.join(evidenceDir, relative)
  const stat = fs.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`UI E2E evidence requires an ordinary file: ${relative}`)
  return {
    path: relative,
    mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
    bytes: stat.size,
    sha256: sha256(absolute),
  }
}

function evidenceDirectoryRecord(evidenceDir, relative) {
  const absolute = relative === '.' ? evidenceDir : path.join(evidenceDir, relative)
  const stat = fs.lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`UI E2E evidence requires an ordinary directory: ${relative}`)
  }
  return {
    path: relative,
    mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
  }
}

function collectEvidenceEntries(root, current = root) {
  const entries = { files: [], directories: [] }
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`UI E2E evidence refuses symlink: ${path.relative(root, absolute)}`)
    if (stat.isDirectory()) {
      entries.directories.push(path.relative(root, absolute).split(path.sep).join('/'))
      const nested = collectEvidenceEntries(root, absolute)
      entries.files.push(...nested.files)
      entries.directories.push(...nested.directories)
    } else if (stat.isFile()) entries.files.push(path.relative(root, absolute).split(path.sep).join('/'))
    else throw new Error(`UI E2E evidence refuses non-file entry: ${path.relative(root, absolute)}`)
  }
  return entries
}

export function verifyAgentIntegrationUiE2eEvidence({ evidenceDir, expectedManifestSha256 }) {
  if (!path.isAbsolute(evidenceDir)) throw new Error('UI E2E evidence directory must be absolute')
  const rootStat = fs.lstatSync(evidenceDir)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('UI E2E evidence root must be an ordinary directory')
  const manifestPath = path.join(evidenceDir, 'evidence-manifest.json')
  const manifestStat = fs.lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('UI E2E evidence manifest must be an ordinary file')
  if ((manifestStat.mode & 0o777) !== 0o600) throw new Error('UI E2E evidence manifest mode mismatch')
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? '') || sha256(manifestPath) !== expectedManifestSha256) {
    throw new Error('UI E2E evidence manifest digest mismatch')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest?.protocolVersion !== 1 || manifest?.gate !== 'agent-integration-electron-ui-e2e-evidence'
    || !Array.isArray(manifest?.directories)
    || !Array.isArray(manifest?.files)) throw new Error('UI E2E evidence manifest protocol mismatch')
  const requiredDirectories = [
    { path: '.', mode: '0700' },
    { path: 'screenshots', mode: '0700' },
  ]
  if (JSON.stringify(manifest.directories) !== JSON.stringify(requiredDirectories)) {
    throw new Error('UI E2E evidence directory manifest mismatch')
  }
  for (const required of requiredDirectories) {
    const actual = evidenceDirectoryRecord(evidenceDir, required.path)
    if (actual.mode !== required.mode) {
      throw new Error(`UI E2E evidence directory metadata mismatch: ${required.path}`)
    }
  }
  const listed = manifest.files.map(file => file?.path)
  const sortedUnique = [...new Set(listed)].sort()
  if (listed.some(relative => typeof relative !== 'string'
    || relative !== path.posix.normalize(relative)
    || relative.startsWith('../') || relative.startsWith('/') || relative === 'evidence-manifest.json')
    || sortedUnique.length !== listed.length) throw new Error('UI E2E evidence manifest contains unsafe or duplicate paths')
  const entries = collectEvidenceEntries(evidenceDir)
  if (JSON.stringify(entries.directories.sort()) !== JSON.stringify(['screenshots'])) {
    throw new Error('UI E2E evidence directory set mismatch')
  }
  const actual = entries.files.filter(relative => relative !== 'evidence-manifest.json').sort()
  if (JSON.stringify(sortedUnique) !== JSON.stringify(actual)) throw new Error('UI E2E evidence file set mismatch')
  for (const file of manifest.files) {
    const actualRecord = evidenceFileRecord(evidenceDir, file.path)
    if (file.mode !== actualRecord.mode || file.bytes !== actualRecord.bytes || file.sha256 !== actualRecord.sha256) {
      throw new Error(`UI E2E evidence metadata mismatch: ${file.path}`)
    }
  }
  return { manifestSha256: expectedManifestSha256, files: sortedUnique }
}

function assertNewEvidenceDirectory(evidenceDir) {
  if (!path.isAbsolute(evidenceDir)) throw new Error('UI E2E evidence directory must be absolute')
  if (fs.existsSync(evidenceDir)) throw new Error(`UI E2E evidence directory already exists: ${evidenceDir}`)
  const parent = path.dirname(evidenceDir)
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) {
    throw new Error(`UI E2E evidence parent directory does not exist: ${parent}`)
  }
}

/**
 * Export only sanitized, deterministic evidence. The retained report must not
 * contain the random temporary HOME, userData path, or any path outside the
 * isolated audit root. Source screenshots are accepted only as ordinary PNG
 * files directly under the fixture artifact directory.
 */
export function writeAgentIntegrationUiE2eEvidence({
  auditRoot,
  artifactsDir,
  report,
  evidenceDir,
}) {
  assertNewEvidenceDirectory(evidenceDir)
  const canonicalAuditRoot = fs.realpathSync(auditRoot)
  const canonicalArtifacts = fs.realpathSync(artifactsDir)
  const artifactsRelative = path.relative(canonicalAuditRoot, canonicalArtifacts)
  if (!artifactsRelative || artifactsRelative.startsWith('..') || path.isAbsolute(artifactsRelative)) {
    throw new Error('UI E2E screenshot directory escaped the isolated audit root')
  }

  const screenshotNames = fs.readdirSync(canonicalArtifacts).sort()
  if (screenshotNames.length === 0) throw new Error('UI E2E evidence has no screenshots')
  for (const name of screenshotNames) {
    if (path.basename(name) !== name || !/^[A-Za-z0-9._-]+\.png$/u.test(name)) {
      throw new Error(`UI E2E evidence refuses screenshot name: ${name}`)
    }
    const source = path.join(canonicalArtifacts, name)
    const stat = fs.lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`UI E2E evidence requires an ordinary screenshot file: ${source}`)
    }
  }

  fs.mkdirSync(evidenceDir, { mode: 0o700 })
  fs.chmodSync(evidenceDir, 0o700)
  try {
    const screenshotsDir = path.join(evidenceDir, 'screenshots')
    fs.mkdirSync(screenshotsDir, { mode: 0o700 })
    fs.chmodSync(screenshotsDir, 0o700)
    for (const name of screenshotNames) {
      fs.copyFileSync(path.join(canonicalArtifacts, name), path.join(screenshotsDir, name), fs.constants.COPYFILE_EXCL)
      fs.chmodSync(path.join(screenshotsDir, name), 0o600)
    }

    const sanitizedReport = sanitizedEvidenceValue(report, canonicalAuditRoot)
    sanitizedReport.auditRoot = REDACTED_AUDIT_ROOT
    sanitizedReport.screenshots = screenshotNames.map(name => `screenshots/${name}`)
    const reportPath = path.join(evidenceDir, 'ui-e2e-report.json')
    fs.writeFileSync(reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

    const evidenceFiles = [
      'ui-e2e-report.json',
      ...screenshotNames.map(name => `screenshots/${name}`),
    ]
    const manifest = {
      protocolVersion: 1,
      gate: 'agent-integration-electron-ui-e2e-evidence',
      directories: [
        evidenceDirectoryRecord(evidenceDir, '.'),
        evidenceDirectoryRecord(evidenceDir, 'screenshots'),
      ],
      files: evidenceFiles.map(relative => {
        return evidenceFileRecord(evidenceDir, relative)
      }),
    }
    fs.writeFileSync(path.join(evidenceDir, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    return manifest
  } catch (error) {
    fs.rmSync(evidenceDir, { recursive: true, force: true })
    throw error
  }
}
