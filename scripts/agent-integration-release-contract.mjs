import crypto from 'node:crypto'

const ALL_AGENT_COMPONENTS = Object.freeze(['instruction', 'memory_tools', 'lifecycle'])
const CORE_AGENT_COMPONENTS = Object.freeze(['instruction', 'memory_tools'])
let lastMaskedSource = null
let lastMaskedCode = null

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function maskNonCode(source) {
  if (source === lastMaskedSource) return lastMaskedCode
  const result = []
  let state = 'code'
  let escaped = false
  let regexCharacterClass = false
  let previousSignificant = null
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'line_comment') {
      if (character === '\n') {
        state = 'code'
        result.push('\n')
      } else result.push(' ')
      continue
    }
    if (state === 'block_comment') {
      if (character === '*' && next === '/') {
        result.push('  ')
        index += 1
        state = 'code'
      } else result.push(character === '\n' ? '\n' : ' ')
      continue
    }
    if (state === 'regex') {
      result.push(character === '\n' ? '\n' : ' ')
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '[') regexCharacterClass = true
      else if (character === ']') regexCharacterClass = false
      else if (character === '/' && !regexCharacterClass) {
        state = 'code'
        previousSignificant = 'value'
      }
      continue
    }
    if (state !== 'code') {
      result.push(character === '\n' ? '\n' : ' ')
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if ((state === 'single' && character === "'")
        || (state === 'double' && character === '"')
        || (state === 'template' && character === '`')) {
        state = 'code'
        previousSignificant = 'value'
      }
      continue
    }
    if (character === '/' && next === '/') {
      result.push('  ')
      index += 1
      state = 'line_comment'
    } else if (character === '/' && next === '*') {
      result.push('  ')
      index += 1
      state = 'block_comment'
    } else if (character === '/'
      && (previousSignificant === null || /[([{,:;=!?&|+*%^~<>-]/u.test(previousSignificant))) {
      result.push(' ')
      state = 'regex'
      regexCharacterClass = false
    } else if (character === "'") {
      result.push(' ')
      state = 'single'
    } else if (character === '"') {
      result.push(' ')
      state = 'double'
    } else if (character === '`') {
      result.push(' ')
      state = 'template'
    } else {
      result.push(character)
      if (!/\s/u.test(character)) previousSignificant = character
    }
  }
  const masked = result.join('')
  lastMaskedSource = source
  lastMaskedCode = masked
  return masked
}

function parseDeclaredLiteral(source, marker, pattern, label) {
  const start = uniqueCodeMarkerIndex(source, marker, label)
  const match = source.slice(start + marker.length).match(pattern)
  if (!match) throw new Error(`Agent release manifest has invalid ${label}`)
  return match[1]
}

function validateReleaseHelper(source) {
  const marker = 'function release('
  const body = uniqueFunctionBody(source, marker, 'release helper')
  const exactBody = /^\s*return\s+(?:freezeEntry|Object\.freeze)\(\{\s*catalogId,\s*disposition,\s*targetCapability,\s*requiredComponents,\s*\.\.\.details,\s*customConfigRoot:\s*\{\s*supported:\s*CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS\.includes\(catalogId\s+as\s+never\)\s*\},\s*enabledByDefault:\s*details\.releaseMode\s*===\s*["']production["'],?\s*\}\)\s*;?\s*$/u
  if (!exactBody.test(body)) throw new Error('Agent release manifest has invalid release helper binding')
}

function validateObserveOnlyHelper(source) {
  const body = uniqueFunctionBody(source, 'function observeOnly(', 'observe-only helper')
  const exactBody = /^\s*return\s+(?:freezeEntry|Object\.freeze)\(\{\s*catalogId,\s*disposition:\s*["']observe_only["'],\s*targetCapability:\s*0,\s*requiredComponents:\s*\[\],\s*\.\.\.details,\s*customConfigRoot:\s*\{\s*supported:\s*false\s*\},\s*enabledByDefault:\s*false,\s*notes,?\s*\}\)\s*;?\s*$/u
  if (!exactBody.test(body)) throw new Error('Agent release manifest has invalid observe-only helper binding')
}

export function uniqueCodeMarkerIndex(source, marker, label) {
  const masked = maskNonCode(source)
  const index = masked.indexOf(marker)
  if (index < 0) throw new Error(`Agent release manifest is missing ${label}`)
  if (masked.indexOf(marker, index + marker.length) >= 0) {
    throw new Error(`Agent release manifest has duplicate ${label}`)
  }
  return index
}

export function codeMarkerCount(source, marker) {
  const masked = maskNonCode(source)
  let count = 0
  let offset = 0
  while (true) {
    const index = masked.indexOf(marker, offset)
    if (index < 0) return count
    count += 1
    offset = index + marker.length
  }
}

export function uniqueFunctionBody(source, marker, label) {
  const start = uniqueCodeMarkerIndex(source, marker, label)
  const masked = maskNonCode(source)
  const parametersStart = masked.indexOf('(', start)
  if (parametersStart < 0) throw new Error(`Agent release manifest ${label} has no parameter list`)
  let parameterDepth = 1
  let parametersEnd = -1
  for (let index = parametersStart + 1; index < masked.length; index += 1) {
    if (masked[index] === '(') parameterDepth += 1
    else if (masked[index] === ')') {
      parameterDepth -= 1
      if (parameterDepth === 0) {
        parametersEnd = index
        break
      }
    }
  }
  if (parametersEnd < 0) throw new Error(`Agent release manifest ${label} has an unterminated parameter list`)
  const bodyStart = masked.indexOf('{', parametersEnd + 1)
  if (bodyStart < 0) throw new Error(`Agent release manifest ${label} is unterminated`)
  return contentsFromOpeningDelimiter(source, bodyStart, '{', '}', label)
}

function contentsFromOpeningDelimiter(source, openIndex, open, close, label) {
  let depth = 1
  let quote = null
  let escaped = false
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
  throw new Error(`Agent release manifest ${label} is unterminated`)
}

function releasedEntry(catalogId, disposition, targetCapability, requiredComponents, details, relocatableCatalogIds) {
  return Object.freeze({
    catalogId,
    disposition,
    targetCapability,
    requiredComponents: Object.freeze([...requiredComponents]),
    ...details,
    customConfigRoot: Object.freeze({ supported: relocatableCatalogIds.has(catalogId) }),
    enabledByDefault: details.releaseMode === 'production',
  })
}

function observeOnlyEntry(catalogId, notes, details) {
  return Object.freeze({
    catalogId,
    disposition: 'observe_only',
    targetCapability: 0,
    requiredComponents: Object.freeze([]),
    ...details,
    customConfigRoot: Object.freeze({ supported: false }),
    enabledByDefault: false,
    notes,
  })
}

function parseDetails(expression, label) {
  let details
  try {
    details = JSON.parse(expression)
  } catch {
    throw new Error(`Agent release manifest has invalid ${label} details`)
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error(`Agent release manifest has invalid ${label} details`)
  }
  const exactKeys = [
    'components', 'officialDistributions', 'acceptedDistributionArtifacts', 'observedExactVersions', 'releaseAcceptedExactVersions',
    'activation', 'requiredLifecycle', 'releaseMode',
  ]
  if (JSON.stringify(Object.keys(details).sort()) !== JSON.stringify(exactKeys.sort())) {
    throw new Error(`Agent release manifest has invalid ${label} detail fields`)
  }
  if (!Array.isArray(details.components)
    || !Array.isArray(details.officialDistributions)
    || !Array.isArray(details.acceptedDistributionArtifacts)
    || !Array.isArray(details.observedExactVersions)
    || !Array.isArray(details.releaseAcceptedExactVersions)
    || !['production', 'detect_only'].includes(details.releaseMode)) {
    throw new Error(`Agent release manifest has invalid ${label} details`)
  }
  for (const [index, distribution] of details.officialDistributions.entries()) {
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
      throw new Error(`Agent release manifest has invalid ${label} distribution ${index}`)
    }
    const keys = ['channel', 'distributionId', 'packageProvenance', 'supportedMacArchitectures'].sort()
    if (JSON.stringify(Object.keys(distribution).sort()) !== JSON.stringify(keys)) {
      throw new Error(`Agent release manifest has invalid ${label} distribution ${index} fields`)
    }
    const architectures = distribution.supportedMacArchitectures
    if (!Array.isArray(architectures) || architectures.length === 0
      || architectures.some(value => !['arm64', 'x64'].includes(value))
      || new Set(architectures).size !== architectures.length) {
      throw new Error(`Agent release manifest has invalid ${label} distribution ${index} architectures`)
    }
  }
  validateAcceptedDistributionArtifacts(details, label)
  return details
}

const RELEASE_SHA256 = /^[a-f0-9]{64}$/u
const RELEASE_PORTABLE_ARTIFACT = RELEASE_SHA256

function validateAcceptedDistributionArtifacts(details, label) {
  const expectedKeys = details.releaseAcceptedExactVersions.flatMap(version => (
    details.officialDistributions.flatMap(distribution => (
      distribution.supportedMacArchitectures.map(architecture => (
        `${distribution.distributionId}\u0000${distribution.packageProvenance}\u0000${version}\u0000${architecture}`
      ))
    ))
  )).sort()
  const actualKeys = []
  for (const [index, receipt] of details.acceptedDistributionArtifacts.entries()) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new Error(`Agent release manifest has invalid ${label} artifact receipt ${index}`)
    }
    const fields = [
      'distributionId', 'packageProvenance', 'version', 'architecture',
      'artifactSha256', 'artifactSizeBytes', 'executableSha256', 'executableSizeBytes',
      'distributionSha256', 'distributionSizeBytes', 'portableFingerprintSchema', 'portableArtifactFingerprint',
      'signedCode', 'npmPackage',
    ].sort()
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(fields)) {
      throw new Error(`Agent release manifest has invalid ${label} artifact receipt ${index} fields`)
    }
    const distribution = details.officialDistributions.find(candidate => (
      candidate.distributionId === receipt.distributionId
      && candidate.packageProvenance === receipt.packageProvenance
      && candidate.supportedMacArchitectures.includes(receipt.architecture)
    ))
    if (!distribution || !details.releaseAcceptedExactVersions.includes(receipt.version)
      || ![receipt.artifactSha256, receipt.executableSha256, receipt.distributionSha256].every(value => RELEASE_SHA256.test(value ?? ''))
      || !RELEASE_PORTABLE_ARTIFACT.test(receipt.portableArtifactFingerprint ?? '')
      || ![receipt.artifactSizeBytes, receipt.executableSizeBytes, receipt.distributionSizeBytes]
        .every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`Agent release manifest has invalid ${label} artifact receipt ${index}`)
    }
    if (distribution.channel === 'npm') {
      const npmPackage = receipt.npmPackage
      if (receipt.signedCode !== null || !npmPackage || typeof npmPackage !== 'object' || Array.isArray(npmPackage)
        || ![
          ['integrity', 'ownedPackageSha256', 'ownedEntryCount', 'ownedTotalBytes', 'proofNodes'],
          ['composition', 'integrity', 'ownedPackageSha256', 'ownedEntryCount', 'ownedTotalBytes', 'proofNodes'],
        ].some(keys => JSON.stringify(Object.keys(npmPackage).sort()) === JSON.stringify(keys.sort()))
        || (receipt.portableFingerprintSchema === 'qwen-standalone-surface-v1'
          ? npmPackage.integrity !== null
          : !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(npmPackage.integrity ?? ''))
        || !RELEASE_SHA256.test(npmPackage.ownedPackageSha256 ?? '')
        || !Number.isSafeInteger(npmPackage.ownedEntryCount) || npmPackage.ownedEntryCount <= 0
        || !Number.isSafeInteger(npmPackage.ownedTotalBytes) || npmPackage.ownedTotalBytes < 0
        || !Array.isArray(npmPackage.proofNodes) || npmPackage.proofNodes.length === 0
        || npmPackage.proofNodes.length > 16
        || npmPackage.proofNodes.some(node => !node || typeof node !== 'object' || Array.isArray(node)
          || JSON.stringify(Object.keys(node).sort()) !== JSON.stringify(['role', 'relativePath', 'sha256', 'sizeBytes', 'executable', 'normalization'].sort())
          || typeof node.role !== 'string' || node.role.length === 0
          || typeof node.relativePath !== 'string' || node.relativePath.length === 0
          || node.relativePath.startsWith('/') || node.relativePath.split('/').includes('..')
          || !RELEASE_SHA256.test(node.sha256 ?? '') || !Number.isSafeInteger(node.sizeBytes) || node.sizeBytes < 0
          || typeof node.executable !== 'boolean'
          || !['raw', 'openclaw_prefix_template_v1', 'qwen_relative_root_v1'].includes(node.normalization))) {
        throw new Error(`Agent release manifest has invalid ${label} npm artifact receipt ${index}`)
      }
      if (npmPackage.composition !== undefined) validateNpmComposition(npmPackage.composition, receipt, label, index)
      const rootPackage = receipt.packageProvenance.startsWith('npm_metadata:')
        ? receipt.packageProvenance.slice('npm_metadata:'.length)
        : ''
      const expectedComposition = expectedNpmComposition(
        rootPackage, receipt.version, receipt.architecture, receipt.distributionId,
      )
      if (Boolean(expectedComposition) !== Boolean(npmPackage.composition)) {
        throw new Error(`Agent release manifest has incomplete ${label} npm composition ${index}`)
      }
      if (expectedComposition && JSON.stringify(npmPackage.composition.components.map(component => ({
        role: component.role,
        installName: component.installName,
        manifestName: component.manifestName,
        version: component.version,
        nativeExecutableRelativePath: component.nativeExecutableRelativePath,
      }))) !== JSON.stringify(expectedComposition.components)) {
        throw new Error(`Agent release manifest has wrong ${label} npm composition ${index}`)
      }
      if (expectedComposition && (npmPackage.composition.entryRule !== expectedComposition.entryRule
        || npmPackage.proofNodes.find(node => node.role === 'npm_package_executable')?.relativePath !== expectedComposition.rootExecutableRelativePath)) {
        throw new Error(`Agent release manifest has wrong ${label} npm entry rule ${index}`)
      }
      if (expectedComposition?.entryRule === 'copy_platform_binary_v1') {
        const leaves = npmPackage.composition.components.filter(component => component.role === 'platform_leaf')
        const matches = leaves.filter(leaf => leaf.nativeExecutableSha256 === receipt.executableSha256
          && leaf.nativeExecutableSizeBytes === receipt.executableSizeBytes)
        const isOpenCodeV1X64 = receipt.architecture === 'x64' && rootPackage === 'opencode-ai'
        const isOpenCodeV2X64 = receipt.architecture === 'x64' && rootPackage === '@opencode-ai/cli'
        if ((isOpenCodeV1X64 && (leaves.length !== 2 || matches.length !== 2))
          || (isOpenCodeV2X64 && (leaves.length !== 2 || matches.length !== 1
            || matches[0]?.installName !== expectedComposition.copySourceInstallName))
          || (!isOpenCodeV1X64 && !isOpenCodeV2X64
            && (matches.length !== 1 || matches[0]?.installName !== expectedComposition.copySourceInstallName))) {
          throw new Error(`Agent release manifest has unbound ${label} copied npm executable ${index}`)
        }
      }
    } else {
      const signedCode = receipt.signedCode
      const expectedSignedIdentity = distribution.packageProvenance.match(/^signed_(?:app|cli):([^:]+):([^:]+)$/u)
      if (receipt.npmPackage !== null || !signedCode || typeof signedCode !== 'object' || Array.isArray(signedCode)
        || JSON.stringify(Object.keys(signedCode).sort()) !== JSON.stringify(['identifier', 'teamIdentifier', 'cdhash', 'designatedRequirement'].sort())
        || typeof signedCode.identifier !== 'string' || signedCode.identifier.length === 0 || signedCode.identifier !== signedCode.identifier.trim()
        || typeof signedCode.teamIdentifier !== 'string' || signedCode.teamIdentifier.length === 0 || signedCode.teamIdentifier !== signedCode.teamIdentifier.trim()
        || !/^[A-Fa-f0-9]{20,128}$/u.test(signedCode.cdhash ?? '')
        || typeof signedCode.designatedRequirement !== 'string' || signedCode.designatedRequirement.length === 0
        || signedCode.designatedRequirement.length > 8 * 1024
        || signedCode.designatedRequirement !== signedCode.designatedRequirement.trim()
        || signedCode.identifier !== expectedSignedIdentity?.[1]
        || signedCode.teamIdentifier !== expectedSignedIdentity?.[2]
        || (label === 'kimi-code-native'
          && (distribution.channel !== 'signed_cli'
            || receipt.portableFingerprintSchema !== 'signed-cli-kimi-release-v2'
            || receipt.distributionSha256 !== receipt.executableSha256
            || receipt.distributionSizeBytes !== receipt.executableSizeBytes))) {
        throw new Error(`Agent release manifest has invalid ${label} signed artifact receipt ${index}`)
      }
    }
    actualKeys.push(`${receipt.distributionId}\u0000${receipt.packageProvenance}\u0000${receipt.version}\u0000${receipt.architecture}`)
    if (portableArtifactFingerprint(receipt) !== receipt.portableArtifactFingerprint) {
      throw new Error(`Agent release manifest has inconsistent ${label} portable artifact receipt ${index}`)
    }
  }
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys.sort())) {
    throw new Error(`Agent release manifest ${label} accepted versions lack an exact distribution artifact receipt matrix`)
  }
}

