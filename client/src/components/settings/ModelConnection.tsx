import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, ChevronRight, Loader2, CheckCircle2, XCircle,
  Pencil, Check, X, Archive, RotateCcw, Trash2, Upload,
  MoreHorizontal, Link,
} from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { Section, Field, inputClass, ComingSoonBadge } from './shared'
import { safeJsonParse } from '../../lib/json'

// ============================================================
// Provider 类型定义
// ============================================================

interface ProviderTypeDef {
  id: string
  label: string
  comingSoon?: boolean
}

const PROVIDER_TYPES: ProviderTypeDef[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'vertex', label: 'Google Vertex AI' },
  { id: 'gemini', label: 'Google Gemini API' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'openai-compatible', label: 'OpenAI Compatible' },
]

const VERTEX_REGIONS = [
  'us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-west1',
  'europe-west1', 'europe-west4', 'asia-northeast1', 'asia-southeast1',
]

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  vertex: 'Vertex AI',
  gemini: 'Gemini API',
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI Compatible',
}

function getProviderDef(providerType: string): ProviderTypeDef | undefined {
  return PROVIDER_TYPES.find(t => t.id === providerType)
}

/** 生成 4 位随机后缀 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

// ============================================================
// 连接数据类型
// ============================================================

interface Connection {
  id: string
  name: string
  provider_type: string
  credentials: string
  status: string
  available_models: string | null
  last_checked: string | null
  archived: number
  created: string
}

// ============================================================
// 连接详情面板
// ============================================================

function ConnectionDetailPanel({ conn, onRefresh }: { conn: Connection; onRefresh: () => void }) {
  const { t } = useTranslation('settings')
  const creds = safeJsonParse<Record<string, string>>(conn.credentials || '{}', {})

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(conn.name)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ online: boolean; models: string[]; error?: string } | null>(null)

  const [apiKey, setApiKey] = useState(creds.api_key ?? '')
  const [projectId, setProjectId] = useState(creds.project_id ?? '')
  const [region, setRegion] = useState(creds.region ?? 'us-central1')
  const [uploading, setUploading] = useState(false)
  const [vertexCredStatus, setVertexCredStatus] = useState<{ configured: boolean; projectId?: string } | null>(null)
  const [geminiKey, setGeminiKey] = useState(creds.api_key ?? '')
  const [ollamaUrl, setOllamaUrl] = useState(creds.url ?? 'http://localhost:11434')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(creds.base_url ?? '')
  const [openaiApiKey, setOpenaiApiKey] = useState(creds.api_key ?? '')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (conn.provider_type === 'vertex') {
      window.api.connections.vertexCredStatus(conn.id).then(setVertexCredStatus)
    }
  }, [conn.id, conn.provider_type])

  const handleRename = async () => {
    if (!editName.trim()) return
    await window.api.connections.update(conn.id, { name: editName.trim() })
    setEditing(false)
    onRefresh()
  }

  const handleSaveCredentials = async () => {
    let credentials: Record<string, unknown>
    switch (conn.provider_type) {
      case 'anthropic': credentials = { api_key: apiKey }; break
      case 'vertex': credentials = { project_id: projectId, region }; break
      case 'gemini': credentials = { api_key: geminiKey }; break
      case 'ollama': credentials = { url: ollamaUrl }; break
      case 'openai-compatible': credentials = { base_url: openaiBaseUrl, api_key: openaiApiKey }; break
      default: return
    }
    await window.api.connections.update(conn.id, { credentials })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    onRefresh()
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    await handleSaveCredentials()
    try {
      const result = await window.api.connections.test(conn.id)
      setTestResult(result)
    } catch (e) {
      setTestResult({ online: false, models: [], error: (e as Error).message })
    }
    setTesting(false)
    onRefresh()
  }

  const handleArchive = async () => {
    await window.api.connections.archive(conn.id)
    onRefresh()
  }

  const handleUploadVertex = async () => {
    setUploading(true)
    try {
      const result = await window.api.connections.pickVertexFile(conn.id)
      if (result.success && result.projectId) setProjectId(result.projectId)
      setVertexCredStatus(result.success ? { configured: true, projectId: result.projectId } : { configured: false })
    } catch {}
    setUploading(false)
  }

  return (
    <div className="px-3 pb-4 pt-3 border-t border-white/5 space-y-4">
      {/* 名称编辑 */}
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <input value={editName} onChange={e => setEditName(e.target.value)}
              className={`${inputClass} flex-1`} autoFocus
              onKeyDown={e => e.key === 'Enter' && handleRename()} />
            <button onClick={handleRename} className="p-1 text-emerald-400 hover:bg-white/5 rounded"><Check size={14} /></button>
            <button onClick={() => { setEditing(false); setEditName(conn.name) }} className="p-1 text-gray-400 hover:bg-white/5 rounded"><X size={14} /></button>
          </>
        ) : (
          <button onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors">
            <Pencil size={11} /> {t('model.connection.rename')}
          </button>
        )}
      </div>

      {/* 凭据表单 */}
      {conn.provider_type === 'anthropic' && (
        <Field label="API Key" tip={t('model.connection.anthropicTip')}>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-..." className={inputClass} />
        </Field>
      )}

      {conn.provider_type === 'vertex' && (
        <div className="space-y-3">
          <Field label="Project ID" tip={t('model.connection.vertexProjectTip')}>
            <input value={projectId} onChange={e => setProjectId(e.target.value)}
              placeholder="my-gcp-project" className={inputClass} />
          </Field>
          <Field label="Region" tip={t('model.connection.vertexRegionTip')}>
            <select value={region} onChange={e => setRegion(e.target.value)} className={inputClass}>
              {VERTEX_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">{t('model.connection.vertexCredLabel')}</label>
            <div className="flex items-center gap-3">
              <button onClick={handleUploadVertex} disabled={uploading}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50">
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {t('model.connection.selectFile')}
              </button>
              {vertexCredStatus?.configured && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                  <CheckCircle2 size={10} />
                  {t('model.connection.uploaded')}{vertexCredStatus.projectId && ` (${vertexCredStatus.projectId})`}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {conn.provider_type === 'gemini' && (
        <Field label="API Key" tip={t('model.connection.geminiTip')}>
          <input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)}
            placeholder="AIza..." className={inputClass} />
        </Field>
      )}

      {conn.provider_type === 'ollama' && (
        <Field label={t('model.connection.serviceUrl')} tip={t('model.connection.ollamaTip')}>
          <input value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} className={inputClass} />
        </Field>
      )}

      {conn.provider_type === 'openai-compatible' && (
        <div className="space-y-3">
          <Field label="Base URL" tip={t('model.connection.openaiBaseUrlTip')}>
            <input value={openaiBaseUrl} onChange={e => setOpenaiBaseUrl(e.target.value)}
              placeholder="http://localhost:8000" className={inputClass} />
          </Field>
          <Field label="API Key" tip={t('model.connection.openaiApiKeyTip')}>
            <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)}
              placeholder={t('model.connection.openaiApiKeyPlaceholder')} className={inputClass} />
          </Field>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button onClick={handleTest} disabled={testing}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors disabled:opacity-50">
          {testing && <Loader2 size={12} className="animate-spin" />}
          {t('model.connection.testConnection')}
        </button>
        <button onClick={handleArchive}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded-lg transition-colors">
          <Archive size={11} /> {t('model.connection.archive')}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400"><Check size={10} /> {t('model.connection.saved')}</span>
        )}
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={`p-2.5 rounded-lg text-[11px] ${
          testResult.online ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'
        }`}>
          {testResult.online ? (
            <>
              <div className="flex items-center gap-1.5 text-emerald-400 mb-1.5">
                <CheckCircle2 size={11} />
                <span>{t('model.connection.modelsAvailable', { count: testResult.models.length })}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {testResult.models.map(m => (
                  <span key={m} className="text-[10px] bg-white/5 text-gray-300 px-1.5 py-0.5 rounded">{m}</span>
                ))}
              </div>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-red-400">
              <XCircle size={11} />
              {testResult.error ?? t('model.connection.connectionFailed')}
            </span>
          )}
        </div>
      )}

      {/* 连接 ID */}
      <div className="text-[10px] text-gray-600">ID: {conn.id}</div>
    </div>
  )
}

