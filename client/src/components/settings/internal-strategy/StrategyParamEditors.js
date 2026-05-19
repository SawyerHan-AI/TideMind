import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { InfoTip } from '../../InfoTip';
// ============================================================
// LLMConfigSection: 策略级 LLM 模型 + 思考配置
// ============================================================
const TIER_OPTION_KEYS = [
    { value: 'light', labelKey: 'strategy.tierLight' },
    { value: 'standard', labelKey: 'strategy.tierStandard' },
    { value: 'heavy', labelKey: 'strategy.tierHeavy' },
];
export function LLMConfigSection({ strategyName }) {
    const { t } = useTranslation('settings');
    const [values, setValues] = useState({});
    const [saving, setSaving] = useState(null);
    useEffect(() => {
        let cancelled = false;
        window.api.config.strategyParams(strategyName).then(params => {
            if (!cancelled)
                setValues(params);
        });
        return () => { cancelled = true; };
    }, [strategyName]);
    const handleChange = async (key, newValue) => {
        const parsed = newValue === 'true' ? true : newValue === 'false' ? false : isNaN(Number(newValue)) ? newValue : Number(newValue);
        setValues(prev => ({ ...prev, [key]: parsed }));
        setSaving(key);
        try {
            await window.api.config.strategyParamUpdate(strategyName, key, newValue);
        }
        catch (err) {
            console.error('LLM config update failed:', err);
        }
        setSaving(null);
    };
    const tier = String(values.llm_tier ?? 'standard');
    const thinkingOn = values.thinking === true;
    const budget = Number(values.thinking_budget ?? 0);
    return (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg text-xs", children: [_jsx("span", { className: "text-indigo-400/70 text-[10px] font-medium shrink-0", children: "LLM" }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-gray-500 text-[10px]", children: t('strategy.modelLabel') }), _jsx("select", { value: tier, onChange: e => handleChange('llm_tier', e.target.value), className: "px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 focus:outline-none focus:border-indigo-400/50 cursor-pointer", children: TIER_OPTION_KEYS.map(o => (_jsx("option", { value: o.value, children: t(o.labelKey) }, o.value))) }), saving === 'llm_tier' && _jsx(Loader2, { size: 9, className: "animate-spin text-indigo-400" })] }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-gray-500 text-[10px]", children: t('strategy.thinkingLabel') }), _jsx("button", { onClick: () => handleChange('thinking', thinkingOn ? 'false' : 'true'), className: `px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${thinkingOn
                            ? 'bg-indigo-400/20 text-indigo-300 border border-indigo-400/30'
                            : 'bg-white/5 text-gray-500 border border-white/10'}`, children: thinkingOn ? t('strategy.thinkingOn') : t('strategy.thinkingOff') }), saving === 'thinking' && _jsx(Loader2, { size: 9, className: "animate-spin text-indigo-400" })] }), thinkingOn && (_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-gray-500 text-[10px]", children: t('strategy.budgetLabel') }), _jsx("input", { type: "number", value: budget, step: 512, min: 256, onChange: e => handleChange('thinking_budget', e.target.value), className: "w-16 px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50" }), _jsx("span", { className: "text-gray-600 text-[10px]", children: "tokens" }), saving === 'thinking_budget' && _jsx(Loader2, { size: 9, className: "animate-spin text-indigo-400" })] }))] }));
}
// ============================================================
// EditableStrategyParams: 策略文件参数（可编辑）
// ============================================================
export function EditableStrategyParams({ params }) {
    const { t } = useTranslation('settings');
    const strategyNames = [...new Set(params.map(p => p.strategyName))];
    const [values, setValues] = useState({});
    const [saving, setSaving] = useState(null);
    useEffect(() => {
        let cancelled = false;
        Promise.all(strategyNames.map(async (name) => {
            const p = await window.api.config.strategyParams(name);
            return [name, p];
        })).then(results => {
            if (cancelled)
                return;
            const map = {};
            for (const [name, p] of results)
                map[name] = p;
            setValues(map);
        });
        return () => { cancelled = true; };
    }, [strategyNames.join(',')]);
    const handleChange = async (strategyName, key, newValue) => {
        setValues(prev => ({
            ...prev,
            [strategyName]: { ...prev[strategyName], [key]: isNaN(Number(newValue)) ? newValue : Number(newValue) },
        }));
        setSaving(key);
        try {
            await window.api.config.strategyParamUpdate(strategyName, key, newValue);
        }
        catch (err) {
            console.error('Strategy param update failed:', err);
        }
        setSaving(null);
    };
    return (_jsx(_Fragment, { children: params.map(p => {
            const val = values[p.strategyName]?.[p.key];
            return (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "flex-1", children: _jsxs("label", { className: "flex items-center text-xs text-gray-300", children: [t(p.label), _jsx(InfoTip, { content: t(p.tip) }), saving === p.key && _jsx(Loader2, { size: 10, className: "ml-1 animate-spin text-indigo-400" })] }) }), _jsx("input", { type: "number", value: val !== undefined ? String(val) : '', step: p.step ?? 1, onChange: e => handleChange(p.strategyName, p.key, e.target.value), className: "w-24 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50" })] }, `${p.strategyName}-${p.key}`));
        }) }));
}