function validateNpmComposition(composition, receipt, label, index) {
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)
    || JSON.stringify(Object.keys(composition).sort()) !== JSON.stringify(['components', 'entryRule'])
    || !['copy_platform_binary_v1', 'js_wrapper_selects_platform_binary_v1', 'js_entry_loads_platform_native_v1'].includes(composition.entryRule)
    || !Array.isArray(composition.components) || composition.components.length < 1 || composition.components.length > 2) {
    throw new Error(`Agent release manifest has invalid ${label} npm composition ${index}`)
  }
  const fields = ['artifactSha256', 'artifactSizeBytes', 'installName', 'integrity', 'manifestName', 'nativeExecutableRelativePath', 'nativeExecutableSha256', 'nativeExecutableSizeBytes', 'ownedEntryCount', 'ownedPackageSha256', 'ownedTotalBytes', 'role', 'version'].sort()
  for (const component of composition.components) {
    if (!component || typeof component !== 'object' || Array.isArray(component)
      || JSON.stringify(Object.keys(component).sort()) !== JSON.stringify(fields)
      || !['platform_selector', 'platform_leaf'].includes(component.role)
      || typeof component.installName !== 'string' || typeof component.manifestName !== 'string'
      || typeof component.version !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(component.integrity ?? '')
      || !RELEASE_SHA256.test(component.artifactSha256 ?? '') || !RELEASE_SHA256.test(component.ownedPackageSha256 ?? '')
      || !Number.isSafeInteger(component.artifactSizeBytes) || component.artifactSizeBytes <= 0
      || !Number.isSafeInteger(component.ownedEntryCount) || component.ownedEntryCount <= 0
      || !Number.isSafeInteger(component.ownedTotalBytes) || component.ownedTotalBytes < 0) {
      throw new Error(`Agent release manifest has invalid ${label} npm composition component ${index}`)
    }
    const nativeNull = component.nativeExecutableRelativePath === null
      && component.nativeExecutableSha256 === null && component.nativeExecutableSizeBytes === null
    const nativePresent = typeof component.nativeExecutableRelativePath === 'string'
      && component.nativeExecutableRelativePath.length > 0
      && !component.nativeExecutableRelativePath.startsWith('/')
      && !component.nativeExecutableRelativePath.split('/').includes('..')
      && RELEASE_SHA256.test(component.nativeExecutableSha256 ?? '')
      && Number.isSafeInteger(component.nativeExecutableSizeBytes) && component.nativeExecutableSizeBytes > 0
    if (!nativeNull && !nativePresent) throw new Error(`Agent release manifest has invalid ${label} npm native component ${index}`)
  }
  const leafCount = composition.components.filter(component => component.role === 'platform_leaf').length
  if (receipt.portableFingerprintSchema !== 'npm-composed-platform-surface-v1'
    || leafCount < 1 || leafCount > 2) {
    throw new Error(`Agent release manifest has invalid ${label} npm composition topology ${index}`)
  }
}

