import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Save, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoTip } from '../InfoTip';
import { brand, btnText } from '../../lib/tokens';
// ============================================================
// Shared constants & helpers for settings tab components
// ============================================================
export function ComingSoonBadge() {
    const { t } = useTranslation();
    return _jsx("span", { className: "text-[10px] bg-white/5 text-gray-500 px-2 py-0.5 rounded-full", children: t('actions.comingSoon') });
}
export const inputClass = 'w-full px-3 py-2 bg-white/[0.06] border border-white/[0.08] rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/40 focus:bg-white/[0.08] transition-all';
export function Section({ title, action, children }) {
    return (_jsxs("div", { className: "glass-card rounded-xl p-5", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h3", { className: "text-sm font-medium flex items-center gap-2", style: { color: 'var(--fg-secondary)' }, children: title }), action] }), children] }));
}
/** A labeled field with an InfoTip */
export function Field({ label, tip, children, }) {
    return (_jsxs("div", { children: [_jsxs("label", { className: "flex items-center text-xs text-gray-400 mb-1", children: [label, _jsx(InfoTip, { content: tip })] }), children] }));
}
/** Number input with InfoTip and optional unit */
export function NumberField({ label, tip, value, onChange, step = 1, unit, }) {
    return (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "flex-1", children: _jsxs("label", { className: "flex items-center text-xs text-gray-300", children: [label, _jsx(InfoTip, { content: tip })] }) }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("input", { type: "number", value: value, step: step, onChange: e => onChange(parseFloat(e.target.value) || 0), className: "w-24 px-2 py-1.5 bg-white/[0.06] border border-white/[0.08] rounded-lg text-xs text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/40 transition-all" }), unit && _jsx("span", { className: "text-[10px] text-gray-500 w-8", children: unit })] })] }));
}
/** Slider with label, InfoTip, and numeric display */
export function SliderField({ label, tip, value, onChange, min = 0, max = 1, step = 0.05, }) {
    return (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-1", children: [_jsxs("label", { className: "flex items-center text-xs text-gray-300", children: [label, _jsx(InfoTip, { content: tip })] }), _jsx("span", { className: "text-xs text-gray-200 font-mono tabular-nums", children: value.toFixed(2) })] }), _jsx("input", { type: "range", min: min, max: max, step: step, value: value, onChange: e => onChange(parseFloat(e.target.value)), className: "w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer\n          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5\n          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-400 [&::-webkit-slider-thumb]:shadow-lg\n          [&::-webkit-slider-thumb]:hover:bg-indigo-400 [&::-webkit-slider-thumb]:transition-colors" })] }));
}
/** Reusable save button with success state */
export function SaveButton({ saved, onClick }) {
    const { t } = useTranslation();
    return (_jsxs("button", { onClick: onClick, className: "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all", style: {
            background: brand.gradientAlpha,
            border: `1px solid ${brand.secondary}4d`,
            boxShadow: saved ? `0 0 12px ${brand.primary}66` : 'none',
            color: btnText.onBrand,
        }, onMouseEnter: e => (e.currentTarget.style.background = brand.gradientHover), onMouseLeave: e => (e.currentTarget.style.background = brand.gradientAlpha), children: [saved ? _jsx(CheckCircle, { size: 14 }) : _jsx(Save, { size: 14 }), saved ? t('actions.saved') : t('actions.save')] }));
}
