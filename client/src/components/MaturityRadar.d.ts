/**
 * 四维成熟度雷达图（自定义 SVG，不依赖图表库）
 */
export declare function MaturityRadar({ heat, refinement, connectivity, independence, size }: {
    heat: number;
    refinement: number;
    connectivity: number;
    independence: number;
    size?: number;
}): import("react/jsx-runtime").JSX.Element;
