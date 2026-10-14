import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useGenUiHost } from './context'

const OpenUIBlock = lazy(() => import('./OpenUIBlock'))

/** Hides a pending fence while its message streams; once the message ends it is ordinary code. */
export function PendingFence({ children }: { children: ReactNode }) {
  return useGenUiHost().live ? null : <pre>{children}</pre>
}

/**
 * A ```openui-lang block of a message: rendered as an interface, or shown as source when it cannot be. A block whose
 * closing fence arrived is complete, so it turns interactive while the rest of the message streams.
 */
export function GenUiBlock({ code, complete }: { code: string; complete: boolean }) {
  const { t } = useTranslation('ui')
  return (
    <SourceOnError code={code}>
      <Suspense fallback={<div className="my-2 text-xs text-muted-foreground">{t('genUi.loading')}</div>}>
        <OpenUIBlock code={code} complete={complete} />
      </Suspense>
    </SourceOnError>
  )
}

interface BoundaryProps {
  code: string
  children: ReactNode
}

/** Contains a failure of the runtime chunk or of a component, so the rest of the message keeps rendering. */
class SourceOnError extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Generated interface failed', error, info.componentStack)
  }

  // A streaming block grows on every chunk: the next version gets a fresh attempt.
  componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.code !== this.props.code) this.setState({ failed: false })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <pre>
        <code>{this.props.code}</code>
      </pre>
    )
  }
}
