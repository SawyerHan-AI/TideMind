import type { TFunction } from 'i18next';
/**
 * Resolve a timeline event title that may be a JSON i18n key or a legacy string.
 *
 * Backend stores titles as `{"key":"event_key","params":{"count":3}}`.
 * This function attempts to parse and translate via i18next.
 * Falls back to the raw string for legacy (pre-i18n) data.
 */
export declare function resolveEventTitle(title: string, t: TFunction): string;
