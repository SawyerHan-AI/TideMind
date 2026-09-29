import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { npmComposedDistributionSpec, type NpmComposedComponentSpec, type NpmComposedDistributionSpec } from './npm-distribution-topology'
import type { PackageMetadataProofNode } from './discovery'

type NodeInfo = { kind: 'file' | 'directory' | 'symbolic_link' | 'other'; mode?: number; ownerUid?: string }
export interface NpmTopologyFileSystem {
  lstat(target: string): Promise<NodeInfo | undefined>
  realpath(target: string): Promise<string>
}
export interface NpmComponentLookupContext {
  packageRoot: string
  nodeModulesRoot: string
  executableRealpath: string
  spec: NpmComposedDistributionSpec
  /** Components already resolved in the frozen spec order (selector before leaf). */
  resolvedComponents: ReadonlyMap<string, string>
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function lookupPlan(context: NpmComponentLookupContext, component: NpmComposedComponentSpec): { roots: string[]; allowed: Set<string> } | null {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(component.installName)) return null
  let fromFile = context.executableRealpath
  const allowed = new Set([path.join(context.packageRoot, 'node_modules'), context.nodeModulesRoot])
  if (context.spec.entryRule === 'js_entry_loads_platform_native_v1' && component.role === 'platform_leaf') {
    // Frozen OMP contract, not package-provided main/exports or guessed executable text.
    // @oh-my-pi/pi-natives 18.1.11 native/loader-state.js uses createRequire(import.meta.url).
    const selector = context.spec.components.find(entry => entry.role === 'platform_selector')
    const selectorRoot = selector && context.resolvedComponents.get(selector.installName)
    if (!selectorRoot || selector!.installName !== '@oh-my-pi/pi-natives') return null
    fromFile = path.join(selectorRoot, 'native', 'loader-state.js')
    allowed.add(path.join(selectorRoot, 'node_modules'))
  }
  const roots: string[] = []
  for (let directory = path.dirname(fromFile); within(context.nodeModulesRoot, directory); directory = path.dirname(directory)) {
    if (path.basename(directory) !== 'node_modules') roots.push(path.join(directory, 'node_modules'))
    if (directory === context.nodeModulesRoot) break
  }
  roots.push(context.nodeModulesRoot)
  return { roots: [...new Set(roots)], allowed }
}

function safeDirectory(node: NodeInfo | undefined): boolean {
  const uid = process.getuid?.()
  return uid !== undefined && node?.kind === 'directory' && node.mode !== undefined
    && (node.ownerUid === String(uid) || node.ownerUid === '0') && (node.mode & 0o022) === 0
}

function componentDirectories(lookupRoot: string, installName: string): string[] {
  const parts = installName.split('/')
  return [lookupRoot, ...parts.map((_, index) => path.join(lookupRoot, ...parts.slice(0, index + 1)))]
}

function prefixDirectories(boundary: string, candidate: string): string[] {
  if (!within(boundary, candidate)) return []
  const parts = path.relative(boundary, candidate).split(path.sep).filter(Boolean)
  return [boundary, ...parts.map((_, index) => path.join(boundary, ...parts.slice(0, index + 1)))]
}

async function safeLookupPrefix(boundary: string, candidate: string, port: NpmTopologyFileSystem): Promise<boolean> {
  const directories = prefixDirectories(boundary, candidate)
  if (!directories.length) return false
  for (const directory of directories) {
    const node = await port.lstat(directory)
    if (node === undefined) return directory !== boundary
    if (!safeDirectory(node) || path.resolve(await port.realpath(directory)) !== directory) return false
  }
  return true
}

function safeLookupPrefixSync(boundary: string, candidate: string): boolean {
  const directories = prefixDirectories(boundary, candidate)
  if (!directories.length) return false
  for (const directory of directories) {
    const node = lstatSync(directory)
    if (node === undefined) return directory !== boundary
    if (!safeDirectory(node) || path.resolve(fs.realpathSync(directory)) !== directory) return false
  }
  return true
}

