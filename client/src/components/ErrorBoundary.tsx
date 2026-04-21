import { Component, type ReactNode } from 'react'
import i18n from '../lib/i18n'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('React render error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '16px',
          color: '#a0a0a0',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <h2 style={{ color: '#e0e0e0', fontSize: '18px', margin: 0 }}>
            {i18n.t('common:errors.somethingWentWrong')}
          </h2>
          <p style={{ fontSize: '13px', maxWidth: '400px', textAlign: 'center' }}>
            {this.state.error?.message ?? i18n.t('common:errors.unexpectedError')}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 16px',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '8px',
              color: '#e0e0e0',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            {i18n.t('common:errors.retry')}
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
