/**
 * tokens.ts — 所有颜色的单一来源
 *
 * 规则：
 * - 品牌色 / 语义色不随主题变，直接用 hex
 * - 图表 UI 色随主题变，通过 CSS 变量桥接（global.css 定义深色/浅色值）
 * - 其他文件的颜色常量应引用此文件，不重复写 hex
 */
export declare const brand: {
    readonly primary: "#818cf8";
    readonly secondary: "#a78bfa";
    /** 标准品牌渐变（按钮、强调区域） */
    readonly gradient: "linear-gradient(135deg, #818cf8, #a78bfa)";
    /** 半透明品牌渐变（悬浮态按钮） */
    readonly gradientAlpha: "linear-gradient(135deg, rgba(129,140,248,0.8), rgba(167,139,250,0.8))";
    /** hover 态品牌渐变 */
    readonly gradientHover: "linear-gradient(135deg, rgba(129,140,248,0.95), rgba(167,139,250,0.95))";
};
export declare const btnText: {
    /** 品牌色 / 彩色背景上的文字，深浅主题都保持白色 */
    readonly onBrand: "#ffffff";
};
export declare const semantic: {
    readonly blue: "#3b82f6";
    readonly teal: "#14b8a6";
    readonly purple: "#a855f7";
    readonly amber: "#f59e0b";
    readonly green: "#10b981";
    readonly red: "#ef4444";
    readonly gray: "#6b7280";
    readonly orange: "#f97316";
};
export declare const chartVar: {
    readonly tick: "var(--chart-tick)";
    readonly tooltipBg: "var(--chart-tooltip-bg)";
    readonly tooltipText: "var(--chart-tooltip-text)";
    readonly grid: "var(--chart-grid)";
};
/** 派生分类 → 颜色 */
export declare const nodeColors: Record<string, string>;
/** 关系类型 → 颜色 */
export declare const relationColors: Record<string, string>;
/** LLM 模型 → 颜色 */
export declare const modelColors: Record<string, string>;
/** 5 大内部策略类别 → 颜色 */
export declare const categoryColors: Record<string, string>;
