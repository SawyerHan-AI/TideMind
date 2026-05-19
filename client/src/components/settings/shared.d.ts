export declare function ComingSoonBadge(): import("react/jsx-runtime").JSX.Element;
export declare const inputClass = "w-full px-3 py-2 bg-white/[0.06] border border-white/[0.08] rounded-lg text-sm text-gray-200 focus:outline-none focus:border-indigo-400/40 focus:bg-white/[0.08] transition-all";
export declare function Section({ title, action, children }: {
    title: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/** A labeled field with an InfoTip */
export declare function Field({ label, tip, children, }: {
    label: string;
    tip: string;
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/** Number input with InfoTip and optional unit */
export declare function NumberField({ label, tip, value, onChange, step, unit, }: {
    label: string;
    tip: string;
    value: number;
    onChange: (v: number) => void;
    step?: number;
    unit?: string;
}): import("react/jsx-runtime").JSX.Element;
/** Slider with label, InfoTip, and numeric display */
export declare function SliderField({ label, tip, value, onChange, min, max, step, }: {
    label: string;
    tip: string;
    value: number;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
}): import("react/jsx-runtime").JSX.Element;
/** Reusable save button with success state */
export declare function SaveButton({ saved, onClick }: {
    saved: boolean;
    onClick: () => void;
}): import("react/jsx-runtime").JSX.Element;
