import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GENUI_WIDGET_FRAME_URL,
  GENUI_WIDGET_MAX_CHARS,
  type GenUiWidgetTheme,
  genUiWidgetHash,
  parseGenUiWidgetMessage,
} from '../../shared/genui-widget'
import { useGenUiHost } from './context'
import { GenUiIssues } from './GenUiIssues'
import { GenUiSource } from './GenUiSource'
import { addGenUiIssue, type GenUiIssue } from './issues'

/** Least time between two messages or links one frame may send, even with the person clicking. */
const ACTION_INTERVAL_MS = 1000
const INITIAL_HEIGHT = 160

/** The app's colors and type, for the frame's `var(--ui-*)`. */
function appTheme(view: Window): GenUiWidgetTheme {
  const root = view.getComputedStyle(view.document.documentElement)
  const read = (name: string) => root.getPropertyValue(name).trim() || undefined
  return {
    text: read('--foreground'),
    muted: read('--muted-foreground'),
    border: read('--border'),
    accent: read('--primary'),
    'accent-text': read('--primary-foreground'),
    danger: read('--destructive'),
    radius: read('--radius'),
    font: view.getComputedStyle(view.document.body).fontFamily || undefined,
  }
}

/**
 * Whether the person just interacted with this window or a frame inside it: a click in a frame activates every
 * window above it too. A frame cannot fake it, so a block sends or opens nothing on its own.
 */
export function hasTransientActivation(view: Window): boolean {
  const activation = (view.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return activation?.isActive === true
}

/** Hides a pending fence while its message streams; once the message ends it is ordinary code. */
export function PendingFence({ children }: { children: ReactNode }) {
  return useGenUiHost().live ? null : <pre>{children}</pre>
}

/**
 * A ```inline-html block of a message: the model's HTML in an isolated frame (see shared/genui-widget-frame.ts). It
 * renders once the block is complete, so its scripts never run half-written. An empty block is a reference to a
 * preview that the message does not hold (see expandGenUiPreviews).
 */
export function HtmlWidgetBlock({ code, complete }: { code: string; complete: boolean }) {
  const { t } = useTranslation('ui')
  const { live, send } = useGenUiHost()
  const ready = complete || !live
  const tooLong = code.length > GENUI_WIDGET_MAX_CHARS
  return (
    <div className="genui-widget my-2 flex min-w-0 flex-col gap-1.5 not-italic">
      {!ready ? (
        <p className="m-0 animate-pulse text-[12px] text-muted-foreground">{t('genUi.building')}</p>
      ) : !code.trim() ? (
        <p className="m-0 text-[12px] text-muted-foreground">{t('genUi.missing')}</p>
      ) : tooLong ? (
        <p className="m-0 text-[12px] text-muted-foreground">{t('genUi.tooLong')}</p>
      ) : (
        <WidgetFrame key={genUiWidgetHash(code)} code={code} send={send} />
      )}
      {code.trim() && <GenUiSource code={code} open={ready && tooLong} />}
    </div>
  )
}

function WidgetFrame({ code, send }: { code: string; send?: (text: string) => void }) {
  const { t } = useTranslation('ui')
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [issues, setIssues] = useState<readonly GenUiIssue[]>([])
  const sendRef = useRef(send)
  sendRef.current = send

  // Listens before the frame can load: its page announces itself once and then waits for the block.
  useLayoutEffect(() => {
    const frame = ref.current
    // A chat in a separate window lives in that window's document, and so do the frame's messages.
    const view = frame?.ownerDocument.defaultView
    if (!frame || !view) return
    let lastAction = 0
    const actionAllowed = () => {
      const now = Date.now()
      if (!hasTransientActivation(view) || now - lastAction < ACTION_INTERVAL_MS) return false
      lastAction = now
      return true
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.contentWindow) return
      const message = parseGenUiWidgetMessage(event.data)
      if (!message) return
      if (message.type === 'ready') {
        frame.contentWindow?.postMessage(
          { source: 'maestrly-host', type: 'render', html: code, theme: appTheme(view) },
          // The frame's origin is opaque; what it receives is the block it shows anyway.
          '*'
        )
      } else if (message.type === 'size') setHeight(Math.max(24, message.height))
      else if (message.type === 'send') {
        const deliver = sendRef.current
        if (deliver && actionAllowed()) deliver(message.text)
      } else if (message.type === 'open') {
        if (actionAllowed()) void window.api.openExternalUrl(message.url)
      } else if (message.type === 'issue')
        setIssues((current) => addGenUiIssue(current, { kind: message.kind, detail: message.detail }))
    }
    view.addEventListener('message', onMessage)
    return () => view.removeEventListener('message', onMessage)
  }, [code])

  return (
    <>
      <iframe
        ref={ref}
        src={GENUI_WIDGET_FRAME_URL}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        title={t('genUi.frameTitle')}
        className="block w-full border-0 bg-transparent"
        // The frame's page is dark too: with a different scheme Chromium paints an opaque backdrop behind it.
        style={{ height, colorScheme: 'dark' }}
      />
      <GenUiIssues issues={issues} />
    </>
  )
}
