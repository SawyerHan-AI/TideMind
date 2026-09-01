import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced with a string literal by client/scripts/build-bin.mjs. `typeof` is
// intentionally used so the source/tsx path can run without defining it.
declare const __TIDEMIND_BUNDLED_VERSION__: string | undefined;

/** Reads the Tide Mind package version without importing Electron or config. */
export function getTideMindVersion(): string {
  if (typeof __TIDEMIND_BUNDLED_VERSION__ !== 'undefined'
    && typeof __TIDEMIND_BUNDLED_VERSION__ === 'string'
    && __TIDEMIND_BUNDLED_VERSION__.trim()) {
    return __TIDEMIND_BUNDLED_VERSION__.trim();
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, '..', '..', 'package.json'),
    join(moduleDirectory, '..', '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: unknown; version?: unknown };
      if (pkg.name === 'tidemind' && typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      // Try the next build/source layout.
    }
  }
  return '0.0.0';
}
