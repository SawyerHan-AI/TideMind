/**
 * Safe JSON.parse wrapper — returns fallback on invalid JSON or non-object input.
 */
export function safeJsonParse(s, fallback) {
    if (!s)
        return fallback;
    try {
        return JSON.parse(s);
    }
    catch {
        return fallback;
    }
}
