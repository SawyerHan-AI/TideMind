import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectPassiveCliVersion,
  readStableFileFingerprint,
  readStableFileMetadata,
  readStableFileSnapshot,
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

describe('passive Agent CLI version inspection', () => {
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
      32 * 1024,
    )
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

  it('binds the exact official Qwen local launcher, contained target and package manifest', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-local-launcher-')))
    const launcher = path.join(root, 'bin', 'qwen')
    const target = path.join(root, 'lib', 'qwen-code', 'bin', 'qwen')
    const packageJson = path.join(root, 'lib', 'qwen-code', 'package.json')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(launcher, `#!/usr/bin/env sh\nexec '${target}' "$@"\n`, { mode: 0o700 })
    fs.writeFileSync(target, '#!/usr/bin/env sh\nexec qwen-runtime "$@"\n', { mode: 0o700 })
    fs.writeFileSync(packageJson, JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.21.13' }))
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
    }
    try {
      await expect(inspectPassiveCliVersion(launcher, port)).resolves.toMatchObject({
        exitCode: 0,
        stdout: '0.21.13',
        stderr: '',
        verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        packageMetadataFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageProofNodes: [
          expect.objectContaining({ role: 'qwen_launcher', path: launcher }),
          expect.objectContaining({ role: 'qwen_target', path: target }),
          expect.objectContaining({ role: 'package_manifest', path: packageJson }),
        ],
      })

      let snapshots = 0
      const replacementPort = {
        ...port,
        readStableFileSnapshot: async (targetPath: string, maxBytes: number) => {
          snapshots += 1
          if (snapshots === 3) {
            const replacement = `${target}.replacement`
            fs.writeFileSync(replacement, '#!/usr/bin/env sh\necho replaced\n', { mode: 0o700 })
            fs.renameSync(replacement, target)
          }
          return readStableFileSnapshot(targetPath, maxBytes)
        },
      }
      await expect(inspectPassiveCliVersion(launcher, replacementPort)).resolves.toMatchObject({
        exitCode: 126,
        stderr: 'qwen_launcher_surface_changed',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
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
