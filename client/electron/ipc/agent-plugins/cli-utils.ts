import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseCliName } from '../_schemas.js'

const execFileAsync = promisify(execFile)

export async function checkCli(cli: unknown): Promise<{ available: boolean; path?: string; version?: string }> {
  const parsedCli = parseCliName(cli)
  if (!parsedCli.ok) return { available: false }
  const validCli = parsedCli.data
  const parseVersion = (stdout: string): string | undefined => {
    const m = stdout.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : undefined
  }
  try {
    const candidates = [validCli, `/opt/homebrew/bin/${validCli}`, `/usr/local/bin/${validCli}`]
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 })
        return { available: true, path: candidate, version: parseVersion(stdout) }
      } catch { /* continue */ }
    }
    const { stdout } = await execFileAsync('which', [validCli])
    const cliPath = stdout.trim()
    if (!cliPath) return { available: false }
    let version: string | undefined
    try {
      const { stdout: vOut } = await execFileAsync(cliPath, ['--version'], { timeout: 5000 })
      version = parseVersion(vOut)
    } catch { /* version is optional */ }
    return { available: true, path: cliPath, version }
  } catch {
    return { available: false }
  }
}
