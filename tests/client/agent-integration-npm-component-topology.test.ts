import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectPassiveCliVersionForArchitecture, readStableFileFingerprint, readStableFileSnapshot, readStablePackageTree, verifyStablePackageTree } from '../../client/electron/agent-integration/passive-cli-version'
import { npmComposedDistributionSpec } from '../../client/electron/agent-integration/npm-distribution-topology'
import { verifyNpmComponentLookupTopologySync } from '../../client/electron/agent-integration/npm-component-topology'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const port = {
  async lstat(file: string) {
    try {
      const stat = fs.lstatSync(file)
      return { kind: stat.isSymbolicLink() ? 'symbolic_link' as const : stat.isDirectory() ? 'directory' as const : stat.isFile() ? 'file' as const : 'other' as const,
        mode: stat.mode & 0o7777, ownerUid: String(stat.uid), groupGid: String(stat.gid) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  },
  async realpath(file: string) { return fs.realpathSync(file) },
  readStableFileFingerprint, readStableFileSnapshot, readStablePackageTree, verifyStablePackageTree,
}
function write(file: string, text: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, text, { mode })
}
function install(name: string, layout: 'nested' | 'hoisted' | 'selector-nested', locked: boolean, architecture: 'arm64' | 'x64' = 'arm64') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-lookup-fence-'))); roots.push(root)
  const nodeModules = path.join(root, 'node_modules')
  const packageRoot = path.join(nodeModules, ...name.split('/'))
  const version = name.startsWith('@oh-my-pi/') ? '18.1.11' : '1.2.3'
  const spec = npmComposedDistributionSpec(name, version, architecture)!
  const executable = path.join(packageRoot, ...spec.rootExecutableRelativePath.split('/'))
  const bytes = 'official-like fixture bytes'
  write(executable, bytes, 0o700)
  write(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version }))
  const packages: Record<string, { version: string; integrity: string }> = {
    [`node_modules/${name}`]: { version, integrity: 'sha512-cm9vdA==' },
  }
  const locations = new Map<string, string>()
  for (const component of spec.components) {
    let base = layout === 'hoisted' ? nodeModules : path.join(packageRoot, 'node_modules')
    if (layout === 'selector-nested' && component.role === 'platform_leaf') {
      base = path.join(locations.get('@oh-my-pi/pi-natives')!, 'node_modules')
    }
    const location = path.join(base, ...component.installName.split('/'))
    locations.set(component.installName, location)
    write(path.join(location, 'package.json'), JSON.stringify({ name: component.manifestName, version: component.version, os: ['darwin'], cpu: [architecture] }))
    if (component.role === 'platform_selector') write(path.join(location, 'native', 'loader-state.js'), '// frozen native loader location')
    if (component.nativeExecutableRelativePath) write(path.join(location, ...component.nativeExecutableRelativePath.split('/')), bytes,
      spec.entryRule === 'js_entry_loads_platform_native_v1' ? 0o600 : 0o700)
    packages[`node_modules/${path.relative(nodeModules, location).split(path.sep).join('/')}`] = { version: component.version, integrity: 'sha512-bGVhZg==' }
  }
  const lockPath = path.join(nodeModules, '.package-lock.json')
  const saveLock = () => { if (locked) write(lockPath, JSON.stringify({ lockfileVersion: 3, packages })) }
  saveLock()
  return { root, nodeModules, packageRoot, version, spec, executable, locations, packages, saveLock }
}
const inspect = (file: string) => inspectPassiveCliVersionForArchitecture(file, port, 'arm64')

