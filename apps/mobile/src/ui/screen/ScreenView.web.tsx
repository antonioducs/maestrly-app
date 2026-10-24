import { FLEET_SCREEN } from '@maestrly/bot-fleet-protocol'
import { useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { parseScreenPageMessage, screenPageDocument, type ScreenPageCommand } from '../../screen/screen-page'
import { useTheme } from '../../theme/ThemeProvider'
import { screenPageTheme } from './screen-theme'
import type { ScreenViewProps } from './screen-view-props'

type MessageWindow = {
  addEventListener(type: 'message', listener: (event: { source: unknown; data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { source: unknown; data: unknown }) => void): void
}
type FrameWindow = { postMessage(message: unknown, target: string): void }

/**
 * The web preview's screen: a sandboxed frame with scripts only, so the page gets an opaque origin of its own, under
 * the same policy and messages as the phone's web view.
 */
export function ScreenView({ ref, label, onMessage }: ScreenViewProps) {
  const { palette } = useTheme()
  const frame = useRef<{ contentWindow: FrameWindow | null } | null>(null)
  const ready = useRef(false)
  const queue = useRef<ScreenPageCommand[]>([])
  const page = useMemo(() => screenPageDocument('parent', screenPageTheme(palette), FLEET_SCREEN), [palette])
  const handler = useRef(onMessage)
  handler.current = onMessage
  const post = (command: ScreenPageCommand) => frame.current?.contentWindow?.postMessage(JSON.stringify(command), '*')

  useImperativeHandle(
    ref,
    () => ({
      send(command) {
        if (ready.current) post(command)
        else queue.current.push(command)
      },
    }),
    []
  )
  useEffect(() => {
    ready.current = false
    const host = globalThis as unknown as MessageWindow
    const listener = (event: { source: unknown; data: unknown }) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = parseScreenPageMessage(event.data)
      if (!message) return
      if (message.t === 'ready') {
        ready.current = true
        for (const command of queue.current.splice(0)) post(command)
      }
      handler.current(message)
    }
    host.addEventListener('message', listener)
    return () => host.removeEventListener('message', listener)
  }, [page])

  return (
    <iframe
      ref={(element) => {
        frame.current = element as unknown as { contentWindow: FrameWindow | null } | null
      }}
      title={label}
      srcDoc={page}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ flex: 1, width: '100%', height: '100%', border: 0, display: 'block', background: palette.codeBg }}
    />
  )
}
