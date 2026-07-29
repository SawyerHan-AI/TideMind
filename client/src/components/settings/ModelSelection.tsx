import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { safeJsonParse } from '../../lib/json'
import { Field, Section } from './shared'
import { SettingsListbox, type SettingsListboxGroup } from './SettingsListbox'

const CLAUDE_MODELS = [
  ['claude-opus-4-7', 'Claude Opus 4.7'],
  ['claude-opus-4-6', 'Claude Opus 4.6'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
] as const
const GEMINI_MODELS = [
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro (Preview)'],
  ['gemini-3-flash-preview', 'Gemini 3 Flash (Preview)'],
  ['gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash Lite (Preview)'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'],
] as const
interface Connection {
  id: string
  name: string
  provider_type: string
  status: string
  available_models: string | null
  candidate_models?: string | null
  source_type?: 'cloud_service' | 'local_subscription' | 'local_model'
  archived: number
}

interface ModelChoice {
  value: string
  label: string
}

interface ModelRouteConfig {
  llm?: {
    provider?: string
    light_provider?: string
    standard_provider?: string
    heavy_provider?: string
    light_connection?: string
    standard_connection?: string
    heavy_connection?: string
    light_model?: string
    standard_model?: string
    heavy_model?: string
  }
  embedding?: {
    provider?: string
    connection?: string
    model?: string
  }
}

function encode(connectionId: string, model: string) {
  return `${connectionId}::${model}`
}

function decode(value: string) {
  const index = value.indexOf('::')
  return index < 0
    ? { connectionId: '', model: value }
    : { connectionId: value.slice(0, index), model: value.slice(index + 2) }
}

function sourceFor(provider: string): Connection['source_type'] {
  if (provider === 'claude-cli' || provider === 'codex-cli') return 'local_subscription'
  if (provider === 'ollama') return 'local_model'
  return 'cloud_service'
}

function modelsFor(connection: Connection, embedding = false): ModelChoice[] {
  const verified = safeJsonParse<string[]>(connection.available_models, [])
  if (embedding) {
    if (connection.provider_type === 'vertex' || connection.provider_type === 'gemini') {
      return [{ value: 'gemini-embedding-001', label: 'Gemini Embedding 001 (3072 dim)' }]
    }
    if (connection.provider_type === 'ollama') {
      return verified.map(model => ({ value: model, label: `${model} (768 dim)` }))
    }
    return []
  }
  if (connection.provider_type === 'claude-cli') {
    return verified.map(model => ({ value: model, label: model === 'default' ? 'Default' : `Claude ${model[0].toUpperCase()}${model.slice(1)}` }))
  }
  if (connection.provider_type === 'codex-cli') {
    return verified.map(model => ({ value: model, label: model === 'default' ? 'Default' : model }))
  }
  if (connection.provider_type === 'anthropic' || connection.provider_type === 'vertex') {
    return CLAUDE_MODELS
      .filter(([id]) => verified.includes(id))
      .map(([value, label]) => ({ value, label }))
  }
  if (connection.provider_type === 'gemini') {
    return GEMINI_MODELS
      .filter(([id]) => verified.includes(id))
      .map(([value, label]) => ({ value, label }))
  }
  return verified.map(model => ({ value: model, label: model }))
}

function sourceLabel(source: Connection['source_type'], t: (key: string) => string) {
  if (source === 'local_subscription') return t('model.providerGroups.localSubscription')
  if (source === 'local_model') return t('model.providerGroups.localModel')
  return t('model.providerGroups.cloudService')
}

function ModelRouteFields({
  value,
  onChange,
  connections,
  embedding = false,
}: {
  value: string
  onChange: (value: string) => void
  connections: Connection[]
  embedding?: boolean
}) {
  const { t } = useTranslation('settings')
  const selected = decode(value)
  const eligible = connections.filter(connection => !connection.archived && modelsFor(connection, embedding).length > 0)
  const selectedStored = connections.find(connection => connection.id === selected.connectionId)
  const selectedConnection = eligible.find(connection => connection.id === selected.connectionId)
  const selectedModels = selectedConnection ? modelsFor(selectedConnection, embedding) : []
  const invalidConnection = Boolean(selected.connectionId && !selectedConnection)
  const invalidModel = Boolean(
    selectedConnection &&
    selected.model &&
    !selectedModels.some(model => model.value === selected.model),
  )

  const connectionGroups: SettingsListboxGroup[] = [
    ...(invalidConnection ? [{
      label: t('model.selection.savedRouteProblem'),
      options: [{
        value: selected.connectionId,
        label: selectedStored?.name ?? selected.connectionId,
        description: selectedStored?.archived
          ? t('model.selection.connectionArchived')
          : t('model.selection.connectionUnavailable'),
        disabled: true,
      }],
    }] : []),
    ...(['local_subscription', 'cloud_service', 'local_model']
    .map(source => ({
      label: sourceLabel(source as Connection['source_type'], t),
      options: eligible
        .filter(connection => (connection.source_type ?? sourceFor(connection.provider_type)) === source)
        .map(connection => ({ value: connection.id, label: connection.name, description: connection.provider_type })),
    }))
    .filter(group => group.options.length > 0)),
  ]

  const modelGroups: SettingsListboxGroup[] = selectedConnection || (invalidConnection && selected.model) ? [{
    label: selectedConnection?.name ?? selectedStored?.name ?? t('model.selection.savedRouteProblem'),
    options: [
      ...((invalidModel || invalidConnection) && selected.model ? [{
        value: selected.model,
        label: selected.model,
        description: t('model.selection.modelUnavailable'),
        disabled: true,
      }] : []),
      ...selectedModels.map(model => ({
      value: model.value,
      label: model.label,
      })),
    ],
  }] : []

  const changeConnection = (connectionId: string) => {
    const connection = eligible.find(item => item.id === connectionId)
    const firstModel = connection ? modelsFor(connection, embedding)[0]?.value : ''
    onChange(encode(connectionId, firstModel ?? ''))
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <SettingsListbox
          value={selected.connectionId}
          onChange={changeConnection}
          groups={connectionGroups}
          placeholder={t('model.selection.selectConnection')}
          ariaLabel={t('model.selection.connectionLabel')}
        />
        <SettingsListbox
          value={selected.model}
          onChange={model => onChange(encode(selected.connectionId, model))}
          groups={modelGroups}
          placeholder={t('model.selection.selectModel')}
          disabled={!selectedConnection}
          ariaLabel={t('model.selection.modelLabel')}
        />
      </div>
      {(invalidConnection || invalidModel) && (
        <p className="flex items-center gap-1 text-[10px] text-red-400">
          <AlertTriangle size={10} />
          {invalidConnection
            ? t('model.selection.savedConnectionInvalid')
            : t('model.selection.savedModelInvalid')}
        </p>
      )}
    </div>
  )
}

export function ModelSelection() {
  const { t } = useTranslation('settings')
  const fetchConfig = useCallback(() => window.api.config.get(), [])
  // Archived connections remain visible only when referenced by a saved route;
  // they are never eligible for a new selection.
  const fetchConnections = useCallback(() => window.api.connections.list(true), [])
  const fetchReembedStatus = useCallback(() => window.api.embedding.reembedStatus(), [])
  const { data: config, refetch: refetchConfig } = useIPC(fetchConfig)
  const { data: connectionData } = useIPC(fetchConnections)
  const { data: reembedStatus, refetch: recheckReembed } = useIPC(fetchReembedStatus)
  const connections = (connectionData ?? []) as Connection[]
  const connMap = useMemo(() => new Map(connections.map(connection => [connection.id, connection])), [connections])

  const [lightValue, setLightValue] = useState('')
  const [standardValue, setStandardValue] = useState('')
  const [heavyValue, setHeavyValue] = useState('')
  const [embValue, setEmbValue] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [reembedding, setReembedding] = useState(false)
  const dirty = useRef(false)
  const saveNowRef = useRef<((light: string, standard: string, heavy: string, embedding: string) => void) | null>(null)

  const userSetter = (setter: React.Dispatch<React.SetStateAction<string>>) => (value: string) => {
    dirty.current = true
    setter(value)
  }

  useEffect(() => {
    if (!config || connectionData === null) return
    const current = config as ModelRouteConfig
    const resolve = (connectionId: string | undefined, provider: string | undefined, model: string, fallbackModel: string) => {
      if (connectionId) return encode(connectionId, model || fallbackModel)
      const matching = connections.find(connection => !connection.archived && connection.provider_type === provider)
      return encode(matching?.id ?? '', model || fallbackModel)
    }
    const provider = current.llm?.provider ?? 'anthropic'
    setLightValue(resolve(current.llm?.light_connection, current.llm?.light_provider ?? provider, current.llm?.light_model ?? '', 'claude-haiku-4-5'))
    setStandardValue(resolve(current.llm?.standard_connection, current.llm?.standard_provider ?? provider, current.llm?.standard_model ?? '', 'claude-sonnet-4-6'))
    setHeavyValue(resolve(current.llm?.heavy_connection, current.llm?.heavy_provider ?? provider, current.llm?.heavy_model ?? '', 'claude-opus-4-7'))
    setEmbValue(resolve(current.embedding?.connection, current.embedding?.provider ?? 'vertex', current.embedding?.model ?? '', 'gemini-embedding-001'))
  }, [config, connectionData, connections, connMap])

  useEffect(() => {
    if (!reembedding) return
    const timer = setInterval(() => recheckReembed(), 2000)
    return () => clearInterval(timer)
  }, [reembedding, recheckReembed])

  useEffect(() => {
    if (reembedStatus && !reembedStatus.running) setReembedding(false)
  }, [reembedStatus])

  const saveNow = useCallback(async (lightValue: string, standardValue: string, heavyValue: string, embeddingValue: string) => {
    const light = decode(lightValue)
    const standard = decode(standardValue)
    const heavy = decode(heavyValue)
    const embedding = decode(embeddingValue)
    const current = config as ModelRouteConfig | null
    const provider = (connectionId: string, fallback: string) => connMap.get(connectionId)?.provider_type ?? fallback
    try {
      const result = await window.api.config.update({
        llm: {
          provider: provider(light.connectionId, 'anthropic'),
          light_connection: light.connectionId || undefined,
          light_provider: provider(light.connectionId, current?.llm?.light_provider ?? current?.llm?.provider ?? 'anthropic'),
          standard_connection: standard.connectionId || undefined,
          standard_provider: provider(standard.connectionId, current?.llm?.standard_provider ?? current?.llm?.provider ?? 'anthropic'),
          heavy_connection: heavy.connectionId || undefined,
          heavy_provider: provider(heavy.connectionId, current?.llm?.heavy_provider ?? current?.llm?.provider ?? 'anthropic'),
          light_model: light.model,
          standard_model: standard.model,
          heavy_model: heavy.model,
        },
        embedding: {
          connection: embedding.connectionId || undefined,
          provider: provider(embedding.connectionId, current?.embedding?.provider ?? 'vertex'),
          model: embedding.model,
          dimensions: provider(embedding.connectionId, 'vertex') === 'ollama' ? 768 : 3072,
        },
      })
      if (result?.success === false) throw new Error('save failed')
      dirty.current = false
      setSaveError(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      refetchConfig()
    } catch {
      setSaved(false)
      setSaveError(true)
    }
  }, [config, connMap, refetchConfig])
  saveNowRef.current = saveNow

  useEffect(() => {
    if (!dirty.current) return
    const timer = setTimeout(() => saveNowRef.current?.(lightValue, standardValue, heavyValue, embValue), 300)
    return () => clearTimeout(timer)
  }, [lightValue, standardValue, heavyValue, embValue])

  const selectedEmbedding = decode(embValue)
  const embeddingDimensions = connMap.get(selectedEmbedding.connectionId)?.provider_type === 'ollama' ? 768 : 3072

  return (
    <div className="space-y-6 max-w-lg">
      <Section title="LLM">
        <div className="space-y-5">
          {[
            ['light', t('model.selection.lightModel'), t('model.selection.lightModelTip'), t('model.selection.lightModelUsage'), lightValue, userSetter(setLightValue)],
            ['standard', t('model.selection.standardModel'), t('model.selection.standardModelTip'), t('model.selection.standardModelUsage'), standardValue, userSetter(setStandardValue)],
            ['heavy', t('model.selection.heavyModel'), t('model.selection.heavyModelTip'), t('model.selection.heavyModelUsage'), heavyValue, userSetter(setHeavyValue)],
          ].map(([key, label, tip, usage, value, onChange]) => (
            <div key={key as string} className="space-y-2">
              <Field label={label as string} tip={tip as string}>
                <ModelRouteFields value={value as string} onChange={onChange as (value: string) => void} connections={connections} />
              </Field>
              <p className="text-[10px] text-gray-500">{usage as string}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Embedding">
        <div className="space-y-3">
          <Field label={t('model.selection.embeddingModel')} tip={t('model.selection.embeddingModelTip')}>
            <ModelRouteFields value={embValue} onChange={userSetter(setEmbValue)} connections={connections} embedding />
          </Field>
          <div className="flex items-center gap-4 text-[10px] text-gray-500">
            <span>{t('model.selection.dimensions')}: {embeddingDimensions}</span>
            <span>{t('model.selection.connectionLabel')}: {connMap.get(selectedEmbedding.connectionId)?.name ?? t('model.selection.notSelected')}</span>
          </div>
          <p className="text-[10px] text-gray-500">{t('model.selection.embeddingUsage')}</p>
          {(reembedStatus?.needed || reembedStatus?.running) && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <div className="flex items-center gap-2">
                <AlertTriangle size={12} className="text-amber-400" />
                <p className="text-xs text-amber-300">
                  {reembedStatus.running
                    ? t('model.selection.reembedProgress', { done: reembedStatus.done, total: reembedStatus.total })
                    : t('model.selection.reembedNeeded')}
                </p>
              </div>
              {!reembedStatus.running && (
                <button
                  onClick={async () => {
                    setReembedding(true)
                    await window.api.embedding.triggerReembed()
                    recheckReembed()
                  }}
                  disabled={reembedding}
                  className="mt-2 flex items-center gap-2 px-3 py-1.5 text-xs bg-amber-500/20 hover:bg-amber-500/30 rounded-lg text-amber-300 disabled:opacity-50"
                >
                  {reembedding && <Loader2 size={12} className="animate-spin" />}
                  {t('model.selection.startReembed')}
                </button>
              )}
            </div>
          )}
        </div>
      </Section>

      {saved && <div className="flex items-center gap-1.5 text-xs text-green-400"><Check size={12} />{t('model.selection.saved')}</div>}
      {saveError && (
        <div className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertTriangle size={12} />{t('model.selection.saveFailed')}
          <button onClick={() => saveNow(lightValue, standardValue, heavyValue, embValue)} className="ml-1 underline hover:text-red-300">
            {t('model.selection.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
