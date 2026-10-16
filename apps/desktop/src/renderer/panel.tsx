/** Second renderer for native drawer panels and floating windows. Resolve the persisted locale before
 * mounting, subscribe to local events, and retain panel state when its native view is reparented. */
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { NotesPanel } from '@/components/notes/NotesPanel'
import { ReviewPanel } from '@/components/ReviewPanel'
import { PlanPanel } from '@/components/PlanPanel'
import { BrowserChrome } from '@/components/BrowserChrome'
import { RemoteBrowserSurface } from '@/components/RemoteBrowserSurface'
import { TerminalTabs } from '@/components/TerminalTabs'
import { FilesPanel } from '@/components/files/FilesPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { i18n, initRendererI18n } from './lib/i18n'
import { HostProvider, useHostApi } from '@/lib/hosts/host-context'
import type { PlanReceived } from '../preload'
import { hostKey, LOCAL_HOST_ID } from '../shared/host-key'
import { useHostInfo } from '@/lib/hosts/use-hosts'
import { BROWSER_CHROME_HEIGHT } from '../shared/browser-omnibox'
import './styles.css'

const params = new URLSearchParams(location.search)
const panel = params.get('panel') ?? ''
const conv = params.get('conv') ?? ''
const host = params.get('host') ?? LOCAL_HOST_ID
// This computer knows the panel's conversation by its host key; the host knows it by `conv`.
const convKey = hostKey(host, conv)

function PlanPanelHost({ conv }: { conv: string }) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  // A file chip opens the file in the conversation's editor: this computer's, or a remote host's when it serves one.
  const opensFiles = useHostInfo().editor
  const [plan, setPlan] = useState<PlanReceived | null>(null)
  useEffect(() => {
    let alive = true
    void api.getPendingPlan(conv).then((p) => {
      if (alive && p) setPlan(p)
    })
    const offR = api.onPlanReceived((p) => {
      if (p.agentId === conv) setPlan(p)
    })
    const offC = api.onPlanCleared(({ agentId }) => {
      if (agentId === conv) setPlan(null)
    })
    return () => {
      alive = false
      offR()
      offC()
    }
  }, [conv, api])
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
      onDecide={(d) => api.decidePlan(conv, d)}
      // A file of a server opens in an editor nobody sees: there, a path stays a reference.
      onOpenFile={(filePath, line) => {
        if (opensFiles) void api.openPlanFile(conv, filePath, line)
      }}
    />
  )
}

function TerminalPanelHost({ conv }: { conv: string }) {
  usePanelMemoryEviction(conv, 'terminal', () => ({ safe: true }))
  const [fullSpeed, setFullSpeed] = useState(false)

  useEffect(
    () =>
      window.api.onTerminalPanelActivity((state) => {
        if (state.convId === convKey) setFullSpeed(state.fullSpeed)
      }),
    [conv]
  )

  // Keep the tab strip and its local state warm. Only TerminalTabs' ShellTerminalView is materialized
  // while this panel is on the same full-speed path used by backgroundThrottling.
  return <TerminalTabs convId={conv} active={fullSpeed} />
}

/**
 * A remote host's browser out of the drawer, in a popup or a floating window: its chrome over the page the host
 * streams. The page streams only while main says this panel is shown.
 */
function RemoteBrowserPanel({ conv }: { conv: string }) {
  const [active, setActive] = useState(false)
  useEffect(
    () =>
      window.api.onBrowserPanelActivity((state) => {
        if (state.convId === convKey) setActive(state.fullSpeed)
      }),
    []
  )
  const addressRef = useRef<HTMLInputElement>(null)
  const focusAddress = useCallback(() => {
    addressRef.current?.focus()
    addressRef.current?.select()
  }, [])
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome convId={conv} addressRef={addressRef} />
      <div className="relative min-h-0 flex-1">
        <RemoteBrowserSurface convId={conv} active={active} onFocusAddress={focusAddress} />
      </div>
    </div>
  )
}

/** A panel of a remote host's conversation is mounted again each time the host answers again. */
function HostPanel() {
  const info = useHostInfo()
  return <PanelRoot key={info.epoch} />
}

function PanelRoot() {
  const api = useHostApi()
  // A file chip opens the file in the conversation's editor: this computer's, or a remote host's when it serves one.
  const opensFiles = useHostInfo().editor
  switch (panel) {
    case 'notes':
      return <NotesPanel key={conv} scope="conv" scopeId={conv} showMerge visible />
    case 'review':
      return (
        <ReviewPanel
          convId={conv}
          visible
          onOpenFile={(path, line) => {
            if (opensFiles) void api.openPlanFile(conv, path, line)
          }}
          onOpenUrl={(url) => void window.api.openExternalUrl(url)}
        />
      )
    case 'plan':
      return <PlanPanelHost conv={conv} />
    case 'browser':
      // This computer's floating browser has native pages below this chrome; a remote host's is drawn here whole.
      return host === LOCAL_HOST_ID ? (
        <BrowserChrome convId={conv} host="floating" height={BROWSER_CHROME_HEIGHT} />
      ) : (
        <RemoteBrowserPanel conv={conv} />
      )
    case 'terminal':
      return <TerminalPanelHost conv={conv} />
    case 'files':
      return <FilesPanel conv={conv} />
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
            <HostProvider hostId={host}>
              <HostPanel />
            </HostProvider>
          </div>
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  )
})
