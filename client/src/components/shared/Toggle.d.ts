/**
 * Generic toggle switch component.
 * Used in Cloud Tab for data sync / metabolism toggles.
 */
interface ToggleProps {
    enabled: boolean;
    onChange: (enabled: boolean) => void;
    disabled?: boolean;
    label?: string;
}
export declare function Toggle({ enabled, onChange, disabled, label }: ToggleProps): import("react/jsx-runtime").JSX.Element;
export {};
