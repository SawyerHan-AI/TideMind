import fs from 'node:fs'
import path from 'node:path'

/**
 * Atomic file write: write to a sibling temp file and then rename.
 * This keeps existing config files intact if the process dies mid-write.
 */
export function writeFileAtomic(realPath: string, data: string | Buffer, options?: { mode?: number }): void {
  const dir = path.dirname(realPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${realPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    fs.writeFileSync(tmpPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined)
    fs.renameSync(tmpPath, realPath)
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

export function readJsonSafe<T extends Record<string, any>>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/**
 * Strict variant of readJsonSafe for files OWNED BY OTHER APPS (e.g. Claude
 * Desktop's claude_desktop_config.json, Cursor's mcp.json).
 *
 * Behavior contract:
 *   - file does not exist        → return `whenMissing`
 *   - file exists, valid JSON    → return parsed value
 *   - file exists, INVALID JSON  → back up the original to `<path>.tidemind-backup-<ts>.bak`
 *                                  and throw. NEVER silently fall back to an empty object,
 *                                  because writing back the empty object would clobber the
 *                                  user's original config (other tools' MCP servers,
 *                                  preferences, etc.).
 *
 * Use this whenever we read-modify-write a config file we don't fully own. The
 * backup gives the user a deterministic recovery path; the throw surfaces the
 * problem in the UI instead of silently corrupting their setup.
 */
export function readJsonStrict<T extends Record<string, any>>(filePath: string, whenMissing: T): T {
  if (!fs.existsSync(filePath)) return whenMissing
  const raw = fs.readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${filePath}.tidemind-backup-${ts}.bak`
    try {
      fs.writeFileSync(backupPath, raw)
    } catch { /* if backup itself fails, still surface the original parse error below */ }
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Refused to overwrite ${filePath}: existing file is not valid JSON (${reason}). ` +
      `Original content backed up to ${backupPath}. Please inspect and restore manually.`,
    )
  }
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2))
}

export function unlinkIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}
