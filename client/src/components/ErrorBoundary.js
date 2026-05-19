import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Component } from 'react';
import i18n from '../lib/i18n';
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error('React render error:', error, errorInfo);
    }
    render() {
        if (this.state.hasError) {
            return (_jsxs("div", { style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    gap: '16px',
                    color: '#a0a0a0',
                    fontFamily: 'system-ui, sans-serif',
                }, children: [_jsx("h2", { style: { color: '#e0e0e0', fontSize: '18px', margin: 0 }, children: i18n.t('common:errors.somethingWentWrong') }), _jsx("p", { style: { fontSize: '13px', maxWidth: '400px', textAlign: 'center' }, children: this.state.error?.message ?? i18n.t('common:errors.unexpectedError') }), _jsx("button", { onClick: () => this.setState({ hasError: false, error: null }), style: {
                            padding: '8px 16px',
                            background: 'rgba(255,255,255,0.1)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            color: '#e0e0e0',
                            cursor: 'pointer',
                            fontSize: '13px',
                        }, children: i18n.t('common:errors.retry') })] }));
        }
        return this.props.children;
    }
}
