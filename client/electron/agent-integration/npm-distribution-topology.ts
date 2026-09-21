export type NpmComposedEntryRule =
  | 'copy_platform_binary_v1'
  | 'js_wrapper_selects_platform_binary_v1'
  | 'js_entry_loads_platform_native_v1'

export interface NpmComposedComponentSpec {
  role: 'platform_selector' | 'platform_leaf'
  installName: string
  manifestName: string
  version: string
  nativeExecutableRelativePath: string | null
}

export interface NpmComposedDistributionSpec {
  entryRule: NpmComposedEntryRule
  rootExecutableRelativePath: string
  copySourceInstallName?: string
  components: readonly NpmComposedComponentSpec[]
}

/**
 * Frozen package-layout contracts derived from the exact official npm
 * packuments. They describe only packages that participate in creating or
 * selecting the main CLI/native runtime. Optional feature packages are not
 * silently promoted into the distribution identity.
 */
export function npmComposedDistributionSpec(
  packageName: string,
  version: string,
  architecture: 'arm64' | 'x64',
  platformVariant: 'modern' | 'baseline' = 'modern',
): NpmComposedDistributionSpec | null {
  if (packageName === '@anthropic-ai/claude-code') {
    const installName = `@anthropic-ai/claude-code-darwin-${architecture}`
    return {
      entryRule: 'copy_platform_binary_v1',
      rootExecutableRelativePath: 'bin/claude.exe',
      copySourceInstallName: installName,
      components: [{
        role: 'platform_leaf',
        installName,
        manifestName: installName,
        version,
        nativeExecutableRelativePath: 'claude',
      }],
    }
  }
  if (packageName === '@openai/codex') {
    const triple = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    return {
      entryRule: 'js_wrapper_selects_platform_binary_v1',
      rootExecutableRelativePath: 'bin/codex.js',
      components: [{
        role: 'platform_leaf',
        installName: `@openai/codex-darwin-${architecture}`,
        manifestName: '@openai/codex',
        version: `${version}-darwin-${architecture}`,
        nativeExecutableRelativePath: `vendor/${triple}/bin/codex`,
      }],
    }
  }
  if (packageName === 'opencode-ai') {
    const leafBase = `opencode-darwin-${architecture}`
    const leafNames = architecture === 'x64' ? [leafBase, `${leafBase}-baseline`] : [leafBase]
    return {
      entryRule: 'copy_platform_binary_v1',
      rootExecutableRelativePath: 'bin/opencode.exe',
      copySourceInstallName: leafBase,
      components: leafNames.map(installName => ({
        role: 'platform_leaf',
        installName,
        manifestName: installName,
        version,
        nativeExecutableRelativePath: 'bin/opencode',
      })),
    }
  }
  if (packageName === '@opencode-ai/cli') {
    const leafBase = `@opencode-ai/cli-darwin-${architecture}`
    const leafNames = architecture === 'x64' ? [leafBase, `${leafBase}-baseline`] : [leafBase]
    const selected = architecture === 'x64' && platformVariant === 'baseline'
      ? `${leafBase}-baseline`
      : leafBase
    return {
      entryRule: 'copy_platform_binary_v1',
      rootExecutableRelativePath: 'bin/opencode2.exe',
      copySourceInstallName: selected,
      components: leafNames.map(installName => ({
        role: 'platform_leaf',
        installName,
        manifestName: installName,
        version,
        nativeExecutableRelativePath: 'bin/opencode2',
      })),
    }
  }
  if (packageName === '@oh-my-pi/pi-coding-agent') {
    return {
      entryRule: 'js_entry_loads_platform_native_v1',
      rootExecutableRelativePath: 'dist/cli.js',
      components: [
        {
          role: 'platform_selector',
          installName: '@oh-my-pi/pi-natives',
          manifestName: '@oh-my-pi/pi-natives',
          version,
          nativeExecutableRelativePath: null,
        },
        {
          role: 'platform_leaf',
          installName: `@oh-my-pi/pi-natives-darwin-${architecture}`,
          manifestName: `@oh-my-pi/pi-natives-darwin-${architecture}`,
          version,
          nativeExecutableRelativePath: architecture === 'x64'
            ? 'pi_natives.darwin-x64-baseline.node'
            : 'pi_natives.darwin-arm64.node',
        },
      ],
    }
  }
  return null
}
