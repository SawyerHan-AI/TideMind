import { createHash } from 'node:crypto'

export function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(stableJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return result
}
