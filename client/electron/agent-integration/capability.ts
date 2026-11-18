import type { CapabilityLevel, ComponentKey } from './types'

/** A startup-only Hook does not provide the complete lifecycle capability. */
export function hostCapabilityCeiling(hostVariant: string): CapabilityLevel {
  if (hostVariant === 'custom-local-mcp') return 2
  if (hostVariant === 'antigravity-app' || hostVariant === 'antigravity-cli') return 3
  return 4
}

export function capHostCapability(value: number, hostVariant: string): CapabilityLevel {
  return Math.min(value, hostCapabilityCeiling(hostVariant)) as CapabilityLevel
}

export function capabilityForComponents(components: readonly ComponentKey[], hostVariant: string): CapabilityLevel {
  const enabled = new Set(components)
  const level = enabled.has('instruction') && enabled.has('memory_tools') && enabled.has('lifecycle') ? 4
    : enabled.has('instruction') && enabled.has('memory_tools') ? 3
      : enabled.has('memory_tools') ? 2 : enabled.has('instruction') ? 1 : 0
  return capHostCapability(level, hostVariant)
}
