/**
 * Confirm dialog with overlay backdrop.
 * Used for destructive or significant actions (toggle cloud sync, delete account, etc.)
 */
interface ConfirmDialogProps {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
    description?: string;
    children?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
}
export declare function ConfirmDialog({ open, onConfirm, onCancel, title, description, children, confirmText, cancelText, danger, }: ConfirmDialogProps): import("react").ReactPortal | null;
export {};