for (const locked of [false, true]) {
  describe(locked ? 'locked lookup fence' : 'lockless lookup fence', () => {
    it.each([
      ['@anthropic-ai/claude-code', 'nested'], ['@anthropic-ai/claude-code', 'hoisted'],
      ['@openai/codex', 'nested'], ['@openai/codex', 'hoisted'],
      ['opencode-ai', 'nested'], ['opencode-ai', 'hoisted'],
      ['@opencode-ai/cli', 'nested'], ['@opencode-ai/cli', 'hoisted'],
      ['@oh-my-pi/pi-coding-agent', 'nested'], ['@oh-my-pi/pi-coding-agent', 'hoisted'],
      ['@oh-my-pi/pi-coding-agent', 'selector-nested'],
    ] as const)('preserves %s %s including installName aliases', async (name, layout) => {
      const fixture = install(name, layout, locked)
      const result = await inspect(fixture.executable)
      expect(result.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(verifyNpmComponentLookupTopologySync(fixture.executable, result.packageProofNodes!, 'arm64')).toBe(true)
    })

    it('rejects a nearer Codex shadow added after the complete passive snapshot', async () => {
      const fixture = install('@openai/codex', 'hoisted', locked)
      const result = await inspect(fixture.executable)
      expect(result.npmComposition).toBeDefined()
      const component = fixture.spec.components[0]!
      write(path.join(fixture.packageRoot, 'bin', 'node_modules', ...component.installName.split('/'), 'package.json'), '{}')
      expect(verifyNpmComponentLookupTopologySync(fixture.executable, result.packageProofNodes!, 'arm64')).toBe(false)
      expect((await inspect(fixture.executable)).portableArtifactFingerprint).toBeUndefined()
    })

    it('rejects an OMP native-loader shadow instead of reusing root-entry lookup', async () => {
      const fixture = install('@oh-my-pi/pi-coding-agent', 'selector-nested', locked)
      const result = await inspect(fixture.executable)
      const selector = fixture.locations.get('@oh-my-pi/pi-natives')!
      const leaf = fixture.spec.components.find(component => component.role === 'platform_leaf')!
      write(path.join(selector, 'native', 'node_modules', ...leaf.installName.split('/'), 'package.json'), '{}')
      expect(verifyNpmComponentLookupTopologySync(fixture.executable, result.packageProofNodes!, 'arm64')).toBe(false)
      expect((await inspect(fixture.executable)).portableArtifactFingerprint).toBeUndefined()
    })

    it('rejects new duplicate placement, symlink or unsafe lookup parent after proof', async () => {
      for (const change of ['duplicate', 'symlink', 'unsafe'] as const) {
        const fixture = install('@openai/codex', 'nested', locked)
        const result = await inspect(fixture.executable)
        const component = fixture.spec.components[0]!
        const location = fixture.locations.get(component.installName)!
        if (change === 'duplicate') write(path.join(fixture.nodeModules, ...component.installName.split('/'), 'package.json'), '{}')
        if (change === 'symlink') { fs.renameSync(location, `${location}-moved`); fs.symlinkSync(`${location}-moved`, location) }
        if (change === 'unsafe') fs.chmodSync(path.join(fixture.packageRoot, 'node_modules'), 0o775)
        expect(verifyNpmComponentLookupTopologySync(fixture.executable, result.packageProofNodes!, 'arm64'), change).toBe(false)
      }
    })
  })
}

it('binds the lock at the actual first-match path, ignoring unreachable same-name entries', async () => {
  const fixture = install('@openai/codex', 'hoisted', true)
  const component = fixture.spec.components[0]!
  const unreachable = `node_modules/unrelated/node_modules/${component.installName}`
  fixture.packages[unreachable] = { version: component.version, integrity: 'sha512-b3RoZXI=' }
  fixture.saveLock()
  expect((await inspect(fixture.executable)).portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/)
  const actual = `node_modules/${component.installName}`
  delete fixture.packages[actual]
  fixture.saveLock()
  expect((await inspect(fixture.executable)).portableArtifactFingerprint).toBeUndefined()
})

it('rejects empty unsafe or linked nearer lookup prefixes before any shadow package exists', async () => {
  for (const change of ['writable', 'linked'] as const) {
    const fixture = install('@openai/codex', 'hoisted', false)
    const result = await inspect(fixture.executable)
    const lookup = path.join(fixture.packageRoot, 'bin', 'node_modules')
    if (change === 'writable') fs.mkdirSync(lookup, { recursive: true, mode: 0o777 })
    else { const other = path.join(fixture.root, 'empty'); fs.mkdirSync(other, { mode: 0o700 }); fs.mkdirSync(lookup, { mode: 0o700 }); fs.symlinkSync(other, path.join(lookup, '@openai')) }
    if (change === 'writable') fs.chmodSync(lookup, 0o777)
    expect(verifyNpmComponentLookupTopologySync(fixture.executable, result.packageProofNodes!, 'arm64'), change).toBe(false)
    expect((await inspect(fixture.executable)).portableArtifactFingerprint, change).toBeUndefined()
  }
})

it('fails closed when a known composition is missing all component manifests', async () => {
  const fixture = install('@openai/codex', 'nested', false)
  const result = await inspect(fixture.executable)
  expect(verifyNpmComponentLookupTopologySync(fixture.executable,
    result.packageProofNodes!.filter(node => node.role !== 'npm_component_manifest'), 'arm64')).toBe(false)
})


it.each([false, true])('keeps x64 OpenCode V2 modern/baseline binary selection unambiguous (locked=%s)', async locked => {
  const fixture = install('@opencode-ai/cli', 'nested', locked, 'x64')
  // The old integration fixture cloned one binary into both leaves. V2 must
  // select exactly one leaf; V1 has a separate reviewed two-identical-leaf rule.
  const ambiguous = await inspectPassiveCliVersionForArchitecture(fixture.executable, port, 'x64')
  expect(ambiguous.portableArtifactFingerprint).toBeUndefined()
  const baseline = fixture.spec.components.find(component => component.installName.endsWith('-baseline'))!
  const baselineFile = path.join(fixture.locations.get(baseline.installName)!, ...baseline.nativeExecutableRelativePath!.split('/'))
  fs.writeFileSync(baselineFile, 'distinct baseline executable', { mode: 0o700 })
  const modern = await inspectPassiveCliVersionForArchitecture(fixture.executable, port, 'x64')
  expect(modern.npmComposition?.components).toHaveLength(2)
  expect(modern.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(verifyNpmComponentLookupTopologySync(fixture.executable, modern.packageProofNodes!, 'x64')).toBe(true)
  fs.copyFileSync(baselineFile, fixture.executable)
  const selectedBaseline = await inspectPassiveCliVersionForArchitecture(fixture.executable, port, 'x64')
  expect(selectedBaseline.portableArtifactFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(verifyNpmComponentLookupTopologySync(fixture.executable, selectedBaseline.packageProofNodes!, 'x64')).toBe(true)
})