function expectedNpmComposition(packageName, version, architecture, distributionId) {
  if (packageName === '@anthropic-ai/claude-code') {
    const installName = `@anthropic-ai/claude-code-darwin-${architecture}`
    return {
    entryRule: 'copy_platform_binary_v1', rootExecutableRelativePath: 'bin/claude.exe',
    copySourceInstallName: installName,
    components: [{ role: 'platform_leaf', installName, manifestName: installName, version, nativeExecutableRelativePath: 'claude' }],
    }
  }
  if (packageName === '@openai/codex') return {
    entryRule: 'js_wrapper_selects_platform_binary_v1', rootExecutableRelativePath: 'bin/codex.js',
    components: [{ role: 'platform_leaf', installName: `@openai/codex-darwin-${architecture}`, manifestName: '@openai/codex', version: `${version}-darwin-${architecture}`, nativeExecutableRelativePath: `vendor/${architecture === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin/bin/codex` }],
  }
  const scoped = packageName === '@opencode-ai/cli'
  if (packageName === 'opencode-ai' || scoped) {
    const catalogId = scoped ? 'opencode-v2-beta-cli' : 'opencode-v1-cli'
    const variant = architecture === 'arm64' ? 'darwin-arm64'
      : scoped && distributionId === `cli:${catalogId}:darwin-x64-baseline`
        ? 'darwin-x64-baseline' : 'darwin-x64'
    if (distributionId !== `cli:${catalogId}:${variant}`) return null
    const leafBase = `${scoped ? '@opencode-ai/cli' : 'opencode'}-darwin-${architecture}`
    const leafNames = architecture === 'x64' ? [leafBase, `${leafBase}-baseline`] : [leafBase]
    return {
    entryRule: 'copy_platform_binary_v1', rootExecutableRelativePath: `bin/${scoped ? 'opencode2' : 'opencode'}.exe`,
    copySourceInstallName: variant === 'darwin-x64-baseline' ? `${leafBase}-baseline` : leafBase,
    components: leafNames.map(installName => ({ role: 'platform_leaf', installName, manifestName: installName, version, nativeExecutableRelativePath: `bin/${scoped ? 'opencode2' : 'opencode'}` })),
    }
  }
  if (packageName === '@oh-my-pi/pi-coding-agent') return {
    entryRule: 'js_entry_loads_platform_native_v1', rootExecutableRelativePath: 'dist/cli.js',
    components: [
      { role: 'platform_selector', installName: '@oh-my-pi/pi-natives', manifestName: '@oh-my-pi/pi-natives', version, nativeExecutableRelativePath: null },
      { role: 'platform_leaf', installName: `@oh-my-pi/pi-natives-darwin-${architecture}`, manifestName: `@oh-my-pi/pi-natives-darwin-${architecture}`, version, nativeExecutableRelativePath: architecture === 'x64' ? 'pi_natives.darwin-x64-baseline.node' : 'pi_natives.darwin-arm64.node' },
    ],
  }
  return null
}

