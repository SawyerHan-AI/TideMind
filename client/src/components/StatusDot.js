import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StatusDot({ online, label }) {
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${online === null ? 'bg-gray-500' : online ? 'bg-emerald-400' : 'bg-red-400'}` }), _jsx("span", { className: "text-xs text-gray-400", children: label })] }));
}