/** Exact Node first match, with only frozen nested/hoisted placements admitted. */
export async function locateNpmComposedComponent(
  context: NpmComponentLookupContext,
  component: NpmComposedComponentSpec,
  port: NpmTopologyFileSystem,
): Promise<string | null> {
  try {
    const plan = lookupPlan(context, component)
    if (!plan) return null
    let selected: string | null = null
    for (const root of plan.roots) {
      const candidate = path.join(root, ...component.installName.split('/'))
      if (!await safeLookupPrefix(context.nodeModulesRoot, candidate, port)) return null
      const node = await port.lstat(candidate)
      if (node === undefined) continue
      // A nearer bin/native/scope shadow or a second installation is not silently ignored.
      if (selected || !plan.allowed.has(root) || !safeDirectory(node)) return null
      for (const directory of componentDirectories(root, component.installName)) {
        if (!safeDirectory(await port.lstat(directory)) || path.resolve(await port.realpath(directory)) !== directory) return null
      }
      selected = candidate
    }
    return selected
  } catch { return null }
}

function lstatSync(target: string): NodeInfo | undefined {
  try {
    const stat = fs.lstatSync(target)
    return { kind: stat.isSymbolicLink() ? 'symbolic_link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      mode: stat.mode & 0o7777, ownerUid: String(stat.uid) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function locateSync(context: NpmComponentLookupContext, component: NpmComposedComponentSpec): string | null {
  const plan = lookupPlan(context, component)
  if (!plan) return null
  let selected: string | null = null
  for (const root of plan.roots) {
    const candidate = path.join(root, ...component.installName.split('/'))
    if (!safeLookupPrefixSync(context.nodeModulesRoot, candidate)) return null
    const node = lstatSync(candidate)
    if (node === undefined) continue
    if (selected || !plan.allowed.has(root) || !safeDirectory(node)) return null
    for (const directory of componentDirectories(root, component.installName)) {
      if (!safeDirectory(lstatSync(directory)) || path.resolve(fs.realpathSync(directory)) !== directory) return null
    }
    selected = candidate
  }
  return selected
}

function manifestFromProof(node: PackageMetadataProofNode): { name?: unknown; version?: unknown } | null {
  if (path.basename(node.path) !== 'package.json' || path.resolve(node.path) !== node.path
    || fs.realpathSync(node.path) !== node.path) return null
  const fd = fs.openSync(node.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 512 * 1024) return null
    const bytes = fs.readFileSync(fd)
    if (createHash('sha256').update(bytes).digest('hex') !== node.sha256) return null
    return JSON.parse(bytes.toString('utf8'))
  } finally { fs.closeSync(fd) }
}

/** Re-run this at the final synchronous trust boundary, before and after file CAS.
 * Proof roots are compared to the exact runtime resolver first match, not merely re-listed.
 */
export function verifyNpmComponentLookupTopologySync(
  executablePath: string,
  nodes: readonly PackageMetadataProofNode[],
  architecture: 'arm64' | 'x64' = process.arch === 'x64' ? 'x64' : 'arm64',
): boolean {
  try {
    const roots = nodes.filter(node => node.role === 'package_manifest')
    const components = nodes.filter(node => node.role === 'npm_component_manifest')
    if (roots.length === 0) return components.length === 0
    if (roots.length !== 1) return false
    const manifest = manifestFromProof(roots[0]!)
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return false
    const spec = npmComposedDistributionSpec(manifest.name, manifest.version, architecture)
    if (!spec) return components.length === 0
    if (components.length !== spec.components.length) return false
    const packageRoot = path.dirname(roots[0]!.path)
    const parts = manifest.name.split('/')
    const nodeModulesRoot = path.resolve(packageRoot, ...parts.map(() => '..'))
    if (path.basename(nodeModulesRoot) !== 'node_modules'
      || path.join(nodeModulesRoot, ...parts) !== packageRoot
      || executablePath !== path.join(packageRoot, ...spec.rootExecutableRelativePath.split('/'))) return false
    for (const directory of componentDirectories(nodeModulesRoot, manifest.name)) {
      if (!safeDirectory(lstatSync(directory)) || fs.realpathSync(directory) !== directory) return false
    }
    const resolvedComponents = new Map<string, string>()
    const context = { packageRoot, nodeModulesRoot, executableRealpath: executablePath, spec, resolvedComponents }
    for (const component of spec.components) {
      const located = locateSync(context, component)
      if (!located) return false
      const proof = components.find(node => node.path === path.join(located, 'package.json'))
      const value = proof && manifestFromProof(proof)
      if (!value || value.name !== component.manifestName || value.version !== component.version) return false
      resolvedComponents.set(component.installName, located)
    }
    return true
  } catch { return false }
}