export function portableArtifactFingerprint(receipt) {
  const file = node => ({
    relativePath: node.relativePath,
    sha256: node.sha256,
    sizeBytes: node.sizeBytes,
    executable: node.executable,
  })
  let payload
  if (receipt.portableFingerprintSchema === 'openclaw-official-wrapper-v1') {
    const [wrapper, node, ...criticalNodes] = receipt.npmPackage.proofNodes
    const nodeMatch = node?.relativePath.match(/^tools\/(node-v\d+\.\d+\.\d+)\/bin\/node$/u)
    const toolchain = nodeMatch?.[1]
    const packagePrefix = `tools/${toolchain}/lib/node_modules/openclaw/`
    const treeRelative = criticalNodes.map(candidate => ({
      ...candidate,
      packageRelativePath: candidate.relativePath.startsWith(packagePrefix)
        ? candidate.relativePath.slice(packagePrefix.length)
        : null,
    }))
    if (criticalNodes.length === 0
      || wrapper.role !== 'openclaw_wrapper' || wrapper.relativePath !== 'bin/openclaw'
      || wrapper.normalization !== 'openclaw_prefix_template_v1'
      || !toolchain || node.role !== 'openclaw_node_runtime' || node.normalization !== 'raw'
      || treeRelative.some(candidate => !candidate.packageRelativePath || candidate.normalization !== 'raw')
      || !treeRelative.some(candidate => candidate.role === 'openclaw_entry' && candidate.packageRelativePath === 'dist/entry.js')
      || !treeRelative.some(candidate => candidate.role === 'package_manifest' && candidate.packageRelativePath === 'package.json')
      || JSON.stringify(treeRelative.map(candidate => candidate.packageRelativePath))
        !== JSON.stringify([...treeRelative.map(candidate => candidate.packageRelativePath)].sort())) {
      throw new Error('Agent release manifest has invalid OpenClaw portable proof topology')
    }
    if (receipt.npmPackage.ownedEntryCount < criticalNodes.length
      || receipt.npmPackage.ownedTotalBytes < criticalNodes.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)) {
      throw new Error('Agent release manifest has invalid OpenClaw owned package summary')
    }
    const normalizedWrapper = `#!/usr/bin/env bash\nset -euo pipefail\nexec "<OPENCLAW_PREFIX>/tools/node/bin/node" "<OPENCLAW_PREFIX>/tools/${toolchain}/lib/node_modules/openclaw/dist/entry.js" "$@"\n`
    if (wrapper.sha256 !== sha256Text(normalizedWrapper)
      || wrapper.sizeBytes !== Buffer.byteLength(normalizedWrapper)
      || receipt.executableSha256 !== wrapper.sha256
      || receipt.executableSizeBytes !== wrapper.sizeBytes) {
      throw new Error('Agent release manifest has invalid OpenClaw normalized wrapper receipt')
    }
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      wrapper: file(wrapper),
      node: file(node),
      ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      ownedEntryCount: receipt.npmPackage.ownedEntryCount,
      ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
    }
  } else if (receipt.portableFingerprintSchema === 'qwen-standalone-surface-v1') {
    if (receipt.distributionId !== 'cli:qwen-code-cli:standalone' || receipt.npmPackage.integrity !== null) {
      throw new Error('Agent release manifest has invalid Qwen standalone distribution identity')
    }
    const roles = new Map(receipt.npmPackage.proofNodes.map(node => [node.role, node]))
    const expectedRoles = [
      'qwen_launcher', 'package_manifest', 'qwen_standalone_manifest',
      'qwen_cli_entry', 'qwen_node_runtime',
    ]
    if (roles.size !== expectedRoles.length
      || expectedRoles.some(role => !roles.has(role))
      || receipt.npmPackage.proofNodes.length !== expectedRoles.length) {
      throw new Error('Agent release manifest has invalid Qwen standalone proof roles')
    }
    const launcher = roles.get('qwen_launcher')
    const packageManifest = roles.get('package_manifest')
    const standaloneManifest = roles.get('qwen_standalone_manifest')
    const cliEntry = roles.get('qwen_cli_entry')
    const node = roles.get('qwen_node_runtime')
    const expectedPaths = new Map([
      ['qwen_launcher', 'bin/qwen'],
      ['package_manifest', 'package.json'],
      ['qwen_standalone_manifest', 'manifest.json'],
      ['qwen_cli_entry', 'lib/cli-entry.js'],
      ['qwen_node_runtime', 'node/bin/node'],
    ])
    if (receipt.npmPackage.proofNodes.some(candidate => (
      candidate.relativePath !== expectedPaths.get(candidate.role)
      || candidate.normalization !== (candidate.role === 'qwen_launcher' ? 'qwen_relative_root_v1' : 'raw')
    )) || !launcher.executable || !node.executable) {
      throw new Error('Agent release manifest has invalid Qwen standalone proof topology')
    }
    const packageNodes = [packageManifest, standaloneManifest, cliEntry, node]
    if (receipt.npmPackage.ownedEntryCount < packageNodes.length
      || receipt.npmPackage.ownedTotalBytes < packageNodes.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)) {
      throw new Error('Agent release manifest has invalid Qwen standalone owned package summary')
    }
    const normalizedLauncher = [
      '#!/usr/bin/env sh',
      'set -e',
      'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
      'QWEN_CODE_LAUNCHER_PATH="$ROOT/bin/qwen" exec "$ROOT/node/bin/node" "$ROOT/lib/cli-entry.js" "$@"',
      '',
    ].join('\n')
    if (launcher.sha256 !== sha256Text(normalizedLauncher)
      || launcher.sizeBytes !== Buffer.byteLength(normalizedLauncher)
      || receipt.executableSha256 !== launcher.sha256
      || receipt.executableSizeBytes !== launcher.sizeBytes) {
      throw new Error('Agent release manifest has invalid Qwen normalized launcher receipt')
    }
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      launcher: file(launcher),
      standaloneManifest: file(standaloneManifest),
      cliEntry: file(cliEntry),
      node: file(node),
      ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      ownedEntryCount: receipt.npmPackage.ownedEntryCount,
      ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
    }
  } else if (receipt.portableFingerprintSchema === 'signed-cli-kimi-release-v2') {
    const executableArtifactFingerprint = sha256Text(JSON.stringify({
      schema: 'kimi-native-executable-v1',
      executable: { relativePath: 'bin/kimi', sha256: receipt.executableSha256, sizeBytes: receipt.executableSizeBytes, executable: true },
    }))
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      executableArtifactFingerprint,
      identifier: receipt.signedCode.identifier,
      teamIdentifier: receipt.signedCode.teamIdentifier,
      cdHash: receipt.signedCode.cdhash.toLowerCase(),
      designatedRequirement: receipt.signedCode.designatedRequirement,
    }
  } else if (receipt.portableFingerprintSchema === 'npm-composed-platform-surface-v1') {
    const packageName = receipt.packageProvenance.startsWith('npm_metadata:')
      ? receipt.packageProvenance.slice('npm_metadata:'.length)
      : ''
    const composition = receipt.npmPackage.composition
    const executable = receipt.npmPackage.proofNodes.find(node => node.role === 'npm_package_executable')
    if (!packageName || !composition || !executable || !executable.executable
      || executable.sha256 !== receipt.executableSha256 || executable.sizeBytes !== receipt.executableSizeBytes) {
      throw new Error('Agent release manifest has invalid composed npm executable')
    }
    const components = composition.components.map(component => ({
      role: component.role,
      installName: component.installName,
      manifestName: component.manifestName,
      version: component.version,
      integrity: component.integrity,
      ownedPackageSha256: component.ownedPackageSha256,
      ownedEntryCount: component.ownedEntryCount,
      ownedTotalBytes: component.ownedTotalBytes,
      nativeExecutableRelativePath: component.nativeExecutableRelativePath,
      nativeExecutableSha256: component.nativeExecutableSha256,
      nativeExecutableSizeBytes: component.nativeExecutableSizeBytes,
    }))
    const expectedDistribution = sha256Text(JSON.stringify({
      schema: 'npm-composed-owned-packages-v1',
      root: {
        packageName,
        integrity: receipt.npmPackage.integrity,
        ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
        ownedEntryCount: receipt.npmPackage.ownedEntryCount,
        ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
      },
      entryRule: composition.entryRule,
      components,
    }))
    if (receipt.distributionSha256 !== expectedDistribution) {
      throw new Error('Agent release manifest has invalid composed npm distribution digest')
    }
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      packageName,
      integrity: receipt.npmPackage.integrity,
      executable: file(executable),
      ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      ownedEntryCount: receipt.npmPackage.ownedEntryCount,
      ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
      entryRule: composition.entryRule,
      components,
    }
  } else if (receipt.portableFingerprintSchema === 'npm-owned-package-surface-v1') {
    const packageName = receipt.packageProvenance.startsWith('npm_metadata:')
      ? receipt.packageProvenance.slice('npm_metadata:'.length)
      : ''
    const treeNodes = receipt.npmPackage.proofNodes
    const executableNodes = treeNodes.filter(node => node.role === 'npm_package_executable')
    const manifestNodes = treeNodes.filter(node => node.role === 'package_manifest')
    const relativePaths = treeNodes.map(node => node.relativePath)
    if (!packageName || executableNodes.length !== 1 || manifestNodes.length !== 1
      || treeNodes.some(node => node.normalization !== 'raw' || node.role === 'npm_install_lock')
      || new Set(relativePaths).size !== relativePaths.length
      || JSON.stringify(relativePaths) !== JSON.stringify([...relativePaths].sort())) {
      throw new Error('Agent release manifest has invalid npm package surface topology')
    }
    if (receipt.npmPackage.ownedEntryCount < treeNodes.length
      || receipt.npmPackage.ownedTotalBytes < treeNodes.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)) {
      throw new Error('Agent release manifest has invalid npm owned package summary')
    }
    const executable = executableNodes[0]
    if (!executable.executable
      || executable.sha256 !== receipt.executableSha256
      || executable.sizeBytes !== receipt.executableSizeBytes) {
      throw new Error('Agent release manifest npm executable does not match its artifact receipt')
    }
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      packageName,
      integrity: receipt.npmPackage.integrity,
      executable: file(executable),
      ownedPackageSha256: receipt.npmPackage.ownedPackageSha256,
      ownedEntryCount: receipt.npmPackage.ownedEntryCount,
      ownedTotalBytes: receipt.npmPackage.ownedTotalBytes,
    }
  } else if (receipt.portableFingerprintSchema === 'signed-code-v1') {
    payload = {
      schema: receipt.portableFingerprintSchema,
      version: receipt.version,
      executable: { sha256: receipt.executableSha256, sizeBytes: receipt.executableSizeBytes, executable: true },
      identifier: receipt.signedCode.identifier,
      teamIdentifier: receipt.signedCode.teamIdentifier,
      cdHash: receipt.signedCode.cdhash.toLowerCase(),
      designatedRequirement: receipt.signedCode.designatedRequirement,
    }
  } else {
    throw new Error(`Agent release manifest has unsupported portable artifact schema: ${String(receipt.portableFingerprintSchema)}`)
  }
  return sha256Text(JSON.stringify(payload))
}

