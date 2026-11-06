import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

const UNIX_CONFIG_LAYERS = ['/etc/codex/config.toml', '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml']
const CONFIG_LIMIT = 1024 * 1024
type Routing = 'clear' | 'override' | 'unknown'

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

/** The native provider ID remains openai even when these endpoints change. */
export function hasCodexRouteOverride(value: unknown): boolean {
  const config = record(value)
  return config?.openai_base_url != null || config?.chatgpt_base_url != null
    || Object.values(record(config?.profiles) ?? {}).some(profile => {
      const declared = record(profile)
      return declared?.openai_base_url != null || declared?.chatgpt_base_url != null
    })
}

async function declaredRouting(filename: string): Promise<Routing> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > CONFIG_LIMIT) return 'unknown'
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size) return 'unknown'
    const config = record(parseToml(buffer.subarray(0, bytesRead).toString('utf8')))
    if (!config) return 'unknown'
    if (hasCodexRouteOverride(config)) return 'override'
    // Do not select or merge a named profile on behalf of the user.
    return config.profile == null || config.profile === '' ? 'clear' : 'unknown'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'clear' : 'unknown'
  } finally { await file?.close() }
}

/** Check the standard local layers before any native Codex metadata session can use credentials. */
export async function checkCodexDeclaredRouting(configRoot: string,
  systemConfigPaths: readonly string[] = process.platform === 'win32' ? [] : UNIX_CONFIG_LAYERS): Promise<Routing> {
  const results = await Promise.all([path.join(configRoot, 'config.toml'), ...systemConfigPaths].map(declaredRouting))
  if (results.includes('override')) return 'override'
  return results.includes('unknown') ? 'unknown' : 'clear'
}
