import fs from 'node:fs'
import path from 'node:path'

function canonical(value: string): string {
  const resolved = path.resolve(value)
  try { return fs.realpathSync(resolved) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw new Error('claude_configuration_root_unavailable')
  }
}
/** Claude moves .claude.json inside CONFIG when this variable is set, even for
 * the default .claude directory. Preserve an unset default, including symlinks. */
export function claudeConfigRootEnvironment(homeDir: string, configRoot: string,
  inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const target = canonical(configRoot)
  const standard = canonical(path.join(homeDir, '.claude'))
  const explicit = inherited.CLAUDE_CONFIG_DIR?.trim()
  if (target === standard && (!explicit || canonical(explicit) !== target)) return {}
  return { CLAUDE_CONFIG_DIR: target }
}
