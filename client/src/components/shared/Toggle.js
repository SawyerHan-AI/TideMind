import { jsx as _jsx } from "react/jsx-runtime";
export function Toggle({ enabled, onChange, disabled = false, label }) {
    return (_jsx("button", { role: "switch", "aria-checked": enabled, "aria-label": label, disabled: disabled, onClick: () => !disabled && onChange(!enabled), className: `relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${disabled
            ? 'cursor-not-allowed opacity-40'
            : 'cursor-pointer'} ${enabled
            ? 'bg-indigo-500'
            : 'bg-white/[0.12]'}`, children: _jsx("span", { className: `pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enabled ? 'translate-x-4' : 'translate-x-0'}` }) }));
}
