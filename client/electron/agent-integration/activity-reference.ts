/** Shared activity is admissible only for the reviewed Antigravity domain contract. */
export function runtimeActivityReferencePrefix(
  hostVariant: string,
  result: { evidenceRef?: string; evidenceScope?: unknown },
): 'host-activity:' | 'shared-activity:' | null {
  if (result.evidenceRef?.startsWith('host-activity:')) return 'host-activity:'
  if (['antigravity-app', 'antigravity-cli'].includes(hostVariant)
    && result.evidenceScope === 'configuration_domain'
    && result.evidenceRef?.startsWith('shared-activity:')) return 'shared-activity:'
  return null
}
