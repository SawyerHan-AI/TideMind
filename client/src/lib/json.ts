/**
 * Safe JSON.parse wrapper — returns fallback on invalid JSON or non-object input.
 */
export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
