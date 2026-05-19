import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { brand, chartVar } from '../lib/tokens';
/**
 * 四维成熟度雷达图（自定义 SVG，不依赖图表库）
 */
export function MaturityRadar({ heat, refinement, connectivity, independence, size = 80 }) {
    const center = size / 2;
    const maxR = size / 2 - 8;
    // 四个轴：上(heat)、右(refinement)、下(connectivity)、左(independence)
    const values = [
        Math.min(heat / 3, 1), // 归一化 heat
        refinement,
        connectivity,
        independence,
    ];
    const angles = [
        -Math.PI / 2, // 上
        0, // 右
        Math.PI / 2, // 下
        Math.PI, // 左
    ];
    const points = values.map((v, i) => ({
        x: center + Math.cos(angles[i]) * v * maxR,
        y: center + Math.sin(angles[i]) * v * maxR,
    }));
    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
    // 网格线
    const gridLevels = [0.25, 0.5, 0.75, 1];
    return (_jsxs("svg", { width: size, height: size, className: "drop-shadow-sm", children: [gridLevels.map(level => (_jsx("polygon", { points: angles.map(a => `${center + Math.cos(a) * level * maxR},${center + Math.sin(a) * level * maxR}`).join(' '), fill: "none", stroke: chartVar.grid, strokeWidth: 0.5 }, level))), angles.map((a, i) => (_jsx("line", { x1: center, y1: center, x2: center + Math.cos(a) * maxR, y2: center + Math.sin(a) * maxR, stroke: chartVar.grid, strokeWidth: 0.5 }, i))), _jsx("path", { d: pathD, fill: `${brand.primary}33`, stroke: brand.primary, strokeWidth: 1.5 }), points.map((p, i) => (_jsx("circle", { cx: p.x, cy: p.y, r: 2, fill: brand.primary }, i))), _jsx("text", { x: center, y: 4, textAnchor: "middle", className: "fill-gray-500 text-[7px]", children: "H" }), _jsx("text", { x: size - 2, y: center + 3, textAnchor: "end", className: "fill-gray-500 text-[7px]", children: "R" }), _jsx("text", { x: center, y: size - 1, textAnchor: "middle", className: "fill-gray-500 text-[7px]", children: "C" }), _jsx("text", { x: 4, y: center + 3, textAnchor: "start", className: "fill-gray-500 text-[7px]", children: "I" })] }));
}
