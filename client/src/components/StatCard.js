import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import { useEffect } from 'react';
import { InfoTip } from './InfoTip';
import { brand } from '../lib/tokens';
export function StatCard({ icon: Icon, label, value, color = brand.primary, tip }) {
    const count = useMotionValue(0);
    const rounded = useTransform(count, v => Math.round(v));
    useEffect(() => {
        const controls = animate(count, value, { duration: 0.8, ease: 'easeOut' });
        return controls.stop;
    }, [value]);
    return (_jsx("div", { className: "glass-card rounded-xl p-4", children: _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "p-2 rounded-lg", style: { backgroundColor: `${color}20` }, children: _jsx(Icon, { size: 18, style: { color } }) }), _jsxs("div", { children: [_jsx(motion.p, { className: "text-2xl font-bold text-white tabular-nums", children: rounded }), _jsxs("p", { className: "text-xs text-gray-400 mt-0.5", children: [label, tip && _jsx(InfoTip, { content: tip })] })] })] }) }));
}
