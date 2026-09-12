/** Second renderer for native drawer panels and floating windows. Resolve the persisted locale before
 * mounting, subscribe to local events, and retain panel state when its native view is reparented. */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { NotesPanel } from '@/components/notes/NotesPanel'
import { ReviewPanel } from '@/components/ReviewPanel'
import { PlanPanel } from '@/components/PlanPanel'
import { BrowserChrome } from '@/components/BrowserChrome'
import { TerminalTabs } from '@/components/TerminalTabs'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { i18n, initRendererI18n } from './lib/i18n'
import type { PlanReceived } from '../preload'
import './styles.css'

const params = new URLSearchParams(location.search)
const panel = params.get('panel') ?? ''
const conv = params.get('conv') ?? ''

function PlanPanelHost({ conv }: { conv: string }) {
  const { t } = useTranslation('ui')
  const [plan, setPlan] = useState<PlanReceived | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.getPendingPlan(conv).then((p) => {
      if (alive && p) setPlan(p)
    })
    const offR = window.api.onPlanReceived((p) => {
      if (p.agentId === conv) setPlan(p)
    })
    const offC = window.api.onPlanCleared(({ agentId }) => {
      if (agentId === conv) setPlan(null)
    })
    return () => {
      alive = false
      offR()
      offC()
    }
  }, [conv])
  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('panel.noPlanWaiting')}
      </div>
    )
  }
  return (
    <PlanPanel
      plan={plan}
      onDecide={(d) => window.api.decidePlan(conv, d)}
      onOpenFile={(filePath, line) => void window.api.openPlanFile(conv, filePath, line)}
    />
  )
}

function TerminalPanelHost({ conv }: { conv: string }) {
  usePanelMemoryEviction(conv, 'terminal', () => ({ safe: true }))
  const [fullSpeed, setFullSpeed] = useState(false)

  useEffect(
    () =>
      window.api.onTerminalPanelActivity((state) => {
        if (state.convId === conv) setFullSpeed(state.fullSpeed)
      }),
    [conv]
  )

  // Keep the tab strip and its local state warm. Only TerminalTabs' ShellTerminalView is materialized
  // while this panel is on the same full-speed path used by backgroundThrottling.
  return <TerminalTabs convId={conv} active={fullSpeed} />
}

function PanelRoot() {
  switch (panel) {
    case 'notes':
      return <NotesPanel key={conv} scope="conv" scopeId={conv} showMerge visible />
    case 'review':
      return (
        <ReviewPanel
          convId={conv}
          visible
          onOpenFile={(path, line) => void window.api.openPlanFile(conv, path, line)}
          onOpenUrl={(url) => void window.api.openExternalUrl(url)}
        />
      )
    case 'plan':
      return <PlanPanelHost conv={conv} />
    case 'browser':
      return <BrowserChrome convId={conv} />
    case 'terminal':
      return <TerminalPanelHost conv={conv} />
    default:
      return null
  }
}

void initRendererI18n().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <div className="h-screen w-screen bg-surface text-foreground">
            <PanelRoot />
          </div>
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  )
})
