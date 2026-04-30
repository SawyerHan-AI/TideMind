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

export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2))
}

export function unlinkIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}
