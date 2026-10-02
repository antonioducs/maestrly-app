import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type RFB from '@novnc/novnc'
import type { FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import type { FleetScreenTargetInput } from '../../../preload/api-fleet'
import { loadNoVnc } from '@/lib/fleet/load-novnc'
import { attachScreenClipboard, type ScreenClipboardError } from '@/lib/fleet/screen-clipboard'
import { FleetScreenChannel, ScreenRetries, screenCloseOutcome } from '@/lib/fleet/screen-channel'
import { fleetErrorMessage, isScreenConflict, isScreenOffline } from '@/lib/fleet/errors'

export type ScreenPhase = 'connecting' | 'live' | 'offline' | 'error'

/**
 * Streams a screen into `container`: a bot's browser or apps area, or an environment's screen. A null surface is a
 * bot's browser area opened as before environments. Browser areas and the environment screen share one display, so
 * the gateway allows one control session on it per environment: a refused control request watches instead, until
 * the owner retries or asks for another screen. `error` is the failure's raw message, for `fleetErrorText`.
 */
export function useFleetScreen({
  container,
  kind,
  id,
  surface,
  mode,
  disabled,
  visible = true,
  autoFocus = true,
  onControlLost,
}: {
  container: RefObject<HTMLDivElement | null>
  kind: 'bot' | 'environment'
  id: string
  surface: FleetScreenSurface | null
  mode: 'view' | 'control'
  disabled: boolean
  /** A hidden pane keeps its connection, but accepts no input. */
  visible?: boolean
  /** Bot workspaces leave focus with the adjacent composer, including on reconnect. */
  autoFocus?: boolean
  onControlLost?: () => void
}) {
  const [phase, setPhase] = useState<ScreenPhase>('connecting')
  const [error, setError] = useState('')
  const [clipboardError, setClipboardError] = useState<ScreenClipboardError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retries = useRef(new ScreenRetries())
  const lost = useRef(onControlLost)
  lost.current = onControlLost
  const presentation = useRef({ visible, autoFocus })
  presentation.current = { visible, autoFocus }
  const remoteRef = useRef<RFB | null>(null)
  const request = `${kind}:${id}:${surface ?? ''}`
  const [blocked, setBlocked] = useState<string | null>(null)
  const conflict = mode === 'control' && blocked === request
  const effective = conflict ? 'view' : mode
  useEffect(() => {
    if (remoteRef.current) remoteRef.current.viewOnly = effective === 'view' || !visible
    const focused = container.current?.ownerDocument.activeElement
    if (!visible && focused instanceof HTMLElement && container.current?.contains(focused)) focused.blur()
  }, [container, visible, effective])
  useEffect(() => {
    if (disabled) {
      // Closing and explicitly reopening the computer starts a new viewing attempt.
      retries.current.reset()
      return
    }
    if (!container.current) return
    let disposed = false
    let channel: FleetScreenChannel | null = null
    let rfb: RFB | null = null
    let detachClipboard: (() => void) | undefined
    setPhase('connecting')
    setError('')
    setClipboardError(null)
    const target: FleetScreenTargetInput =
      kind === 'environment' ? { environmentId: id } : surface ? { botId: id, surface } : id
    const openScreen = async () => {
      // Load the viewer before opening the channel so a failed load never leaves a channel open.
      const { default: NoVncClient } = await loadNoVnc()
      if (disposed) return null
      const opened = await FleetScreenChannel.open(window.api, target, effective, (state) => {
        if (disposed) return
        if (state.state === 'open') setPhase('live')
        if (state.state === 'error') setPhase('error')
        if (state.state !== 'closed') return
        const outcome = screenCloseOutcome(state, effective)
        if (outcome === 'released') {
          lost.current?.()
          setPhase('connecting')
        } else if (outcome === 'offline') setPhase('offline')
        // Another session took the shared display between the ticket and its use: watch it instead.
        else if (outcome === 'conflict') setBlocked(request)
        else if (outcome === 'retry' && retries.current.take(`${request}:${effective}`))
          setAttempt((value) => value + 1)
        else setPhase('error')
      })
      return { opened, NoVncClient }
    }
    void openScreen()
      .then((result) => {
        if (!result) return
        const { opened, NoVncClient } = result
        if (disposed || !container.current) {
          opened.close()
          return
        }
        channel = opened
        if (Number(opened.readyState) === WebSocket.OPEN) setPhase('live')
        const remote = new NoVncClient(container.current, opened, { shared: true })
        remote.viewOnly = effective === 'view' || !presentation.current.visible
        remoteRef.current = remote
        remote.scaleViewport = true
        remote.resizeSession = false
        remote.qualityLevel = 6
        remote.compressionLevel = 4
        if (effective === 'control') {
          detachClipboard = attachScreenClipboard(
            container.current,
            remote,
            (text) => window.api.fleetScreenClipboardWrite(opened.channelId, text),
            /Mac|iPhone|iPad/.test(navigator.platform),
            setClipboardError,
            () => window.api.fleetScreenClipboardRead(opened.channelId)
          )
        }
        remote.addEventListener('connect', () => {
          // The screen really answered: a later refusal of this screen may retry again.
          retries.current.reset()
          setPhase('live')
          if (effective === 'control' && presentation.current.visible && presentation.current.autoFocus)
            remote.focus({ preventScroll: true })
        })
        remote.addEventListener('disconnect', () => {
          if (!disposed) setPhase((value) => (value === 'offline' ? value : 'error'))
        })
        rfb = remote
      })
      .catch((cause) => {
        if (disposed) return
        if (effective === 'control' && isScreenConflict(cause)) {
          setBlocked(request)
          return
        }
        // The bot or environment stopped before its status said so.
        if (isScreenOffline(cause)) {
          setPhase('offline')
          return
        }
        setError(fleetErrorMessage(cause))
        setPhase('error')
      })
    return () => {
      disposed = true
      detachClipboard?.()
      if (remoteRef.current === rfb) remoteRef.current = null
      rfb?.disconnect()
      channel?.close()
    }
  }, [container, kind, id, surface, request, effective, disabled, attempt])
  /** Asks for control again once the other session is done. */
  const retryControl = useCallback(() => {
    retries.current.reset()
    setBlocked(null)
  }, [])
  /** A new takeover starts with a fresh retry allowance. */
  const resetRetries = useCallback(() => {
    retries.current.reset()
  }, [])
  return { phase, error, clipboardError, conflict, retryControl, resetRetries }
}

/** The dark frame a screen streams into; clicking a watched screen explains how to control it. */
export function ScreenFrame({
  container,
  label,
  interactive,
  clipboardError,
  children,
}: {
  container: RefObject<HTMLDivElement | null>
  label: string
  interactive: boolean
  clipboardError?: ScreenClipboardError | null
  children?: ReactNode
}) {
  const { t } = useTranslation('fleet')
  const [hint, setHint] = useState(false)
  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(false), 2200)
    return () => window.clearTimeout(timer)
  }, [hint])
  // noVNC puts an inline `cursor: none` on its canvas, since the screen server draws the bot's pointer into the frames.
  // Under control that is the only pointer; a watched screen overrides it to keep the local one.
  const cursor = interactive ? 'cursor-default' : 'cursor-not-allowed [&_canvas]:!cursor-not-allowed'
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/85 p-4">
      <div
        ref={container}
        role="region"
        aria-label={label}
        onClick={() => {
          if (!interactive) setHint(true)
        }}
        className={`relative h-full w-full [&_canvas]:mx-auto ${cursor}`}
      />
      {hint && !interactive && (
        <p
          role="status"
          className="pointer-events-none absolute bottom-8 rounded-full bg-popover px-3 py-2 text-xs shadow"
        >
          {t('screen.viewHint')}
        </p>
      )}
      {children}
      {clipboardError && (
        <p
          role="alert"
          className="absolute bottom-8 max-w-lg rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow"
        >
          {t(`screen.clipboard.${clipboardError}`)}
        </p>
      )}
    </div>
  )
}
