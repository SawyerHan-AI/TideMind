import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectPassiveCliVersion,
  inspectPassiveCliVersionForArchitecture,
  normalizedQwenLauncherBytes,
  readStableFileFingerprint,
  readStableFileMetadata,
  readStableFileSnapshot,
  readStablePackageTree,
  verifyStablePackageTree,
  MAX_PACKAGE_TREE_DEPTH,
  MAX_PACKAGE_TREE_DIRECTORIES,
} from '../../client/electron/agent-integration/passive-cli-version'

function snapshot(content: string, overrides: Partial<{
  mode: number
  device: string
  inode: string
}> = {}) {
  const bytes = Buffer.from(content)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const mode = overrides.mode ?? 0o600
  const device = overrides.device ?? '1'
  const inode = overrides.inode ?? '2'
  const linkCount = '1'
  const mtimeNs = '1000000'
  const ctimeNs = '1000000'
  return {
    content: bytes,
    size: bytes.length,
    mode,
    device,
    inode,
    linkCount,
    mtimeNs,
    ctimeNs,
    sha256,
    fingerprint: createHash('sha256').update(JSON.stringify({
      device, inode, size: bytes.length, mode, linkCount, mtimeNs, ctimeNs, sha256,
    })).digest('hex'),
    executable: (mode & 0o111) !== 0,
  }
}

function physicalPort() {
  return {
    lstat: async (targetPath: string) => {
      try {
        const stat = fs.lstatSync(targetPath)
        return {
          kind: stat.isSymbolicLink()
            ? 'symbolic_link' as const
            : stat.isFile()
              ? 'file' as const
              : stat.isDirectory()
                ? 'directory' as const
                : 'other' as const,
          mode: stat.mode & 0o7777,
          ownerUid: String(stat.uid),
          groupGid: String(stat.gid),
        }
      } catch {
        return undefined
      }
    },
    realpath: async (targetPath: string) => fs.realpathSync(targetPath),
    readStableFileSnapshot,
    readStableFileFingerprint,
    readStablePackageTree,
    verifyStablePackageTree,
  }
}

