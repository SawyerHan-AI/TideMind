import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function Skeleton({ className = '' }) {
    return _jsx("div", { className: `skeleton rounded ${className}` });
}
export function SkeletonCard() {
    return (_jsxs("div", { className: "glass-card rounded-xl p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Skeleton, { className: "h-5 w-14" }), _jsx(Skeleton, { className: "h-3 w-20" })] }), _jsx(Skeleton, { className: "h-4 w-full" }), _jsx(Skeleton, { className: "h-4 w-3/4" }), _jsxs("div", { className: "flex items-center gap-3 pt-1", children: [_jsx(Skeleton, { className: "h-3 w-16" }), _jsx(Skeleton, { className: "h-1.5 w-12" })] })] }));
}
export function SkeletonRow() {
    return (_jsxs("div", { className: "flex items-center gap-4 px-4 py-3", children: [_jsx(Skeleton, { className: "h-4 w-24" }), _jsx(Skeleton, { className: "h-5 w-16" }), _jsx(Skeleton, { className: "h-4 w-40 flex-1" }), _jsx(Skeleton, { className: "h-4 w-12" })] }));
}
