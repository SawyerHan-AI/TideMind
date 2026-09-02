import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Bytes, sha256Json, stableJson } from '../../client/electron/agent-integration/fingerprint'
import {
  ensureSafeParentDirectoryWithinRoot,
  FilePreconditionError,
  inspectRegularFile,
  inspectRegularFileWithinRoot,
  removeRegularFileAtomicCas,
  writeRegularFileAtomicCas,
} from '../../client/electron/agent-integration/safe-file'

describe('managed projection fingerprints', () => {
  it('canonicalizes object key order before hashing', () => {
    expect(stableJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(sha256Json({ b: 2, a: 1 })).toBe(sha256Json({ a: 1, b: 2 }))
  })
})

describe('writeRegularFileAtomicCas', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-safe-file-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates an absent file, fsyncs it and returns the read-back hash', () => {
    const target = path.join(root, 'config.json')
    const before = inspectRegularFile(target)

    const after = writeRegularFileAtomicCas(target, '{"ok":true}', {
      expectedContainerHash: null,
      expectedCanonicalPath: before.canonicalPath,
    })

    expect(after.containerHash).toBe(sha256Bytes('{"ok":true}'))
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}')
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(after.mode).toBe(0o600)
  })

  it('preserves the existing file mode on replace', () => {
    const target = path.join(root, 'config.json')
    fs.writeFileSync(target, 'old', { mode: 0o640 })
    // Creation mode is filtered through the process umask. Establish the
    // fixture permission explicitly so this test verifies replacement
    // preservation rather than the runner's ambient umask policy.
    fs.chmodSync(target, 0o640)
    const before = inspectRegularFile(target)

    const after = writeRegularFileAtomicCas(target, 'new', {
      expectedContainerHash: before.containerHash,
      expectedCanonicalPath: before.canonicalPath,
      expectedUid: before.uid ?? undefined,
    })

    expect(after.mode).toBe(0o640)
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
  })

  it('fails closed when the live container hash differs from the plan', () => {
    const target = path.join(root, 'config.json')
    fs.writeFileSync(target, 'user-edit')

    expect(() => writeRegularFileAtomicCas(target, 'managed', {
      expectedContainerHash: sha256Bytes('older-value'),
    })).toThrow(FilePreconditionError)
    expect(fs.readFileSync(target, 'utf8')).toBe('user-edit')
  })

  it('fails closed when absent create-if-absent finds an occupied target', () => {
    const target = path.join(root, 'config.json')
    fs.writeFileSync(target, 'occupied')

    expect(() => writeRegularFileAtomicCas(target, 'managed', {
      expectedContainerHash: null,
    })).toThrow(/changed since plan/)
    expect(fs.readFileSync(target, 'utf8')).toBe('occupied')
  })

  it('refuses a symbolic-link target without changing its destination', () => {
    const destination = path.join(root, 'destination.json')
    const target = path.join(root, 'config.json')
    fs.writeFileSync(destination, 'secret')
    fs.symlinkSync(destination, target)

    expect(() => inspectRegularFile(target)).toThrow(/symbolic-link/)
    expect(fs.readFileSync(destination, 'utf8')).toBe('secret')
  })

  it('requires an absolute target path', () => {
    expect(() => inspectRegularFile('relative/config.json')).toThrow(/must be absolute/)
  })

  it('plans and creates a file parent only inside an approved missing root', () => {
    const allowedRoot = path.join(root, 'new-host')
    const target = path.join(allowedRoot, 'nested', 'config.json')
    const before = inspectRegularFileWithinRoot(target, allowedRoot)
    expect(before).toMatchObject({ exists: false, containerHash: null })

    ensureSafeParentDirectoryWithinRoot(target, allowedRoot)
    const after = writeRegularFileAtomicCas(target, '{}', {
      expectedContainerHash: null,
      expectedCanonicalPath: before.canonicalPath,
    })
    expect(after.exists).toBe(true)
  })

  it('rejects a first-write target outside its approved config root', () => {
    expect(() => inspectRegularFileWithinRoot(
      path.join(root, 'other', 'config.json'),
      path.join(root, 'approved'),
    )).toThrow(/outside approved root/)
  })

  it('fails closed for whole-file removal because Node lacks dirfd-relative unlink', () => {
    const allowedRoot = path.join(root, 'approved')
    const managedParent = path.join(allowedRoot, 'nested')
    const target = path.join(managedParent, 'config.json')
    const outsideParent = path.join(root, 'outside')
    const outsideTarget = path.join(outsideParent, 'config.json')
    fs.mkdirSync(managedParent, { recursive: true })
    fs.mkdirSync(outsideParent)
    fs.writeFileSync(target, 'same-content')
    fs.writeFileSync(outsideTarget, 'same-content')
    const planned = inspectRegularFileWithinRoot(target, allowedRoot)

    expect(() => removeRegularFileAtomicCas(target, {
      allowedRoot,
      expectedCanonicalPath: planned.canonicalPath,
      expectedContainerHash: planned.containerHash!,
    })).toThrow(/safe dirfd-relative unlink primitive/)

    expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('same-content')
    expect(fs.readFileSync(target, 'utf8')).toBe('same-content')
  })
})
