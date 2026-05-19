import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckCircle, XCircle } from 'lucide-react';
export function VerifyItem({ ok, label, hint }) {
    return (_jsxs("div", { className: "flex items-start gap-2 px-3 py-2 bg-white/[0.02] rounded-lg", children: [ok ? (_jsx(CheckCircle, { size: 14, className: "text-emerald-400 mt-0.5 flex-shrink-0" })) : (_jsx(XCircle, { size: 14, className: "text-gray-500 mt-0.5 flex-shrink-0" })), _jsxs("div", { children: [_jsx("span", { className: `text-xs ${ok ? 'text-gray-200' : 'text-gray-400'}`, children: label }), hint && _jsx("p", { className: "text-[10px] text-gray-500 mt-0.5", children: hint })] })] }));
}
