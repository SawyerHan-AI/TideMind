/**
 * Resolve a timeline event title that may be a JSON i18n key or a legacy string.
 *
 * Backend stores titles as `{"key":"event_key","params":{"count":3}}`.
 * This function attempts to parse and translate via i18next.
 * Falls back to the raw string for legacy (pre-i18n) data.
 */
export function resolveEventTitle(title, t) {
    try {
        const parsed = JSON.parse(title);
        if (parsed && typeof parsed.key === 'string') {
            const MISSING = '__eb_missing__';
            const resolved = String(t(`timeline:events.${parsed.key}`, {
                ...(parsed.params ?? {}),
                defaultValue: MISSING,
            }));
            // Missing key → fall back to raw title (JSON) so we don't leak i18n paths to UI
            if (resolved === MISSING)
                return title;
            return resolved;
        }
    }
    catch {
        // Not JSON — legacy plain-text title
    }
    return title;
}
