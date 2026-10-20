import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_SCREEN, type FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { loadScreenKeyboard } from '@/lib/fleet/load-screen-keyboard'
import { attachScreenClipboard, type ScreenClipboardError } from '@/lib/fleet/screen-clipboard'
import { FleetScreenChannel, ScreenRetries, screenCloseOutcome } from '@/lib/fleet/screen-channel'
import { ScreenVideoClient } from '@/lib/fleet/screen-video-client'
import { fleetErrorMessage, isScreenConflict, isScreenOffline } from '@/lib/fleet/errors'
import { screenTargetOf } from '@/lib/fleet/screen-target'
import { useFleetServerId } from '@/lib/fleet/server-context'

export type ScreenPhase = 'connecting' | 'live' | 'offline' | 'error'

/**
 * Streams a screen into `container`: a bot's browser or apps area, an environment's screen, or a workspaces
 * conversation's computer. A null surface is a bot's browser area opened as before environments. Browser areas and the
 * environment screen share one display, so the gateway allows one control session on it per environment: a refused
 * control request watches instead, until the owner retries or asks for another screen. `error` is the failure's raw message, for `fleetErrorText`.
 */
export function useFleetScreen({
  container,
  kind,
  id,
  conversationId,
  surface,
  mode,
  disabled,
  visible = true,
  autoFocus = true,
  onControlLost,
}: {
  container: RefObject<HTMLDivElement | null>
  kind: 'bot' | 'environment' | 'conversation'
  id: string
  /** For a conversation: its id on the host of environment `id`. */
  conversationId?: string
  surface: FleetScreenSurface | null
  mode: 'view' | 'control'
  disabled: boolean
  /** A hidden pane keeps its connection, but accepts no input. */
  visible?: boolean
  /** Bot workspaces leave focus with the adjacent composer, including on reconnect. */
  autoFocus?: boolean
  onControlLost?: () => void
}) {
  const serverId = useFleetServerId()
  const [phase, setPhase] = useState<ScreenPhase>('connecting')
  const [error, setError] = useState('')
  const [clipboardError, setClipboardError] = useState<ScreenClipboardError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retries = useRef(new ScreenRetries())
  const lost = useRef(onControlLost)
  lost.current = onControlLost
  const presentation = useRef({ visible, autoFocus })
  presentation.current = { visible, autoFocus }
  const remoteRef = useRef<ScreenVideoClient | null>(null)
  const request = `${kind}:${id}:${conversationId ?? ''}:${surface ?? ''}`
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
    let client: ScreenVideoClient | null = null
    let detachClipboard: (() => void) | undefined
    setPhase('connecting')
    setError('')
    setClipboardError(null)
    const target = screenTargetOf({ kind, id, surface, conversationId })
    const openScreen = async () => {
      // Load the keyboard before opening the channel so a failed load never leaves a channel open.
      const { default: Keyboard } = await loadScreenKeyboard()
      if (disposed) return null
      const opened = await FleetScreenChannel.open(window.api, serverId, target, effective, (state) => {
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
      return { opened, Keyboard }
    }
    void openScreen()
      .then((result) => {
        if (!result) return
        const { opened, Keyboard } = result
        if (disposed || !container.current) {
          opened.close()
          return
        }
        channel = opened
        if (Number(opened.readyState) === WebSocket.OPEN) setPhase('live')
        const remote = new ScreenVideoClient(container.current, opened, { Keyboard })
        remote.viewOnly = effective === 'view' || !presentation.current.visible
        remoteRef.current = remote
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
        client = remote
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
      if (remoteRef.current === client) remoteRef.current = null
      client?.disconnect()
      channel?.close()
    }
  }, [container, kind, id, conversationId, surface, request, effective, disabled, attempt])
  /** Asks for control again once the other session is done. */
  const retryControl = useCallback(() => {
    retries.current.reset()
    setBlocked(null)
  }, [])
  /** A new takeover starts with a fresh retry allowance. */
  const resetRetries = useCallback(() => {
    retries.current.reset()
  }, [])
  /** Connects again after a failure, with a fresh retry allowance. */
  const reconnect = useCallback(() => {
    retries.current.reset()
    setAttempt((value) => value + 1)
  }, [])
  return { phase, error, clipboardError, conflict, retryControl, resetRetries, reconnect }
}

/** The remote desktop is always this size, so a frame around it keeps this shape. */
const DESKTOP_ASPECT = FLEET_SCREEN.width / FLEET_SCREEN.height

/**
 * The frame a screen streams into; clicking a watched screen explains how to control it. A `pane` fills its parent, as
 * an environment's screen does. A `window` is a rounded desktop of the remote screen's own shape, as large as fits its
 * container (a size container) once `reserve` pixels below it are left free; it turns green while its owner controls it.
 */
export function ScreenFrame({
  container,
  label,
  interactive,
  clipboardError,
  variant = 'pane',
  controlling = false,
  reserve = 0,
  children,
}: {
  container: RefObject<HTMLDivElement | null>
  label: string
  interactive: boolean
  clipboardError?: ScreenClipboardError | null
  variant?: 'pane' | 'window'
  controlling?: boolean
  reserve?: number
  children?: ReactNode
}) {
  const { t } = useTranslation('fleet')
  const [hint, setHint] = useState(false)
  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(false), 2200)
    return () => window.clearTimeout(timer)
  }, [hint])
  // Under control the screen's canvas takes the bot's own pointer sprite as its cursor. A watched screen keeps the
  // local pointer, and shows the bot's where the screen reports it.
  const cursor = interactive ? 'cursor-default' : 'cursor-not-allowed [&_canvas]:!cursor-not-allowed'
  const framed = variant === 'window'
  const region = (
    <div
      ref={container}
      role="region"
      aria-label={label}
      onClick={() => {
        if (!interactive) setHint(true)
      }}
      className={`${framed ? 'absolute inset-0' : 'relative h-full w-full'} ${cursor}`}
    />
  )
  const notices = (
    <>
      {hint && !interactive && (
        <p
          role="status"
          className={`pointer-events-none absolute rounded-full bg-popover px-3 py-2 text-xs shadow ${framed ? 'bottom-4' : 'bottom-8'}`}
        >
          {t('screen.viewHint')}
        </p>
      )}
      {children}
      {clipboardError && (
        <p
          role="alert"
          className={`absolute max-w-lg rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow ${framed ? 'bottom-4' : 'bottom-8'}`}
        >
          {t(`screen.clipboard.${clipboardError}`)}
        </p>
      )}
    </>
  )
  if (!framed)
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/85 p-4">
        {region}
        {notices}
      </div>
    )
  return (
    <div
      data-screen-frame
      data-control={controlling ? 'human' : 'bot'}
      className={`relative shrink-0 overflow-hidden rounded-[14px] border bg-black shadow-[0_30px_80px_rgba(0,0,0,0.55)] transition-[border-color,box-shadow] duration-300 motion-reduce:transition-none ${controlling ? 'border-status-ready shadow-[0_30px_80px_rgba(0,0,0,0.55),0_0_0_1px_rgba(91,214,160,0.45)]' : 'border-white/10'}`}
      style={{
        aspectRatio: String(DESKTOP_ASPECT),
        width: `max(0px, min(100cqw, (100cqh - ${reserve}px) * ${DESKTOP_ASPECT}))`,
      }}
    >
      {region}
      {notices}
    </div>
  )
}