// ============================================================
// 创建向导
// ============================================================

function ConnectionWizard({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState('')
  const [providerType, setProviderType] = useState('')
  const [creating, setCreating] = useState(false)
  // 追踪名称是否被用户手动修改过
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)

  // 选择类型后自动更新名称（除非用户已手动编辑）
  useEffect(() => {
    if (providerType && !nameManuallyEdited) {
      const def = getProviderDef(providerType)
      if (def) setName(`${def.label} ${randomSuffix()}`)
    }
  }, [providerType, nameManuallyEdited])

  const handleNameChange = (v: string) => {
    setName(v)
    setNameManuallyEdited(true)
  }

  const handleCreate = async () => {
    if (!name.trim() || !providerType) return
    setCreating(true)
    const conn = await window.api.connections.create({
      name: name.trim(),
      provider_type: providerType,
    })
    setCreating(false)
    onCreated(conn.id)
  }

  return (
    <Section title={t('model.connection.newConnection')} action={
      <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300"><X size={14} /></button>
    }>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {PROVIDER_TYPES.map(pt => (
            <button
              key={pt.id}
              disabled={pt.comingSoon}
              onClick={() => setProviderType(pt.id)}
              className={`p-3 rounded-lg text-left transition-all ${
                pt.comingSoon
                  ? 'opacity-40 cursor-not-allowed bg-white/[0.02]'
                  : providerType === pt.id
                    ? 'bg-indigo-500/10 border border-indigo-400/30'
                    : 'bg-white/[0.03] hover:bg-white/[0.06] border border-white/5'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-200">{pt.label}</span>
                {pt.comingSoon && <ComingSoonBadge />}
              </div>
              <p className="text-[10px] text-gray-500 mt-1">{t(`model.connection.providerDesc.${pt.id}`)}</p>
            </button>
          ))}
        </div>

        {providerType && (
          <Field label={t('model.connection.connectionName')} tip={t('model.connection.connectionNameTip')}>
            <input value={name} onChange={e => handleNameChange(e.target.value)}
              placeholder={t('model.connection.connectionNamePlaceholder', { provider: PROVIDER_LABELS[providerType] ?? providerType })}
              className={inputClass} autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreate()} />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors">
            {t('model.connection.cancel')}
          </button>
          <button onClick={handleCreate} disabled={!name.trim() || !providerType || creating}
            className="flex items-center gap-2 px-4 py-1.5 text-xs bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 rounded-lg transition-colors disabled:opacity-50">
            {creating && <Loader2 size={12} className="animate-spin" />}
            {t('model.connection.create')}
          </button>
        </div>
      </div>
    </Section>
  )
}

// ============================================================
// 主组件（表格行布局，与 AgentIntegration 一致）
// ============================================================

export function ModelConnection() {
  const { t } = useTranslation('settings')
  const { data: connections, refetch: refetchConnections } = useIPC(() => window.api.connections.list(true))
  const { data: config } = useIPC(() => window.api.config.get())

  const [wizardOpen, setWizardOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const activeConns = (connections ?? []).filter((c: Connection) => !c.archived)
  const archivedConns = (connections ?? []).filter((c: Connection) => c.archived)

  // 检查连接是否被模型选择引用
  const getUsages = (connId: string): string[] => {
    if (!config) return []
    const c = config as any
    const usages: string[] = []
    const llmConns = [c.llm?.light_connection, c.llm?.standard_connection, c.llm?.heavy_connection]
    if (llmConns.includes(connId)) usages.push('LLM')
    if (c.embedding?.connection === connId) usages.push('Embedding')
    return usages
  }

  const getStatusInfo = (conn: Connection) => {
    if (conn.status === 'online') return { color: 'bg-emerald-400', textColor: 'text-emerald-400', label: t('model.connection.status.online') }
    if (conn.status === 'offline') return { color: 'bg-red-400', textColor: 'text-red-400', label: t('model.connection.status.offline') }
    return { color: 'bg-gray-600', textColor: 'text-gray-500', label: t('model.connection.status.unconfigured') }
  }

  const handleCreated = (id: string) => {
    setWizardOpen(false)
    setExpandedId(id)
    refetchConnections()
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* 已配置连接 */}
      <Section title={t('model.connection.configuredConnections')}>
        <p className="text-xs text-gray-500 mb-4">
          {t('model.connection.description')}
        </p>

        {activeConns.length === 0 && !wizardOpen && (
          <div className="py-8 text-center text-xs text-gray-500">
            {t('model.connection.noConnections')}
          </div>
        )}

        {activeConns.length > 0 && (
          <div className="space-y-0.5">
            {/* 表头 */}
            <div className="grid grid-cols-[10rem_6rem_4rem_5rem_1fr_3rem] gap-x-4 items-center px-3 py-2 text-[11px] text-gray-500 font-medium border-b border-white/5">
              <span>{t('model.connection.colName')}</span>
              <span>{t('model.connection.colType')}</span>
              <span>{t('model.connection.colStatus')}</span>
              <span>{t('model.connection.colModels')}</span>
              <span>{t('model.connection.colUsage')}</span>
              <span></span>
            </div>

            {activeConns.map((conn: Connection) => {
              const status = getStatusInfo(conn)
              const models = safeJsonParse<string[]>(conn.available_models, [])
              const usages = getUsages(conn.id)
              const isExpanded = expandedId === conn.id

              return (
                <div key={conn.id}>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : conn.id)}
                    className="w-full grid grid-cols-[10rem_6rem_4rem_5rem_1fr_3rem] gap-x-4 items-center px-3 py-2.5 hover:bg-white/[0.03] rounded-lg transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Link size={14} className="text-gray-500 flex-shrink-0" />
                      <span className="text-xs text-gray-200 font-medium truncate">{conn.name}</span>
                    </div>
                    <span className="text-xs text-gray-400 truncate">
                      {PROVIDER_LABELS[conn.provider_type] ?? conn.provider_type}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${status.color}`} />
                      <span className={`text-xs ${status.textColor}`}>{status.label}</span>
                    </div>
                    <span className="text-xs text-gray-400 tabular-nums">
                      {models.length > 0 ? t('model.connection.modelCount', { count: models.length }) : '-'}
                    </span>
                    <div className="flex gap-1">
                      {usages.map(u => (
                        <span key={u} className="text-[10px] bg-indigo-400/10 text-indigo-300 px-1.5 py-0.5 rounded">{u}</span>
                      ))}
                    </div>
                    <span className="flex justify-end">
                      <MoreHorizontal size={14} className="text-gray-500" />
                    </span>
                  </button>

                  {isExpanded && (
                    <ConnectionDetailPanel conn={conn} onRefresh={refetchConnections} />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 已归档 */}
        {archivedConns.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              {t('model.connection.archived')} ({archivedConns.length})
            </button>
            {showArchived && (
              <div className="mt-2 space-y-0.5 pl-2 border-l border-white/5">
                {archivedConns.map((conn: Connection) => (
                  <div key={conn.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                      <Link size={14} className="text-gray-600" />
                      <span className="text-xs text-gray-500">{conn.name}</span>
                      <span className="text-[10px] text-gray-600">
                        {PROVIDER_LABELS[conn.provider_type] ?? conn.provider_type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          await window.api.connections.unarchive(conn.id)
                          refetchConnections()
                        }}
                        className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        <RotateCcw size={10} /> {t('model.connection.restore')}
                      </button>
                      {confirmDelete === conn.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-red-400">{t('model.connection.confirmDelete')}?</span>
                          <button
                            onClick={async () => {
                              await window.api.connections.delete(conn.id)
                              setConfirmDelete(null)
                              refetchConnections()
                            }}
                            className="text-[10px] text-red-400 hover:text-red-300 font-medium"
                          >{t('model.connection.confirm')}</button>
                          <button onClick={() => setConfirmDelete(null)}
                            className="text-[10px] text-gray-500 hover:text-gray-300"
                          >{t('model.connection.cancel')}</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDelete(conn.id)}
                          className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={10} /> {t('model.connection.delete')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* 配置新连接 */}
      {!wizardOpen ? (
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-gray-300 transition-colors border border-white/5"
        >
          <Plus size={14} />
          {t('model.connection.newConnection')}
        </button>
      ) : (
        <ConnectionWizard
          onCreated={handleCreated}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  )
}
