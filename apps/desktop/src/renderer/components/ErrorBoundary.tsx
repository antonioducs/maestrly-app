/** Keep render failures visible with a reload action and local console diagnostics. */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { i18n } from '@/lib/i18n'

interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-surface p-6 text-center text-foreground">
        <div className="text-sm font-medium">
          {i18n.t('ui:errors.unexpectedTitle', { defaultValue: 'Something went wrong' })}
        </div>
        <p className="max-w-sm text-[12px] text-muted-foreground">
          {i18n.t('ui:errors.unexpectedDescription', {
            defaultValue: 'This part of the interface encountered an unexpected error. Reload to continue.',
          })}
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:opacity-90"
        >
          {i18n.t('ui:errors.reload', { defaultValue: 'Reload' })}
        </button>
      </div>
    )
  }
}
