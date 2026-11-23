import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Bytes, sha256Json, stableJson } from '../../client/electron/agent-integration/fingerprint'
import {
  ensureSafeParentDirectoryWithinRoot,
  FilePreconditionError,
  inspectRegularFile,
  inspectRegularFileWithinRoot,
  removeRegularFileAtomicCas,
  writeRegularFileAtomicCas,
  readManagedTextSnapshot,
  assertManagedTextSnapshotCurrent,
} from '../../client/electron/agent-integration/safe-file'

describe('stable managed text readback', () => {
  let root: string
  let target: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-readback-')))
    target = path.join(root, 'config.toml')
    fs.writeFileSync(target, 'value = "synthetic"\n')
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  it('reads a bounded snapshot without rewriting the file and rechecks current bytes', () => {
    const before = fs.statSync(target, { bigint: true })
    const snapshot = readManagedTextSnapshot(target, root)
    expect(snapshot.content).toBe('value = "synthetic"\n')
    expect(snapshot.containerHash).toBe(sha256Bytes(snapshot.content))
    expect(fs.statSync(target, { bigint: true }).mtimeNs).toBe(before.mtimeNs)
    expect(() => assertManagedTextSnapshotCurrent(snapshot)).not.toThrow()
    fs.writeFileSync(target, 'value = "different"\n')
    expect(() => assertManagedTextSnapshotCurrent(snapshot)).toThrow(FilePreconditionError)
  })

  it('rejects replacing the same-content inode and symlink targets', () => {
    const snapshot = readManagedTextSnapshot(target, root)
    fs.renameSync(target, `${target}.previous`)
    fs.writeFileSync(target, snapshot.content)
    expect(() => assertManagedTextSnapshotCurrent(snapshot)).toThrow(FilePreconditionError)
    fs.unlinkSync(target)
    fs.symlinkSync(`${target}.previous`, target)
    expect(() => readManagedTextSnapshot(target, root)).toThrow(FilePreconditionError)
  })

  it('rejects changes during the descriptor read, then closes its descriptor', () => {
    const original = fs.readSync.bind(fs)
    let usedFd = -1
    let mutated = false
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      usedFd = args[0]
      const count = original(...args)
      if (!mutated) { mutated = true; fs.writeFileSync(target, 'concurrent edit\n') }
      return count
    })
    expect(() => readManagedTextSnapshot(target, root)).toThrow('Unable to obtain a stable managed text snapshot')
    expect(() => fs.fstatSync(usedFd)).toThrow()
  })

  it('rejects out-of-root, oversized and malformed UTF-8 inputs', () => {
    expect(() => readManagedTextSnapshot(target, path.join(root, 'unrelated'))).toThrow(FilePreconditionError)
    fs.truncateSync(target, 4 * 1024 * 1024 + 1)
    expect(() => readManagedTextSnapshot(target, root)).toThrow(FilePreconditionError)
    fs.writeFileSync(target, Buffer.from([0xff, 0xfe]))
    expect(() => readManagedTextSnapshot(target, root)).toThrow(FilePreconditionError)
  })
})

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
