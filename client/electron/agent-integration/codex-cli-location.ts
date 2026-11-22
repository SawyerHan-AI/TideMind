import fs from 'node:fs/promises'
import path from 'node:path'

/** Identity of the directory that last contained this exact, canonical launcher. */
export async function codexLauncherParentIdentity(executable: string): Promise<string | null> {
  if (!path.isAbsolute(executable) || path.normalize(executable) !== executable) return null
  const parent = path.dirname(executable)
  try {
    const real = await fs.realpath(parent)
    if (real !== parent) return null
    const stat = await fs.stat(parent, { bigint: true })
    return stat.isDirectory() ? [stat.ino, stat.birthtimeNs].join(':') : null
  } catch {
    return null
  }
}

export async function confirmedMissingCodexLauncher(executable: string, previousParent: unknown): Promise<boolean> {
  if (typeof previousParent !== 'string' || await codexLauncherParentIdentity(executable) !== previousParent) return false
  try {
    await fs.lstat(executable)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      && await codexLauncherParentIdentity(executable) === previousParent
  }
}
