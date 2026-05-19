import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, X } from 'lucide-react';
export function ProfileFieldsEditor({ strategyName }) {
    const { t } = useTranslation('settings');
    const [fields, setFields] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const saveTimer = useRef(null);
    const latestFields = useRef([]);
    useEffect(() => {
        let cancelled = false;
        window.api.config.strategyParams(strategyName).then(params => {
            if (cancelled)
                return;
            try {
                const raw = params.profile_fields;
                if (typeof raw === 'string') {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        // 兼容旧数据：补上缺失的 id
                        const withIds = parsed.map((f) => ({
                            id: f.id ?? crypto.randomUUID(),
                            name: f.name ?? '',
                            description: f.description ?? '',
                        }));
                        setFields(withIds);
                        latestFields.current = withIds;
                    }
                }
            }
            catch { /* use empty */ }
            setLoaded(true);
        });
        return () => { cancelled = true; };
    }, [strategyName]);
    // 组件卸载时 flush 未保存的变更
    useEffect(() => {
        return () => {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
                // 同步触发最后一次保存（fire-and-forget）
                window.api.config.strategyParamUpdate(strategyName, 'profile_fields', JSON.stringify(latestFields.current)).catch(err => console.error('Flush save failed:', err));
            }
        };
    }, [strategyName]);
    const persist = async (updated) => {
        setSaving(true);
        try {
            await window.api.config.strategyParamUpdate(strategyName, 'profile_fields', JSON.stringify(updated));
        }
        catch (err) {
            console.error('Failed to save profile fields:', err);
        }
        setSaving(false);
    };
    /** 延迟保存：500ms 内连续变更只写一次 */
    const scheduleSave = (updated) => {
        latestFields.current = updated;
        if (saveTimer.current)
            clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            persist(latestFields.current);
            saveTimer.current = null;
        }, 500);
    };
    const updateField = (index, key, value) => {
        const updated = [...fields];
        updated[index] = { ...updated[index], [key]: value };
        setFields(updated);
        scheduleSave(updated);
    };
    const addField = () => {
        const updated = [...fields, { id: crypto.randomUUID(), name: '', description: '' }];
        setFields(updated);
        scheduleSave(updated);
    };
    const removeField = (index) => {
        const updated = fields.filter((_, i) => i !== index);
        setFields(updated);
        scheduleSave(updated);
    };
    if (!loaded)
        return null;
    return (_jsxs("div", { className: "mb-3 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-xs text-gray-400", children: t('strategy.nodes.profileSynthesize.fieldsTitle') }), saving && _jsx(Loader2, { size: 10, className: "animate-spin text-indigo-400" })] }), fields.map((field, i) => (_jsxs("div", { className: "flex items-start gap-2", children: [_jsx("input", { type: "text", value: field.name, placeholder: t('strategy.nodes.profileSynthesize.fieldName'), onChange: e => updateField(i, 'name', e.target.value), className: "w-28 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 font-mono focus:outline-none focus:border-indigo-400/50" }), _jsx("input", { type: "text", value: field.description, placeholder: t('strategy.nodes.profileSynthesize.fieldDesc'), onChange: e => updateField(i, 'description', e.target.value), className: "flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50" }), _jsx("button", { onClick: () => removeField(i), className: "p-1.5 text-gray-500 hover:text-red-400 transition-colors", children: _jsx(X, { size: 12 }) })] }, field.id))), _jsxs("button", { onClick: addField, className: "flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors", children: [_jsx(Plus, { size: 12 }), t('strategy.nodes.profileSynthesize.addField')] })] }));
}
