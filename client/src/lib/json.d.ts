/**
 * Safe JSON.parse wrapper — returns fallback on invalid JSON or non-object input.
 */
export declare function safeJsonParse<T>(s: string | null | undefined, fallback: T): T;
