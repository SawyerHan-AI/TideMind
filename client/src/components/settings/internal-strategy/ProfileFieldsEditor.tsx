import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, X } from 'lucide-react'

// ============================================================
// ProfileFieldsEditor
// ============================================================

interface ProfileField {
  id: string
  name: string
  description: string
}

export function ProfileFieldsEditor({ strategyName }: { strategyName: string }) {
  const { t } = useTranslation('settings')
  const [fields, setFields] = useState<ProfileField[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestFields = useRef<ProfileField[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.config.strategyParams(strategyName).then(params => {
      if (cancelled) return
      try {
        const raw = params.profile_fields
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            // 兼容旧数据：补上缺失的 id
            const withIds: ProfileField[] = parsed.map((f: Partial<ProfileField>) => ({
              id: f.id ?? crypto.randomUUID(),
              name: f.name ?? '',
              description: f.description ?? '',
            }))
            setFields(withIds)
            latestFields.current = withIds
          }
        }
      } catch { /* use empty */ }
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [strategyName])

  // 组件卸载时 flush 未保存的变更
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        // 同步触发最后一次保存（fire-and-forget）
        window.api.config.strategyParamUpdate(
          strategyName,
          'profile_fields',
          JSON.stringify(latestFields.current),
        ).catch(err => console.error('Flush save failed:', err))
      }
    }
  }, [strategyName])

  const persist = async (updated: ProfileField[]) => {
    setSaving(true)
    try {
      await window.api.config.strategyParamUpdate(strategyName, 'profile_fields', JSON.stringify(updated))
    } catch (err) {
      console.error('Failed to save profile fields:', err)
    }
    setSaving(false)
  }

  /** 延迟保存：500ms 内连续变更只写一次 */
  const scheduleSave = (updated: ProfileField[]) => {
    latestFields.current = updated
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      persist(latestFields.current)
      saveTimer.current = null
    }, 500)
  }

  const updateField = (index: number, key: keyof ProfileField, value: string) => {
    const updated = [...fields]
    updated[index] = { ...updated[index], [key]: value }
    setFields(updated)
    scheduleSave(updated)
  }

  const addField = () => {
    const updated = [...fields, { id: crypto.randomUUID(), name: '', description: '' }]
    setFields(updated)
    scheduleSave(updated)
  }

  const removeField = (index: number) => {
    const updated = fields.filter((_, i) => i !== index)
    setFields(updated)
    scheduleSave(updated)
  }

  if (!loaded) return null

  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">{t('strategy.nodes.profileSynthesize.fieldsTitle')}</span>
        {saving && <Loader2 size={10} className="animate-spin text-indigo-400" />}
      </div>
      {fields.map((field, i) => (
        <div key={field.id} className="flex items-start gap-2">
          <input
            type="text"
            value={field.name}
            placeholder={t('strategy.nodes.profileSynthesize.fieldName')}
            onChange={e => updateField(i, 'name', e.target.value)}
            className="w-28 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 font-mono focus:outline-none focus:border-indigo-400/50"
          />
          <input
            type="text"
            value={field.description}
            placeholder={t('strategy.nodes.profileSynthesize.fieldDesc')}
            onChange={e => updateField(i, 'description', e.target.value)}
            className="flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50"
          />
          <button
            onClick={() => removeField(i)}
            className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={addField}
        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        <Plus size={12} />
        {t('strategy.nodes.profileSynthesize.addField')}
      </button>
    </div>
  )
}
