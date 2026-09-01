import type {
  AdapterInspection,
  AdapterOperationContext,
  AdapterPlan,
  AdapterPlanRequest,
  AgentHostAdapter,
  CatalogId,
  ComponentKey,
  PlannedMutation,
} from '../types'

export function createCompositeHostAdapter(
  catalogId: CatalogId,
  componentAdapters: readonly AgentHostAdapter[],
): AgentHostAdapter {
  if (componentAdapters.length === 0 || componentAdapters.some(adapter => adapter.catalogId !== catalogId)) {
    throw new Error(`Invalid component adapters for ${catalogId}`)
  }
  const adapterVersion = componentAdapters.map(adapter => adapter.adapterVersion).join('+')
  const componentKeys = [...new Set(componentAdapters.flatMap(adapter => adapter.componentKeys))]
  if (componentKeys.length !== componentAdapters.reduce((total, adapter) => total + adapter.componentKeys.length, 0)) {
    throw new Error(`Duplicate component Adapter declaration for ${catalogId}`)
  }
  const implementationTypes = Object.fromEntries(componentKeys.map(componentKey => [
    componentKey,
    [...new Set(componentAdapters.flatMap(adapter => adapter.implementationTypes[componentKey] ?? []))],
  ]))

  const inspectAll = async (context: AdapterOperationContext): Promise<AdapterInspection> => {
    const inspections = await Promise.all(componentAdapters.map(adapter => adapter.inspect(context)))
    const seen = new Set<ComponentKey>()
    const components = inspections.flatMap(inspection => inspection.components).filter(component => {
      if (seen.has(component.componentKey)) throw new Error(`duplicate component adapter: ${component.componentKey}`)
      seen.add(component.componentKey)
      return true
    })
    return {
      catalogId,
      detected: inspections.every(inspection => inspection.detected),
      detectedVersion: inspections.find(inspection => inspection.detectedVersion)?.detectedVersion,
      distribution: inspections.find(inspection => Object.keys(inspection.distribution).length > 0)?.distribution ?? {},
      components,
      provenance: [...new Set(inspections.flatMap(inspection => inspection.provenance))].sort(),
      diagnostics: [...new Set(inspections.flatMap(inspection => inspection.diagnostics))].sort(),
    }
  }

  const mergePlans = async (
    context: AdapterOperationContext,
    request: AdapterPlanRequest,
    mode: 'connect' | 'disconnect',
  ): Promise<AdapterPlan> => {
    const plans = await Promise.all(componentAdapters.map(async (adapter) => {
      const subInspection = await adapter.inspect(context)
      const keys = subInspection.components.map(component => component.componentKey)
        .filter(key => request.desiredComponents.includes(key))
      if (keys.length === 0) return null
      return mode === 'connect'
        ? adapter.plan(context, { ...request, desiredComponents: keys, observed: subInspection })
        : adapter.disconnect(context, {
            componentKeys: keys,
            observed: subInspection,
            ownedArtifacts: request.ownedArtifacts,
          })
    }))
    const active = plans.filter((plan): plan is AdapterPlan => plan !== null)
    return {
      catalogId,
      installationKey: context.installation.installKey,
      adapterVersion,
      projectionVersion: context.runtime.projectionVersion,
      mutations: active.flatMap(plan => plan.mutations),
      requiredUserActions: active.flatMap(plan => plan.requiredUserActions),
      diagnostics: active.flatMap(plan => plan.diagnostics),
    }
  }

  const adapterForMutation = async (context: AdapterOperationContext, mutation: PlannedMutation) => {
    for (const adapter of componentAdapters) {
      const inspection = await adapter.inspect(context)
      if (inspection.components.some(component => component.componentKey === mutation.componentKey)) return adapter
    }
    throw new Error(`No component adapter for ${mutation.componentKey}`)
  }

  return {
    catalogId,
    adapterVersion,
    componentKeys,
    implementationTypes,
    inspect: inspectAll,
    inspectAdoptableArtifacts: async context => (await Promise.all(componentAdapters.map(adapter =>
      adapter.inspectAdoptableArtifacts?.(context) ?? Promise.resolve([]),
    ))).flat(),
    plan: (context, request) => mergePlans(context, request, 'connect'),
    apply: async (context, mutation) => (await adapterForMutation(context, mutation)).apply(context, mutation),
    readBack: async (context, mutation) => (await adapterForMutation(context, mutation)).readBack(context, mutation),
    disconnect: (context, request) => mergePlans(context, {
      desiredCapability: 0,
      desiredComponents: request.componentKeys,
      observed: request.observed,
      ownedArtifacts: request.ownedArtifacts,
    }, 'disconnect'),
    verify: async (context, request) => (await Promise.all(componentAdapters.map(adapter =>
      adapter.verify(context, request),
    ))).flat(),
  }
}
