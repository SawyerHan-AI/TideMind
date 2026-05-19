import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function HeatIndicator({ heat, className = '' }) {
    // heat 范围 0-10，映射到颜色
    const normalized = Math.min(heat / 3, 1); // 3 以上就算很热了
    const hue = 220 - normalized * 180; // 蓝(220) → 橙(40) → 红(0)
    const saturation = 30 + normalized * 50;
    const lightness = 40 + normalized * 15;
    return (_jsxs("div", { className: `flex items-center gap-1.5 ${className}`, children: [_jsx("div", { className: "w-12 h-1.5 rounded-full bg-white/10 overflow-hidden", children: _jsx("div", { className: "h-full rounded-full transition-all duration-500", style: {
                        width: `${Math.min(normalized * 100, 100)}%`,
                        backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
                    } }) }), _jsx("span", { className: "text-xs text-gray-500 tabular-nums", children: heat.toFixed(1) })] }));
}