describe('passive Agent CLI version inspection', () => {
  it('bounds package-tree depth and empty-directory floods', async () => {
    const depthRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-package-tree-depth-')))
    const floodRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-package-tree-dirs-')))
    try {
      let directory = depthRoot
      for (let index = 0; index <= MAX_PACKAGE_TREE_DEPTH; index += 1) {
        directory = path.join(directory, `d${index}`)
        fs.mkdirSync(directory, { mode: 0o700 })
      }
      await expect(readStablePackageTree(depthRoot)).rejects.toThrow('package_tree_directory_limit_exceeded')

      for (let index = 0; index < MAX_PACKAGE_TREE_DIRECTORIES; index += 1) {
        fs.mkdirSync(path.join(floodRoot, `d${index}`), { mode: 0o700 })
      }
      await expect(readStablePackageTree(floodRoot)).rejects.toThrow('package_tree_directory_limit_exceeded')
    } finally {
      fs.rmSync(depthRoot, { recursive: true, force: true })
      fs.rmSync(floodRoot, { recursive: true, force: true })
    }
  })

  it('streams a native-sized executable through a bounded stable descriptor proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stable-fingerprint-'))
    const executable = path.join(root, 'opencode')
    const size = 20 * 1024 * 1024
    const descriptor = fs.openSync(executable, 'w', 0o700)
    try {
      fs.ftruncateSync(descriptor, size)
      fs.writeSync(descriptor, Buffer.from('#!/bin/sh\n'), 0, 10, 0)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(executable, 0o700)
    try {
      const proof = await readStableFileFingerprint(executable, 32 * 1024 * 1024)
      expect(proof).toMatchObject({ size, executable: true, mode: 0o700 })
      expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(proof.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      await expect(readStableFileFingerprint(executable, 16 * 1024 * 1024))
        .rejects.toThrow('stable_fingerprint_exceeds_supported_distribution_limit')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('probes executable size and mode without reading file content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stable-metadata-'))
    const executable = path.join(root, 'opencode')
    const descriptor = fs.openSync(executable, 'w', 0o700)
    try {
      fs.ftruncateSync(descriptor, 512 * 1024 * 1024 + 1)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(executable, 0o700)
    try {
      const metadata = await readStableFileMetadata(executable)
      expect(metadata).toMatchObject({ size: 512 * 1024 * 1024 + 1, executable: true, mode: 0o700 })
      expect(metadata.device).toMatch(/^\d+$/u)
      expect(metadata.inode).toMatch(/^\d+$/u)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not follow an executable leaf symlink while producing a stable proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stable-fingerprint-link-'))
    const target = path.join(root, 'target')
    const link = path.join(root, 'opencode')
    fs.writeFileSync(target, 'native', { mode: 0o700 })
    fs.symlinkSync(target, link)
    try {
      await expect(readStableFileFingerprint(link, 1024)).rejects.toBeDefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads an exact npm package.json adjacent to a resolved executable', async () => {
    const packageJson = '/opt/lib/node_modules/@earendil-works/pi-coding-agent/package.json'
    const readStableFileSnapshot = vi.fn(async () => snapshot(JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.52.3',
    })))
    const result = await inspectPassiveCliVersion(
      '/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      {
        lstat: async () => ({ kind: 'file' }),
        realpath: async () => packageJson,
        readStableFileSnapshot,
      },
    )

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '0.52.3',
      stderr: '',
      verifiedPackageProvenance: 'npm_metadata:@earendil-works/pi-coding-agent',
      packageMetadataFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      packageProofNodes: [expect.objectContaining({
        role: 'package_manifest',
        path: packageJson,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    })
    expect(readStableFileSnapshot).toHaveBeenCalledWith(
      '/opt/lib/node_modules/@earendil-works/pi-coding-agent/package.json',
      512 * 1024,
    )
  })

  it.each([
    { packageName: '@moonshot-ai/kimi-code', version: '0.41.0', executableRelative: 'dist/cli.js' },
    { packageName: 'openclaw', version: '2026.8.1', executableRelative: 'dist/entry.js' },
    { packageName: '@earendil-works/pi-coding-agent', version: '0.52.12', executableRelative: 'dist/cli.js' },
  ])('binds $packageName npm provenance to registry integrity, executable and the full package tree', async ({
    packageName, version, executableRelative,
  }) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-npm-receipt-')))
    const nodeModules = path.join(root, 'lib', 'node_modules')
    const packageRoot = path.join(nodeModules, ...packageName.split('/'))
    const executable = path.join(packageRoot, executableRelative)
    const alternateExecutable = path.join(packageRoot, 'dist', 'alternate.js')
    const secondaryModule = path.join(packageRoot, 'dist', 'secondary.js')
    const zeroByteFile = path.join(packageRoot, 'patches', '.gitkeep')
    const ownedSymlink = path.join(packageRoot, 'bin', 'secondary')
    const nestedDependency = path.join(packageRoot, 'node_modules', 'dependency', 'index.js')
    const packageJson = path.join(packageRoot, 'package.json')
    const installLock = path.join(nodeModules, '.package-lock.json')
    const integrity = 'sha512-YWdlbnQtb2ZmaWNpYWwtYXJ0aWZhY3Q='
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(zeroByteFile), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(ownedSymlink), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(nestedDependency), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(alternateExecutable, '#!/usr/bin/env node\n', { mode: 0o700 })
    fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
    fs.writeFileSync(zeroByteFile, '', { mode: 0o600 })
    fs.writeFileSync(nestedDependency, 'dependency-v1\n', { mode: 0o600 })
    fs.symlinkSync('../dist/secondary.js', ownedSymlink)
    fs.writeFileSync(packageJson, JSON.stringify({ name: packageName, version }), { mode: 0o600 })
    fs.writeFileSync(installLock, JSON.stringify({
      lockfileVersion: 3,
      packages: { [`node_modules/${packageName}`]: { version, integrity } },
    }), { mode: 0o600 })
    try {
      const first = await inspectPassiveCliVersion(executable, physicalPort())
      expect(first).toMatchObject({
        exitCode: 0,
        stdout: version,
        verifiedPackageProvenance: `npm_metadata:${packageName}`,
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: expect.arrayContaining([
          expect.objectContaining({ role: 'npm_install_lock', path: installLock }),
          expect.objectContaining({ role: 'npm_package_executable', path: executable }),
          expect.objectContaining({ role: 'npm_package_file', path: secondaryModule }),
          expect.objectContaining({
            role: 'npm_package_file', path: ownedSymlink,
            entryType: 'symlink', symlinkTarget: '../dist/secondary.js', size: 20,
          }),
          expect.objectContaining({ role: 'npm_package_file', path: zeroByteFile, size: 0 }),
          expect.objectContaining({ role: 'package_manifest', path: packageJson }),
        ]),
      })
      expect(first.packageProofNodes).not.toContainEqual(expect.objectContaining({ path: nestedDependency }))
      const ownedSymlinkProof = first.packageProofNodes?.find(node => node.path === ownedSymlink)
      expect(ownedSymlinkProof).toMatchObject({
        role: 'npm_package_file', entryType: 'symlink', symlinkTarget: '../dist/secondary.js',
      })
      expect([String(process.getuid?.()), '0']).toContain(ownedSymlinkProof?.ownerUid)
      if (process.platform === 'linux') expect(ownedSymlinkProof?.mode).toBe(0o777)

      fs.chmodSync(secondaryModule, 0o620)
      const unsafeRegularFile = await inspectPassiveCliVersion(executable, physicalPort())
      expect(unsafeRegularFile.portableArtifactFingerprint).toBeUndefined()
      expect(unsafeRegularFile.packageProofNodes).toEqual([
        expect.objectContaining({ role: 'package_manifest', path: packageJson }),
      ])
      fs.chmodSync(secondaryModule, 0o600)

      const alternate = await inspectPassiveCliVersion(alternateExecutable, physicalPort())
      expect(alternate.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(alternate.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)

      fs.writeFileSync(nestedDependency, 'dependency-v2\n', { mode: 0o600 })
      const dependencyChanged = await inspectPassiveCliVersion(executable, physicalPort())
      expect(dependencyChanged.portableArtifactFingerprint).toBe(first.portableArtifactFingerprint)

      fs.writeFileSync(secondaryModule, 'export const secondary = false\n', { mode: 0o600 })
      const changed = await inspectPassiveCliVersion(executable, physicalPort())
      expect(changed.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(changed.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)

      fs.unlinkSync(ownedSymlink)
      fs.symlinkSync('../../outside-package.js', ownedSymlink)
      const escapedSymlink = await inspectPassiveCliVersion(executable, physicalPort())
      expect(escapedSymlink.portableArtifactFingerprint).toBeUndefined()
      fs.unlinkSync(ownedSymlink)
      fs.symlinkSync('../dist/secondary.js', ownedSymlink)

      fs.writeFileSync(installLock, JSON.stringify({
        lockfileVersion: 3,
        packages: { [`node_modules/${packageName}`]: { version } },
      }), { mode: 0o600 })
      const missingIntegrity = await inspectPassiveCliVersion(executable, physicalPort())
      expect(missingIntegrity).toMatchObject({
        exitCode: 0,
        verifiedPackageProvenance: `npm_metadata:${packageName}`,
      })
      expect(missingIntegrity.portableArtifactFingerprint).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds the installed root and exact platform leaf for a composed npm CLI', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-composed-npm-')))
    const nodeModules = path.join(root, 'lib', 'node_modules')
    const rootPackage = path.join(nodeModules, '@anthropic-ai', 'claude-code')
    const architecture = process.arch === 'x64' ? 'x64' : 'arm64'
    const leafName = `@anthropic-ai/claude-code-darwin-${architecture}`
    const leafPackage = path.join(rootPackage, 'node_modules', ...leafName.split('/'))
    const executable = path.join(rootPackage, 'bin', 'claude.exe')
    const leafExecutable = path.join(leafPackage, 'claude')
    const version = '2.1.261'
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(leafPackage, { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, 'native-v1', { mode: 0o700 })
    fs.writeFileSync(leafExecutable, 'native-v1', { mode: 0o700 })
    fs.writeFileSync(path.join(rootPackage, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }))
    fs.writeFileSync(path.join(leafPackage, 'package.json'), JSON.stringify({ name: leafName, version, os: ['darwin'], cpu: [architecture] }))
    fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@anthropic-ai/claude-code': { version, integrity: 'sha512-cm9vdA==' },
        [`node_modules/@anthropic-ai/claude-code/node_modules/${leafName}`]: { version, integrity: 'sha512-bGVhZg==' },
      },
    }))
    try {
      const first = await inspectPassiveCliVersion(executable, physicalPort())
      expect(first).toMatchObject({
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        npmComposition: {
          entryRule: 'copy_platform_binary_v1',
          components: [expect.objectContaining({ installName: leafName, nativeExecutableSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })],
        },
      })
      fs.writeFileSync(leafExecutable, 'native-v2', { mode: 0o700 })
      const tampered = await inspectPassiveCliVersion(executable, physicalPort())
      expect(tampered.portableArtifactFingerprint).toBeUndefined()
      expect(tampered.packageProofNodes).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'Codex alias leaf', architecture: 'x64' as const,
      packageName: '@openai/codex', version: '0.153.4', executableRelative: 'bin/codex.js',
      components: [{
        role: 'platform_leaf', installName: '@openai/codex-darwin-x64', manifestName: '@openai/codex',
        version: '0.153.4-darwin-x64', native: 'vendor/x86_64-apple-darwin/bin/codex', copy: false,
      }],
    },
    ...(['opencode-ai', '@opencode-ai/cli'] as const).flatMap(packageName =>
      (['arm64', 'x64'] as const).flatMap(architecture =>
        (architecture === 'x64' && packageName === '@opencode-ai/cli'
          ? ['modern', 'baseline'] as const
          : ['modern'] as const).map(variant => {
          const scoped = packageName.startsWith('@')
          const command = scoped ? 'opencode2' : 'opencode'
          const leafPrefix = scoped ? '@opencode-ai/cli' : 'opencode'
          const leafNames = architecture === 'x64'
            ? [`${leafPrefix}-darwin-x64`, `${leafPrefix}-darwin-x64-baseline`]
            : [`${leafPrefix}-darwin-arm64`]
          return {
            label: `${packageName} ${architecture} ${variant}`,
            architecture,
            packageName,
            version: scoped ? '0.0.0-beta-19157' : '1.18.29',
            executableRelative: `bin/${command}.exe`,
            components: leafNames.map(installName => ({
              role: 'platform_leaf', installName, manifestName: installName,
              version: scoped ? '0.0.0-beta-19157' : '1.18.29', native: `bin/${command}`,
              copy: architecture !== 'x64' || !scoped
                || installName.endsWith(variant === 'baseline' ? '-baseline' : '-x64'),
            })),
          }
        })),
    ),
    {
      label: 'OMP selector and leaf', architecture: 'arm64' as const,
      packageName: '@oh-my-pi/pi-coding-agent', version: '18.1.11', executableRelative: 'dist/cli.js',
      components: [
        { role: 'platform_selector', installName: '@oh-my-pi/pi-natives', manifestName: '@oh-my-pi/pi-natives', version: '18.1.11', native: null, copy: false },
        { role: 'platform_leaf', installName: '@oh-my-pi/pi-natives-darwin-arm64', manifestName: '@oh-my-pi/pi-natives-darwin-arm64', version: '18.1.11', native: 'pi_natives.darwin-arm64.node', copy: false },
      ],
    },
    {
      label: 'OMP x64 selector and baseline-named leaf', architecture: 'x64' as const,
      packageName: '@oh-my-pi/pi-coding-agent', version: '18.1.11', executableRelative: 'dist/cli.js',
      components: [
        { role: 'platform_selector', installName: '@oh-my-pi/pi-natives', manifestName: '@oh-my-pi/pi-natives', version: '18.1.11', native: null, copy: false },
        { role: 'platform_leaf', installName: '@oh-my-pi/pi-natives-darwin-x64', manifestName: '@oh-my-pi/pi-natives-darwin-x64', version: '18.1.11', native: 'pi_natives.darwin-x64-baseline.node', copy: false },
      ],
    },
  ])('proves the physical hoisted composed topology: $label', async fixture => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-composed-hoisted-')))
    const nodeModules = path.join(root, 'node_modules')
    const packageRoot = path.join(nodeModules, ...fixture.packageName.split('/'))
    const executable = path.join(packageRoot, ...fixture.executableRelative.split('/'))
    const rootBytes = fixture.components.some(component => component.copy) ? 'copied-native' : 'root-entry'
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, rootBytes, { mode: 0o700 })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: fixture.packageName, version: fixture.version }))
    const packages: Record<string, { version: string; integrity: string }> = {
      [`node_modules/${fixture.packageName}`]: { version: fixture.version, integrity: 'sha512-cm9vdA==' },
    }
    for (const component of fixture.components) {
      const componentRoot = path.join(nodeModules, ...component.installName.split('/'))
      fs.mkdirSync(componentRoot, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(componentRoot, 'package.json'), JSON.stringify({
        name: component.manifestName, version: component.version,
        ...(component.role === 'platform_leaf' ? { os: ['darwin'], cpu: [fixture.architecture] } : {}),
      }))
      if (component.native) {
        const native = path.join(componentRoot, ...component.native.split('/'))
        fs.mkdirSync(path.dirname(native), { recursive: true, mode: 0o700 })
        fs.writeFileSync(native, component.copy ? rootBytes : 'platform-native', {
          mode: fixture.packageName === '@oh-my-pi/pi-coding-agent' ? 0o600 : 0o700,
        })
      }
      packages[`node_modules/${component.installName}`] = {
        version: component.version, integrity: `sha512-${Buffer.from(component.installName).toString('base64')}`,
      }
    }
    fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
    try {
      const result = await inspectPassiveCliVersionForArchitecture(executable, physicalPort(), fixture.architecture)
      expect(result).toMatchObject({
        stdout: fixture.version,
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        npmComposition: { components: expect.arrayContaining(fixture.components.map(component => (
          expect.objectContaining({ installName: component.installName, version: component.version })
        ))) },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['opencode-ai', [''], 'native', true],
    ['@opencode-ai/cli', [''], 'native', true],
    ['@opencode-ai/cli', ['', '-baseline'], 'native', true],
    ['@opencode-ai/cli', ['', '-baseline'], 'wrong-root', true],
    ['opencode-ai', ['', '-baseline'], 'native', false],
  ] as const)('fails closed for incomplete, ambiguous, wrong-entry or bad-integrity %s x64 leaves', async (
    packageName, suffixes, rootBytes, validIntegrity,
  ) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-opencode-dual-leaf-')))
    const nodeModules = path.join(root, 'node_modules')
    const packageRoot = path.join(nodeModules, ...packageName.split('/'))
    const scoped = packageName.startsWith('@')
    const command = scoped ? 'opencode2' : 'opencode'
    const leafPrefix = scoped ? '@opencode-ai/cli' : 'opencode'
    const version = scoped ? '0.0.0-beta-19157' : '1.18.29'
    const executable = path.join(packageRoot, 'bin', `${command}.exe`)
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, rootBytes, { mode: 0o700 })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version }))
    const packages: Record<string, { version: string; integrity: string }> = {
      [`node_modules/${packageName}`]: { version, integrity: 'sha512-cm9vdA==' },
    }
    for (const suffix of suffixes) {
      const leafName = `${leafPrefix}-darwin-x64${suffix}`
      const leafRoot = path.join(nodeModules, ...leafName.split('/'))
      fs.mkdirSync(path.join(leafRoot, 'bin'), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(leafRoot, 'bin', command), 'native', { mode: 0o700 })
      fs.writeFileSync(path.join(leafRoot, 'package.json'), JSON.stringify({ name: leafName, version, os: ['darwin'], cpu: ['x64'] }))
      packages[`node_modules/${leafName}`] = {
        version,
        integrity: validIntegrity || suffix === ''
          ? `sha512-${Buffer.from(leafName).toString('base64')}`
          : 'invalid-integrity',
      }
    }
    fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
    try {
      const result = await inspectPassiveCliVersionForArchitecture(executable, physicalPort(), 'x64')
      expect(result.portableArtifactFingerprint).toBeUndefined()
      expect(result.npmComposition).toBeUndefined()
      expect(result.packageProofNodes).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a package identity mismatch instead of trusting unrelated metadata', async () => {
    const packageJson = '/opt/lib/node_modules/@qwen-code/qwen-code/package.json'
    const result = await inspectPassiveCliVersion(
      '/opt/lib/node_modules/@qwen-code/qwen-code/dist/cli.js',
      {
        lstat: async () => ({ kind: 'file' }),
        realpath: async () => packageJson,
        readStableFileSnapshot: async () => snapshot(JSON.stringify({ name: '@attacker/qwen-code', version: '9.9.9' })),
      },
    )

    expect(result).toEqual({
      exitCode: 126,
      stdout: '',
      stderr: 'package_metadata_identity_mismatch',
    })
  })

  it('binds the exact official Qwen 0.23.0 relative-root launcher and complete standalone root', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qwen-'local-launcher-")))
    const installerBin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-installer-bin-')))
    const launcher = path.join(root, 'bin', 'qwen')
    const packageJson = path.join(root, 'package.json')
    const packageRoot = root
    const standaloneManifest = path.join(packageRoot, 'manifest.json')
    const cliEntry = path.join(packageRoot, 'lib', 'cli-entry.js')
    const nestedRuntime = path.join(packageRoot, 'lib', 'node_modules', '@qwen-code', 'runtime.js')
    const nodeRuntime = path.join(packageRoot, 'node', 'bin', 'node')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true })
    fs.mkdirSync(path.dirname(nestedRuntime), { recursive: true })
    fs.mkdirSync(path.dirname(nodeRuntime), { recursive: true })
    const officialLauncher = normalizedQwenLauncherBytes()
    fs.writeFileSync(launcher, officialLauncher, { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.23.0' }))
    fs.writeFileSync(standaloneManifest, JSON.stringify({
      name: '@qwen-code/qwen-code',
      version: '0.23.0',
      target: `darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
      runtime: 'node',
      nodeArchive: `node-v22.0.0-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}.tar.gz`,
    }))
    fs.writeFileSync(cliEntry, 'export async function main() {}\n')
    fs.writeFileSync(nestedRuntime, 'export const runtime = true\n')
    fs.writeFileSync(nodeRuntime, 'official-node-runtime', { mode: 0o700 })
    const port = {
      lstat: async (targetPath: string) => {
        try {
          const stat = fs.lstatSync(targetPath)
          return { kind: stat.isSymbolicLink() ? 'symbolic_link' as const : stat.isFile() ? 'file' as const : 'directory' as const }
        } catch {
          return undefined
        }
      },
      realpath: async (targetPath: string) => fs.realpathSync(targetPath),
      readStableFileSnapshot,
      readStableFileFingerprint,
      readStablePackageTree,
      verifyStablePackageTree,
    }
    try {
      const first = await inspectPassiveCliVersion(launcher, port)
      expect(first).toMatchObject({
        exitCode: 0,
        stdout: '0.23.0',
        stderr: '',
        verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        packageMetadataFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: expect.arrayContaining([
          expect.objectContaining({ role: 'qwen_launcher', path: launcher }),
          expect.objectContaining({ role: 'qwen_cli_entry', path: cliEntry }),
          expect.objectContaining({ role: 'qwen_standalone_manifest', path: standaloneManifest }),
          expect.objectContaining({ role: 'qwen_node_runtime', path: nodeRuntime }),
          expect.objectContaining({ role: 'qwen_package_file', path: nestedRuntime }),
          expect.objectContaining({ role: 'package_manifest', path: packageJson }),
        ]),
      })

      const installerShim = path.join(installerBin, 'qwen')
      const quotedLauncher = `'${launcher.replaceAll("'", "'\\''")}'`
      fs.writeFileSync(installerShim, `#!/usr/bin/env sh\nexec ${quotedLauncher} "$@"\n`, { mode: 0o700 })
      const installed = await inspectPassiveCliVersion(installerShim, port)
      expect(installed).toMatchObject({
        exitCode: 0,
        stdout: '0.23.0',
        portableArtifactFingerprint: first.portableArtifactFingerprint,
        packageTreeSha256: first.packageTreeSha256,
        packageProofNodes: expect.arrayContaining([
          expect.objectContaining({ role: 'qwen_launcher', path: installerShim }),
          expect.objectContaining({ role: 'qwen_inner_launcher', path: launcher }),
        ]),
      })
      expect(installed.packageProofNodes?.filter(node => node.role === 'qwen_launcher')).toHaveLength(1)

      fs.writeFileSync(installerShim, `#!/usr/bin/env sh\nexec ${quotedLauncher} "$@"\necho injected\n`, { mode: 0o700 })
      await expect(inspectPassiveCliVersion(installerShim, port)).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'qwen_launcher_identity_mismatch',
      })
      const nonCanonicalTarget = `${path.dirname(launcher)}/../bin/qwen`
      fs.writeFileSync(installerShim, `#!/usr/bin/env sh\nexec '${nonCanonicalTarget}' "$@"\n`, { mode: 0o700 })
      await expect(inspectPassiveCliVersion(installerShim, port)).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'qwen_launcher_identity_mismatch',
      })
      fs.writeFileSync(installerShim, `#!/usr/bin/env sh\nexec ${quotedLauncher} "$@"\n`, { mode: 0o700 })

      const crossArchitecture = process.arch === 'x64' ? 'arm64' : 'x64'
      fs.writeFileSync(standaloneManifest, JSON.stringify({
        name: '@qwen-code/qwen-code',
        version: '0.23.0',
        target: `darwin-${crossArchitecture}`,
        runtime: 'node',
        nodeArchive: `node-v22.0.0-darwin-${crossArchitecture}.tar.gz`,
      }))
      const crossArchitectureResult = await inspectPassiveCliVersionForArchitecture(
        launcher,
        port,
        crossArchitecture,
      )
      expect(crossArchitectureResult).toMatchObject({
        exitCode: 0,
        stdout: '0.23.0',
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: expect.arrayContaining([
          expect.objectContaining({ role: 'qwen_node_runtime', path: nodeRuntime }),
        ]),
      })
      fs.writeFileSync(standaloneManifest, JSON.stringify({
        name: '@qwen-code/qwen-code',
        version: '0.23.0',
        target: `darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
        runtime: 'node',
        nodeArchive: `node-v22.0.0-darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}.tar.gz`,
      }))

      fs.writeFileSync(cliEntry, 'export async function main() { return false }\n')
      const changedOwnedModule = await inspectPassiveCliVersion(launcher, port)
      expect(changedOwnedModule.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(changedOwnedModule.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)
      fs.writeFileSync(cliEntry, 'export async function main() {}\n')

      fs.writeFileSync(nestedRuntime, 'export const runtime = false\n')
      const changedNestedRuntime = await inspectPassiveCliVersion(launcher, port)
      expect(changedNestedRuntime.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(changedNestedRuntime.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)
      fs.writeFileSync(nestedRuntime, 'export const runtime = true\n')

      fs.writeFileSync(nodeRuntime, 'different-node-runtime', { mode: 0o700 })
      const changedNode = await inspectPassiveCliVersion(launcher, port)
      expect(changedNode.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(changedNode.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)
      fs.writeFileSync(nodeRuntime, 'official-node-runtime', { mode: 0o700 })

      fs.writeFileSync(path.join(packageRoot, 'unexpected-command.sh'), 'echo injected\n')
      const changedOwnedRoot = await inspectPassiveCliVersion(launcher, port)
      expect(changedOwnedRoot.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(changedOwnedRoot.portableArtifactFingerprint).not.toBe(first.portableArtifactFingerprint)
      fs.rmSync(path.join(packageRoot, 'unexpected-command.sh'))

      const tamperedLaunchers = [
        `${officialLauncher.toString('utf8')}echo injected\n`,
        officialLauncher.toString('utf8').replace('QWEN_CODE_LAUNCHER_PATH="$ROOT/bin/qwen"', 'QWEN_CODE_LAUNCHER_PATH="${QWEN_OVERRIDE:-$ROOT/bin/qwen}"'),
        officialLauncher.toString('utf8').replace('"$ROOT/node/bin/node"', '"/Users/attacker/node"'),
        officialLauncher.toString('utf8').replace('"$ROOT/node/bin/node"', '"$ROOT/../node/bin/node"'),
        officialLauncher.toString('utf8').replace('"$ROOT/lib/cli-entry.js"', '"$ROOT/lib/other.js"'),
      ]
      for (const tamperedLauncher of tamperedLaunchers) {
        fs.writeFileSync(launcher, tamperedLauncher, { mode: 0o700 })
        await expect(inspectPassiveCliVersion(launcher, port)).resolves.toMatchObject({
          exitCode: 126,
          stderr: 'qwen_launcher_identity_mismatch',
        })
      }
      fs.writeFileSync(launcher, officialLauncher, { mode: 0o700 })

      let cliEntryReads = 0
      const replacementPort = {
        ...port,
        readStableFileSnapshot: async (targetPath: string, maxBytes: number) => {
          const stable = await readStableFileSnapshot(targetPath, maxBytes)
          if (targetPath === cliEntry && ++cliEntryReads === 1) {
            const replacement = `${cliEntry}.replacement`
            fs.writeFileSync(replacement, '#!/usr/bin/env sh\necho replaced\n', { mode: 0o700 })
            fs.renameSync(replacement, cliEntry)
          }
          return stable
        },
      }
      await expect(inspectPassiveCliVersion(launcher, replacementPort)).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'qwen_launcher_surface_changed',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(installerBin, { recursive: true, force: true })
    }
  })

  it('reports the installed Kimi native updater pair only as non-authoritative local state', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-native-updater-')))
    const root = path.join(home, '.kimi-code')
    const executable = path.join(root, 'bin', 'kimi')
    const installJson = path.join(root, 'updates', 'install.json')
    const latestJson = path.join(root, 'updates', 'latest.json')
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(installJson), { recursive: true, mode: 0o700 })
    fs.writeFileSync(executable, 'signed-native-fixture', { mode: 0o700 })
    fs.writeFileSync(installJson, JSON.stringify({
      active: null,
      lastFailure: null,
      lastSuccess: { version: '0.40.1', installedAt: '2026-09-03T07:38:44.514Z' },
    }), { mode: 0o600 })
    fs.writeFileSync(latestJson, JSON.stringify({
      source: 'cdn', checkedAt: '2026-09-03T07:56:14.443Z', latest: '0.41.0',
      manifest: { version: '0.41.0', publishedAt: '2026-09-04T10:31:46Z' },
    }), { mode: 0o600 })
    try {
      const state = await inspectPassiveCliVersion(executable, physicalPort())
      expect(state).toMatchObject({
        exitCode: 0,
        stdout: '0.40.1',
        verifiedPackageProvenance: 'local_updater_state:kimi',
        packageMetadataFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: [
          expect.objectContaining({ role: 'kimi_install_metadata', path: installJson }),
          expect.objectContaining({ role: 'kimi_latest_metadata', path: latestJson }),
        ],
      })
      expect(state).not.toHaveProperty('portableArtifactFingerprint')

      fs.chmodSync(latestJson, 0o666)
      await expect(inspectPassiveCliVersion(executable, physicalPort())).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'kimi_updater_surface_not_canonical',
      })
      fs.chmodSync(latestJson, 0o600)

      fs.writeFileSync(latestJson, JSON.stringify({
        source: 'cdn', checkedAt: '2026-09-03T07:56:14.443Z', latest: '9.9.9',
        manifest: { version: '0.41.0', publishedAt: '2026-09-04T10:31:46Z' },
      }), { mode: 0o600 })
      await expect(inspectPassiveCliVersion(executable, physicalPort())).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'kimi_updater_metadata_identity_mismatch',
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a Kimi updater metadata or binary generation swap during passive inspection', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-native-swap-')))
    const root = path.join(home, '.kimi-code')
    const executable = path.join(root, 'bin', 'kimi')
    const installJson = path.join(root, 'updates', 'install.json')
    const latestJson = path.join(root, 'updates', 'latest.json')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(installJson), { recursive: true })
    fs.writeFileSync(executable, 'native-one', { mode: 0o700 })
    fs.writeFileSync(installJson, JSON.stringify({ lastSuccess: { version: '0.40.1', installedAt: '2026-09-03T07:38:44.514Z' } }), { mode: 0o600 })
    fs.writeFileSync(latestJson, JSON.stringify({ source: 'cdn', checkedAt: '2026-09-03T07:56:14.443Z', latest: '0.40.1', manifest: { version: '0.40.1', publishedAt: '2026-09-02T10:31:46Z' } }), { mode: 0o600 })
    const port = physicalPort()
    let fingerprints = 0
    try {
      await expect(inspectPassiveCliVersion(executable, {
        ...port,
        readStableFileFingerprint: async (targetPath, maxBytes) => {
          fingerprints += 1
          if (fingerprints === 2) {
            const replacement = `${executable}.new`
            fs.writeFileSync(replacement, 'native-two', { mode: 0o700 })
            fs.renameSync(replacement, executable)
          }
          return readStableFileFingerprint(targetPath, maxBytes)
        },
      })).resolves.toMatchObject({ exitCode: 126, stderr: 'kimi_updater_surface_changed' })

      fs.writeFileSync(executable, 'native-stable', { mode: 0o700 })
      let installReads = 0
      await expect(inspectPassiveCliVersion(executable, {
        ...port,
        readStableFileSnapshot: async (targetPath, maxBytes) => {
          if (targetPath === installJson) {
            installReads += 1
            if (installReads === 2) {
              const replacement = `${installJson}.new`
              fs.writeFileSync(replacement, JSON.stringify({ lastSuccess: { version: '0.41.0', installedAt: '2026-09-04T07:38:44.514Z' } }), { mode: 0o600 })
              fs.renameSync(replacement, installJson)
            }
          }
          return readStableFileSnapshot(targetPath, maxBytes)
        },
      })).resolves.toMatchObject({ exitCode: 126, stderr: 'kimi_updater_surface_changed' })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('accepts only the official OpenClaw wrapper and its contained toolchain package', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-wrapper-')))
    const root = path.join(home, 'custom-openclaw-prefix')
    const wrapper = path.join(root, 'bin', 'openclaw')
    const toolchain = path.join(root, 'tools', 'node-v24.19.0')
    const node = path.join(toolchain, 'bin', 'node')
    const entry = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'entry.js')
    const secondaryModule = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'secondary.js')
    const packageJson = path.join(toolchain, 'lib', 'node_modules', 'openclaw', 'package.json')
    fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(node), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 })
    fs.symlinkSync(toolchain, path.join(root, 'tools', 'node'))
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(root, 'tools', 'node', 'bin', 'node')}" "${entry}" "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(node, 'official-node-runtime', { mode: 0o700 })
    fs.writeFileSync(entry, 'export async function main() {}\n', { mode: 0o600 })
    fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: 'openclaw', version: '2026.8.1', type: 'module', bin: { openclaw: 'openclaw.mjs' } }), { mode: 0o600 })
    try {
      const first = await inspectPassiveCliVersion(wrapper, physicalPort())
      expect(first).toMatchObject({
        exitCode: 0,
        stdout: '2026.8.1',
        verifiedPackageProvenance: 'npm_metadata:openclaw',
        portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: expect.arrayContaining([
          expect.objectContaining({ role: 'openclaw_wrapper', path: wrapper }),
          expect.objectContaining({ role: 'openclaw_node_runtime', path: node }),
          expect.objectContaining({ role: 'openclaw_entry', path: entry }),
          expect.objectContaining({ role: 'openclaw_package_file', path: secondaryModule }),
          expect.objectContaining({ role: 'package_manifest', path: packageJson }),
        ]),
      })

      const relocatedRoot = path.join(home, 'other-openclaw-prefix')
      const relocatedWrapper = path.join(relocatedRoot, 'bin', 'openclaw')
      const relocatedToolchain = path.join(relocatedRoot, 'tools', 'node-v24.19.0')
      const relocatedNode = path.join(relocatedToolchain, 'bin', 'node')
      const relocatedEntry = path.join(relocatedToolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'entry.js')
      const relocatedSecondaryModule = path.join(relocatedToolchain, 'lib', 'node_modules', 'openclaw', 'dist', 'secondary.js')
      const relocatedPackageJson = path.join(relocatedToolchain, 'lib', 'node_modules', 'openclaw', 'package.json')
      fs.mkdirSync(path.dirname(relocatedWrapper), { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.dirname(relocatedNode), { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.dirname(relocatedEntry), { recursive: true, mode: 0o700 })
      fs.symlinkSync(relocatedToolchain, path.join(relocatedRoot, 'tools', 'node'))
      fs.writeFileSync(relocatedWrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(relocatedRoot, 'tools', 'node', 'bin', 'node')}" "${relocatedEntry}" "$@"\n`, { mode: 0o700 })
      fs.writeFileSync(relocatedNode, 'official-node-runtime', { mode: 0o700 })
      fs.writeFileSync(relocatedEntry, 'export async function main() {}\n', { mode: 0o600 })
      fs.writeFileSync(relocatedSecondaryModule, 'export const secondary = true\n', { mode: 0o600 })
      fs.writeFileSync(relocatedPackageJson, JSON.stringify({ name: 'openclaw', version: '2026.8.1', type: 'module', bin: { openclaw: 'openclaw.mjs' } }), { mode: 0o600 })
      const relocated = await inspectPassiveCliVersion(relocatedWrapper, physicalPort())
      expect(relocated.portableArtifactFingerprint).toBe(first.portableArtifactFingerprint)
      expect(relocated.packageMetadataFingerprint).not.toBe(first.packageMetadataFingerprint)

      let mutatedAfterSnapshot = false
      const treeRacePort = physicalPort()
      await expect(inspectPassiveCliVersion(wrapper, {
        ...treeRacePort,
        verifyStablePackageTree: async (targetPath, snapshot) => {
          if (!mutatedAfterSnapshot) {
            mutatedAfterSnapshot = true
            fs.writeFileSync(secondaryModule, 'export const secondary = false\n', { mode: 0o600 })
          }
          return verifyStablePackageTree(targetPath, snapshot)
        },
      })).resolves.toMatchObject({ exitCode: 126, stderr: 'openclaw_wrapper_surface_changed' })
      fs.writeFileSync(secondaryModule, 'export const secondary = true\n', { mode: 0o600 })

      fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexport NODE_OPTIONS=--require=/tmp/evil.js\nexec "${node}" "${entry}" "$@"\n`, { mode: 0o700 })
      await expect(inspectPassiveCliVersion(wrapper, physicalPort())).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'openclaw_wrapper_identity_mismatch',
      })

      fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${node}" "/tmp/entry.js" "$@"\n`, { mode: 0o700 })
      await expect(inspectPassiveCliVersion(wrapper, physicalPort())).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'openclaw_wrapper_path_escape',
      })

      fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail\nexec "${path.join(root, 'tools', 'node', 'bin', 'node')}" "${entry}" "$@"\n`, { mode: 0o700 })
      let entryReads = 0
      const port = physicalPort()
      await expect(inspectPassiveCliVersion(wrapper, {
        ...port,
        readStableFileSnapshot: async (targetPath, maxBytes) => {
          if (targetPath === entry) {
            entryReads += 1
            if (entryReads === 2) {
              const replacement = `${entry}.new`
              fs.writeFileSync(replacement, 'export const attacker = true\n', { mode: 0o600 })
              fs.renameSync(replacement, entry)
            }
          }
          return readStableFileSnapshot(targetPath, maxBytes)
        },
      })).resolves.toMatchObject({ exitCode: 126, stderr: 'openclaw_wrapper_surface_changed' })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('parses bounded Homebrew and managed-release paths without executing the binary', async () => {
    const fs = { lstat: vi.fn(), realpath: vi.fn(), readStableFileSnapshot: vi.fn() }
    await expect(inspectPassiveCliVersion('/opt/homebrew/Cellar/codex/0.145.0/bin/codex', fs))
      .resolves.toEqual({ exitCode: 0, stdout: '0.145.0', stderr: '' })
    await expect(inspectPassiveCliVersion('/Users/me/.local/share/claude/versions/2.1.245', fs))
      .resolves.toEqual({ exitCode: 0, stdout: '2.1.245', stderr: '' })
    expect(fs.readStableFileSnapshot).not.toHaveBeenCalled()
  })

  it('fails closed when no bounded version metadata is available', async () => {
    const fs = { lstat: vi.fn(), realpath: vi.fn(), readStableFileSnapshot: vi.fn() }
    await expect(inspectPassiveCliVersion('/Users/me/.kimi-code/bin/kimi', fs))
      .resolves.toEqual({
        exitCode: 126,
        stdout: '',
        stderr: 'passive_version_metadata_unavailable',
      })
  })

  it('does not treat a symlinked or relocated package manifest as distribution proof', async () => {
    const executable = '/tmp/fake/node_modules/@openai/codex/bin/codex.js'
    const packageJson = '/tmp/fake/node_modules/@openai/codex/package.json'
    await expect(inspectPassiveCliVersion(executable, {
      lstat: async () => undefined,
      realpath: vi.fn(),
      readStableFileSnapshot: vi.fn(),
    })).resolves.toMatchObject({ exitCode: 126, stderr: 'package_metadata_not_regular_file' })

    await expect(inspectPassiveCliVersion(executable, {
      lstat: async () => ({ kind: 'symbolic_link' }),
      realpath: async () => '/tmp/attacker/package.json',
      readStableFileSnapshot: vi.fn(),
    })).resolves.toMatchObject({ exitCode: 126, stderr: 'package_metadata_not_regular_file' })

    await expect(inspectPassiveCliVersion(executable, {
      lstat: async () => ({ kind: 'file' }),
      realpath: async () => '/tmp/attacker/package.json',
      readStableFileSnapshot: vi.fn(),
    })).resolves.toMatchObject({ exitCode: 126, stderr: 'package_metadata_not_canonical' })
    expect(packageJson).toContain('/node_modules/@openai/codex/package.json')
  })

  it('never converts Cellar-shaped or managed-release paths into verified provenance', async () => {
    const fs = { lstat: vi.fn(), realpath: vi.fn(), readStableFileSnapshot: vi.fn() }
    const fakeCellar = await inspectPassiveCliVersion('/tmp/Cellar/codex/0.145.0/bin/codex', fs)
    const fakeUv = await inspectPassiveCliVersion('/tmp/uv/tools/kimi/releases/1.0.0/kimi', fs)

    expect(fakeCellar).toEqual({ exitCode: 0, stdout: '0.145.0', stderr: '' })
    expect(fakeUv).toEqual({ exitCode: 0, stdout: '1.0.0', stderr: '' })
    expect(fakeCellar.verifiedPackageProvenance).toBeUndefined()
    expect(fakeUv.verifiedPackageProvenance).toBeUndefined()
  })
})
