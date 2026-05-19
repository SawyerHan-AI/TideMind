import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Confirm dialog with overlay backdrop.
 * Used for destructive or significant actions (toggle cloud sync, delete account, etc.)
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { brand, btnText } from '../../lib/tokens';
export function ConfirmDialog({ open, onConfirm, onCancel, title, description, children, confirmText, cancelText, danger = false, }) {
    const { t } = useTranslation('common');
    const resolvedConfirmText = confirmText ?? t('actions.confirm');
    const resolvedCancelText = cancelText ?? t('actions.cancel');
    const cancelRef = useRef(null);
    useEffect(() => {
        if (open)
            cancelRef.current?.focus();
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        const handler = (e) => {
            if (e.key === 'Escape')
                onCancel();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onCancel]);
    if (!open)
        return null;
    return createPortal(_jsxs("div", { className: "fixed inset-0 z-50 flex items-center justify-center", children: [_jsx("div", { className: "absolute inset-0 bg-black/60 backdrop-blur-sm", onClick: onCancel }), _jsxs("div", { className: "relative w-full max-w-md mx-4 rounded-xl p-6 shadow-2xl border border-white/[0.08]", style: { background: 'var(--theme-glass-bg, #1a1a2e)' }, children: [_jsx("h3", { className: "text-sm font-semibold text-gray-100 mb-2", children: title }), description && (_jsx("p", { className: "text-xs text-gray-400 mb-4 leading-relaxed", children: description })), children && _jsx("div", { className: "mb-4", children: children }), _jsxs("div", { className: "flex justify-end gap-3", children: [_jsx("button", { ref: cancelRef, onClick: onCancel, className: "px-4 py-2 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all", style: { background: 'var(--theme-glass-bg, transparent)' }, children: resolvedCancelText }), _jsx("button", { onClick: onConfirm, className: "px-4 py-2 rounded-lg text-xs font-medium transition-all", style: danger
                                    ? {
                                        background: 'rgba(239, 68, 68, 0.15)',
                                        border: '1px solid rgba(239, 68, 68, 0.3)',
                                        color: '#f87171',
                                    }
                                    : {
                                        background: brand.gradientAlpha,
                                        border: `1px solid ${brand.secondary}4d`,
                                        color: btnText.onBrand,
                                    }, children: resolvedConfirmText })] })] })] }), document.body);
}
