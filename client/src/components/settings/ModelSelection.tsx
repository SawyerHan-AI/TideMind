import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle, Check } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { Section, Field, inputClass } from './shared'
import { safeJsonParse } from '../../lib/json'

// ============================================================
// 模型选择：从已配置连接聚合可用模型，按连接名分组
// ============================================================

const selectClass =
  'w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/50 appearance-none cursor-pointer'

// ---- 推荐模型列表（人工维护） ----

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-0', label: 'Claude Sonnet 4' },
  { id: 'claude-opus-4-0', label: 'Claude Opus 4' },
]

const GEMINI_MODELS = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (Preview)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
]

// connectionId::model 编码
function encode(connectionId: string, model: string): string {
  return `${connectionId}::${model}`
}
function decode(value: string): { connectionId: string; model: string } {
  const idx = value.indexOf('::')
  if (idx === -1) return { connectionId: '', model: value }
  return { connectionId: value.slice(0, idx), model: value.slice(idx + 2) }
}

interface ModelOption {
  connectionId: string
  model: string
  value: string
  label: string
  disabled?: boolean
}

interface ModelGroup {
  connectionName: string
  options: ModelOption[]
}

interface Connection {
  id: string
  name: string
  provider_type: string
  status: string
  available_models: string | null
  archived: number
}

// ---- 统一模型下拉 ----