function parseComponentExpression(expression) {
  if (expression === 'ALL_COMPONENTS') return [...ALL_AGENT_COMPONENTS]
  if (expression === 'CORE_COMPONENTS') return [...CORE_AGENT_COMPONENTS]
  try {
    const parsed = JSON.parse(expression.replaceAll("'", '"'))
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
      throw new Error('not a string array')
    }
    return parsed
  } catch {
    throw new Error(`Agent release manifest has unsupported component expression: ${expression}`)
  }
}

function arrayContentsAfterMarker(source, marker, label) {
  const start = uniqueCodeMarkerIndex(source, marker, label)
  return contentsFromOpeningDelimiter(source, start + marker.length - 1, '[', ']', label)
}

function releaseEntriesSource(source) {
  return arrayContentsAfterMarker(
    source,
    'const AGENT_INTEGRATION_RELEASE_ENTRIES = Object.freeze([',
    'entry list',
  )
}

export function parseAgentIntegrationReleaseEntries(source) {
  const relocatableCatalogIds = new Set(JSON.parse(`[${arrayContentsAfterMarker(
    source,
    'CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS = Object.freeze([',
    'custom config root relocatable catalog IDs',
  ).replaceAll("'", '"')}]`))
  const entries = []
  for (const rawLine of releaseEntriesSource(source).split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const released = line.match(
      /^release\((["'])([^"']+)\1,\s*(["'])(managed|guided|migration)\3,\s*([0-4]),\s*(ALL_COMPONENTS|CORE_COMPONENTS|\[[^\]]*\]),\s*(\{.*\})\),?$/u,
    )
    if (released) {
      entries.push(releasedEntry(
        released[2],
        released[4],
        Number(released[5]),
        parseComponentExpression(released[6]),
        parseDetails(released[7], released[2]),
        relocatableCatalogIds,
      ))
      continue
    }
    const observed = line.match(/^observeOnly\((["'])([^"']+)\1,\s*(["'])([^"']*)\3,\s*(\{.*\})\),?$/u)
    if (observed) {
      entries.push(observeOnlyEntry(observed[2], observed[4], parseDetails(observed[5], observed[2])))
      continue
    }
    throw new Error(`Agent release manifest contains an unparseable entry: ${line}`)
  }
  if (entries.length === 0) throw new Error('Agent release manifest has no entries')
  if (new Set(entries.map(entry => entry.catalogId)).size !== entries.length) {
    throw new Error('Agent release manifest has duplicate entries')
  }
  return Object.freeze(entries)
}

export function parseSourceAgentIntegrationReleaseContract(source) {
  const version = parseDeclaredLiteral(
    source,
    'AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION =',
    /^\s*["']([^"']+)["']/u,
    'source app version',
  )
  const schemaVersion = Number(parseDeclaredLiteral(
    source,
    'AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION =',
    /^\s*(\d+)/u,
    'source schema version',
  ))
  validateReleaseHelper(source)
  validateObserveOnlyHelper(source)
  const manifestMarker = 'AGENT_INTEGRATION_RELEASE_MANIFEST = Object.freeze({'
  const manifestStart = uniqueCodeMarkerIndex(source, manifestMarker, 'versioned manifest object')
  const manifestObject = contentsFromOpeningDelimiter(
    source,
    manifestStart + manifestMarker.length - 1,
    '{',
    '}',
    'versioned manifest object',
  )
  const manifestShape = /^\s*schemaVersion:\s*AGENT_INTEGRATION_RELEASE_SCHEMA_VERSION,\s*appVersion:\s*AGENT_INTEGRATION_RELEASE_MANIFEST_VERSION,\s*features:\s*Object\.freeze\(\{\s*customLocalAgent:\s*Object\.freeze\(\{\s*enabledByDefault:\s*true,\s*modes:\s*Object\.freeze\(\[[\s\S]*?\](?:\s*as\s+const)?\),?\s*\}\),?\s*\}\),?\s*entries:\s*AGENT_INTEGRATION_RELEASE_ENTRIES,?\s*$/u
  if (!manifestShape.test(manifestObject)) {
    throw new Error('source Agent release manifest object has invalid fields or bindings')
  }
  let customModes
  try {
    customModes = JSON.parse(`[${arrayContentsAfterMarker(
      manifestObject,
      'modes: Object.freeze([',
      'source custom local Agent modes',
    ).replaceAll("'", '"')}]`)
  } catch {
    throw new Error('Agent release manifest custom modes are not a string array')
  }
  if (!Array.isArray(customModes)
    || customModes.some(value => typeof value !== 'string')
    || new Set(customModes).size !== customModes.length) {
    throw new Error('Agent release manifest custom modes are invalid')
  }
  return Object.freeze({
    version,
    schemaVersion,
    entries: parseAgentIntegrationReleaseEntries(source),
    customEnabled: true,
    customModes: Object.freeze(customModes),
  })
}
