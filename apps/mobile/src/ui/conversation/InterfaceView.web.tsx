import { GENUI_WIDGET_MAX_HEIGHT, parseGenUiWidgetMessage } from '@maestrly/bot-fleet-protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../../theme/ThemeProvider'
import { interfaceDocument, interfaceTheme } from './interface-document'
import type { InterfaceViewProps } from './interface-view-props'

type MessageWindow = {
  addEventListener(type: 'message', listener: (event: { source: unknown; data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { source: unknown; data: unknown }) => void): void
}

/**
 * The web preview's interactive answer: a sandboxed frame with scripts only, so the block gets an opaque origin of
 * its own, under the same policy and bridge as the phone's web view.
 */
export function InterfaceView({ html, label, onSend, onOpen, onIssue }: InterfaceViewProps) {
  const { palette, scheme } = useTheme()
  const frame = useRef<{ contentWindow: unknown } | null>(null)
  const [height, setHeight] = useState(120)
  const page = useMemo(
    () => interfaceDocument(html, interfaceTheme(palette), 'parent', scheme),
    [html, palette, scheme]
  )
  const handlers = useRef({ onSend, onOpen, onIssue })
  handlers.current = { onSend, onOpen, onIssue }

  useEffect(() => {
    const host = globalThis as unknown as MessageWindow
    const listener = (event: { source: unknown; data: unknown }) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = parseGenUiWidgetMessage(event.data)
      if (!message) return
      if (message.type === 'size') setHeight(Math.max(1, Math.min(message.height, GENUI_WIDGET_MAX_HEIGHT)))
      else if (message.type === 'send') handlers.current.onSend(message.text)
      else if (message.type === 'open') handlers.current.onOpen(message.url)
      else if (message.type === 'issue') handlers.current.onIssue(message.kind, message.detail)
    }
    host.addEventListener('message', listener)
    return () => host.removeEventListener('message', listener)
  }, [])

  return (
    <iframe
      ref={(element) => {
        frame.current = element as unknown as { contentWindow: unknown } | null
      }}
      title={label}
      srcDoc={page}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // A frame whose color scheme differs from its page's is painted opaque; matching keeps it see-through.
      style={{ width: '100%', height, border: 0, display: 'block', background: 'transparent', colorScheme: scheme }}
    />
  )
}