function UnifiedModelSelect({ value, onChange, groups, loading, placeholder }: {
  value: string
  onChange: (v: string) => void
  groups: ModelGroup[]
  loading?: boolean
  placeholder?: string
}) {
  const { t } = useTranslation('settings')
  const allOptions = groups.flatMap(g => g.options)
  const hasOptions = allOptions.length > 0

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-gray-500">
        <Loader2 size={12} className="animate-spin" />
        {t('model.selection.loadingModels')}
      </div>
    )
  }

  if (!hasOptions) {
    return (
      <input
        value={decode(value).model}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? t('model.selection.noConnectionPlaceholder')}
        className={inputClass}
      />
    )
  }

  // 查找当前选中值所属的连接名
  const selectedOption = allOptions.find(o => o.value === value)
  const selectedGroup = selectedOption ? groups.find(g => g.options.includes(selectedOption)) : null
  const showPrefix = groups.length > 1  // 多个连接时显示前缀

  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={selectClass}>
      {/* 当前值不在列表中时保留 */}
      {value && !selectedOption && (() => {
        const d = decode(value)
        return <option value={value}>{d.model} ({d.connectionId})</option>
      })()}
      {groups.map(g => g.options.length > 0 && (
        <optgroup key={g.connectionName} label={g.connectionName}>
          {g.options.map(o => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {showPrefix ? `${g.connectionName} / ${o.label}` : o.label}{o.disabled ? ` (${t('model.selection.unavailable')})` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function ModelSelection() {
  const { t } = useTranslation('settings')
  const { data: config, refetch: refetchConfig } = useIPC(() => window.api.config.get())
  const { data: connections } = useIPC(() => window.api.connections.list())
  const { data: reembedStatus, refetch: recheckReembed } = useIPC(() => window.api.embedding.reembedStatus())

  const [lightValue, setLightValue] = useState('')
  const [standardValue, setStandardValue] = useState('')
  const [heavyValue, setHeavyValue] = useState('')
  const [embValue, setEmbValue] = useState('')
  const [saved, setSaved] = useState(false)
  const [reembedding, setReembedding] = useState(false)
  const initialized = useRef(false)

  // 构建 connectionId 到 name 的映射
  const connMap = useMemo(() => {
    const m = new Map<string, Connection>()
    for (const c of (connections ?? []) as Connection[]) {
      m.set(c.id, c)
    }
    return m
  }, [connections])

  useEffect(() => {
    if (config && connections) {
      const c = config as any

      // 优先使用 connection_id 编码，回退到旧的 provider 编码
      const resolveSlot = (connKey: string | undefined, providerKey: string | undefined, defaultProvider: string, modelKey: string, defaultModel: string) => {
        const connId = connKey
        const model = modelKey || defaultModel
        if (connId && connMap.has(connId)) {
          return encode(connId, model)
        }
        // 回退：按 provider 找第一个匹配的 connection
        const prov = providerKey || defaultProvider
        const fallbackConn = (connections as Connection[]).find(conn => conn.provider_type === prov && !conn.archived)
        if (fallbackConn) {
          return encode(fallbackConn.id, model)
        }
        return encode('', model)
      }

      const defaultProv = c.llm?.provider ?? 'anthropic'
      setLightValue(resolveSlot(c.llm?.light_connection, c.llm?.light_provider ?? defaultProv, defaultProv, c.llm?.light_model, 'claude-haiku-4-5'))
      setStandardValue(resolveSlot(c.llm?.standard_connection, c.llm?.standard_provider ?? defaultProv, defaultProv, c.llm?.standard_model, 'claude-sonnet-4-6'))
      setHeavyValue(resolveSlot(c.llm?.heavy_connection, c.llm?.heavy_provider ?? defaultProv, defaultProv, c.llm?.heavy_model, 'claude-opus-4-6'))

      const embProv = c.embedding?.provider ?? 'vertex'
      setEmbValue(resolveSlot(c.embedding?.connection, embProv, embProv, c.embedding?.model, 'gemini-embedding-001'))
    }
  }, [config, connections, connMap])

  // Polling reembed progress
  useEffect(() => {
    if (!reembedding) return
    const timer = setInterval(() => recheckReembed(), 2000)
    return () => clearInterval(timer)
  }, [reembedding, recheckReembed])

  useEffect(() => {
    if (reembedStatus && !reembedStatus.running && reembedding) {
      setReembedding(false)
    }
  }, [reembedStatus, reembedding])

  // ---- 构建 LLM 模型列表（按连接分组） ----
  const llmGroups: ModelGroup[] = useMemo(() => {
    if (!connections) return []
    const groups: ModelGroup[] = []

    for (const conn of connections as Connection[]) {
      if (conn.archived) continue

      const availableModels: string[] = safeJsonParse<string[]>(conn.available_models, [])

      if (conn.provider_type === 'anthropic' || conn.provider_type === 'vertex') {
        groups.push({
          connectionName: conn.name,
          options: CLAUDE_MODELS.map(m => ({
            connectionId: conn.id, model: m.id,
            value: encode(conn.id, m.id),
            label: m.label,
            disabled: availableModels.length > 0 ? !availableModels.includes(m.id) : false,
          })),
        })
      }

      if (conn.provider_type === 'gemini') {
        groups.push({
          connectionName: conn.name,
          options: GEMINI_MODELS.map(m => ({
            connectionId: conn.id, model: m.id,
            value: encode(conn.id, m.id),
            label: m.label,
          })),
        })
      }

      if (conn.provider_type === 'ollama' || conn.provider_type === 'openai-compatible') {
        const models: string[] = safeJsonParse<string[]>(conn.available_models, [])
        if (models.length > 0) {
          groups.push({
            connectionName: conn.name,
            options: models.map(m => ({
              connectionId: conn.id, model: m,
              value: encode(conn.id, m),
              label: m,
            })),
          })
        }
      }
    }

    return groups
  }, [connections])

  // ---- 构建 Embedding 模型列表 ----
  const embGroups: ModelGroup[] = useMemo(() => {
    if (!connections) return []
    const groups: ModelGroup[] = []

    for (const conn of connections as Connection[]) {
      if (conn.archived) continue

      if (conn.provider_type === 'vertex' || conn.provider_type === 'gemini') {
        groups.push({
          connectionName: conn.name,
          options: [{
            connectionId: conn.id, model: 'gemini-embedding-001',
            value: encode(conn.id, 'gemini-embedding-001'),
            label: `Gemini Embedding 001 (3072 dim)`,
          }],
        })
      }

      if (conn.provider_type === 'ollama') {
        const ollamaModels: string[] = safeJsonParse<string[]>(conn.available_models, [])
        if (ollamaModels.length > 0) {
          groups.push({
            connectionName: conn.name,
            options: ollamaModels.map(m => ({
              connectionId: conn.id, model: m,
              value: encode(conn.id, m),
              label: `${m} (768 dim)`,
            })),
          })
        }
      }
    }

    return groups
  }, [connections])

  // 当前选中的 embedding 信息
  const selectedEmb = decode(embValue)
  const selectedEmbConn = connMap.get(selectedEmb.connectionId)
  const embDimensions = selectedEmbConn?.provider_type === 'ollama' ? 768 : 3072

  const handleTriggerReembed = async () => {
    setReembedding(true)
    await window.api.embedding.triggerReembed()
    recheckReembed()
  }

  // 即时保存
  const saveNow = useCallback(async (lv: string, sv: string, hv: string, ev: string) => {
    const light = decode(lv)
    const standard = decode(sv)
    const heavy = decode(hv)
    const emb = decode(ev)

    // 推断 provider（向后兼容）
    const getProviderType = (connId: string): string => {
      const conn = connMap.get(connId)
      return conn?.provider_type ?? 'anthropic'
    }

    const dims = getProviderType(emb.connectionId) === 'ollama' ? 768 : 3072

    await window.api.config.update({
      llm: {
        provider: getProviderType(light.connectionId) || 'anthropic',
        light_connection: light.connectionId || undefined,
        light_provider: getProviderType(light.connectionId) || 'anthropic',
        standard_connection: standard.connectionId || undefined,
        standard_provider: getProviderType(standard.connectionId) || 'anthropic',
        heavy_connection: heavy.connectionId || undefined,
        heavy_provider: getProviderType(heavy.connectionId) || 'anthropic',
        light_model: light.model,
        standard_model: standard.model,
        heavy_model: heavy.model,
      },
      embedding: {
        connection: emb.connectionId || undefined,
        provider: getProviderType(emb.connectionId) || 'vertex',
        model: emb.model,
        dimensions: dims,
      },
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    refetchConfig()
  }, [refetchConfig, connMap])

  // debounce 自动保存
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      return
    }
    const timer = setTimeout(() => {
      saveNow(lightValue, standardValue, heavyValue, embValue)
    }, 300)
    return () => clearTimeout(timer)
  }, [lightValue, standardValue, heavyValue, embValue])

  return (
    <div className="space-y-6 max-w-lg">
      {/* ====== LLM ====== */}
      <Section title="LLM">
        <div className="space-y-5">
          <div className="space-y-2">
            <Field label={t('model.selection.lightModel')} tip={t('model.selection.lightModelTip')}>
              <UnifiedModelSelect
                value={lightValue}
                onChange={setLightValue}
                groups={llmGroups}
              />
            </Field>
            <p className="text-[10px] text-gray-500">{t('model.selection.lightModelUsage')}</p>
          </div>

          <div className="space-y-2">
            <Field label={t('model.selection.standardModel')} tip={t('model.selection.standardModelTip')}>
              <UnifiedModelSelect
                value={standardValue}
                onChange={setStandardValue}
                groups={llmGroups}
              />
            </Field>
            <p className="text-[10px] text-gray-500">{t('model.selection.standardModelUsage')}</p>
          </div>

          <div className="space-y-2">
            <Field label={t('model.selection.heavyModel')} tip={t('model.selection.heavyModelTip')}>
              <UnifiedModelSelect
                value={heavyValue}
                onChange={setHeavyValue}
                groups={llmGroups}
              />
            </Field>
            <p className="text-[10px] text-gray-500">{t('model.selection.heavyModelUsage')}</p>
          </div>
        </div>
      </Section>

      {/* ====== Embedding ====== */}
      <Section title="Embedding">
        <div className="space-y-3">
          <Field label={t('model.selection.embeddingModel')} tip={t('model.selection.embeddingModelTip')}>
            <UnifiedModelSelect
              value={embValue}
              onChange={setEmbValue}
              groups={embGroups}
            />
          </Field>
          <div className="flex items-center gap-4">
            <span className="text-[10px] text-gray-500">{t('model.selection.dimensions')}: {embDimensions}</span>
            <span className="text-[10px] text-gray-500">
              {t('model.selection.connectionLabel')}: {selectedEmbConn?.name ?? t('model.selection.notSelected')}
            </span>
          </div>
          <p className="text-[10px] text-gray-500">{t('model.selection.embeddingUsage')}</p>
        </div>

        {/* 重算提示 */}
        {(reembedStatus?.needed || reembedStatus?.running) && (
          <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={12} className="text-amber-400" />
              <p className="text-xs text-amber-300">
                {reembedStatus.running
                  ? t('model.selection.reembedProgress', { done: reembedStatus.done, total: reembedStatus.total })
                  : t('model.selection.reembedNeeded')}
              </p>
            </div>
            {!reembedStatus.running && (
              <button onClick={handleTriggerReembed} disabled={reembedding}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-amber-500/20 hover:bg-amber-500/30 rounded-lg text-amber-300 transition-colors disabled:opacity-50">
                {reembedding && <Loader2 size={12} className="animate-spin" />}
                {t('model.selection.startReembed')}
              </button>
            )}
            {reembedStatus.running && (
              <div className="w-full bg-white/10 rounded-full h-1.5 mt-2">
                <div className="bg-amber-400 h-1.5 rounded-full transition-all"
                  style={{ width: `${reembedStatus.total > 0 ? (reembedStatus.done / reembedStatus.total) * 100 : 0}%` }} />
              </div>
            )}
          </div>
        )}
      </Section>

      {saved && (
        <div className="flex items-center gap-1.5 text-xs text-green-400 transition-opacity">
          <Check size={12} />
          {t('model.selection.saved')}
        </div>
      )}
    </div>
  )
}
