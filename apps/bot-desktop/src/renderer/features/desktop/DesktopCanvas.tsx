import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import RFB from '@novnc/novnc'
import type { DesktopInput } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { buttonName, InputQueue, textEvents, toFramebuffer, WheelSteps } from './input-mapping'
import { keysymOf, MODIFIER_CODES } from './keysyms'
import type { DesktopSocket } from './useDesktopSession'

/**
 * Live view of the bot's desktop. noVNC only decodes and paints (viewOnly): it never
 * sends input on the RFB stream, which the server refuses anyway. When this client
 * holds control, pointer, wheel, keys and IME text are mapped here and sent through the
 * main process to the Host.
 */
export function DesktopCanvas({
  socket,
  controlling,
  framebuffer,
  stale,
  onInput,
  onConnected,
  onDisconnected,
  onReleaseKeyboard,
}: {
  socket?: DesktopSocket
  controlling: boolean
  framebuffer: { width: number; height: number }
  stale: boolean
  onInput: (events: DesktopInput[]) => void
  onConnected: () => void
  onDisconnected: () => void
  onReleaseKeyboard: () => void
}) {
  const t = useT()
  const screen = useRef<HTMLDivElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const [connected, setConnected] = useState(false)
  const [remoteCursor, setRemoteCursor] = useState(false)
  const send = useRef(onInput)
  send.current = onInput
  const queue = useRef(new InputQueue((events) => send.current(events)))
  const wheel = useRef(new WheelSteps())
  const keys = useRef(new Map<string, number>())
  const buttons = useRef(new Set<'left' | 'middle' | 'right'>())
  const composing = useRef(false)
  const size = useRef(framebuffer)
  size.current = framebuffer
  const callbacks = useRef({ onConnected, onDisconnected })
  callbacks.current = { onConnected, onDisconnected }
  useEffect(() => {
    const target = screen.current
    if (!target || !socket) return
    // A new socket means a new authorization: the previous frame is cleared at once.
    target.replaceChildren()
    setConnected(false)
    const channel = new WebSocket(socket.url, socket.protocols)
    const rfb = new RFB(target, channel, { shared: true })
    rfb.viewOnly = true
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.clipViewport = false
    rfb.focusOnClick = false
    rfb.showDotCursor = false
    rfb.qualityLevel = 6
    rfb.compressionLevel = 2
    rfb.background = 'transparent'
    const connect = () => {
      setConnected(true)
      callbacks.current.onConnected()
    }
    const disconnect = () => {
      setConnected(false)
      callbacks.current.onDisconnected()
    }
    rfb.addEventListener('connect', connect)
    rfb.addEventListener('disconnect', disconnect)
    // The scraping server sends an empty cursor shape over Xvfb, and noVNC then hides the
    // pointer over the screen. Whenever the remote shape is empty the local arrow is shown, so
    // the person always sees where they click; a real remote shape still wins.
    const drawn = target.querySelector('canvas')
    const updateCursor = () => setRemoteCursor(!!drawn && drawn.style.cursor !== '' && drawn.style.cursor !== 'none')
    const observer = drawn ? new MutationObserver(updateCursor) : undefined
    if (drawn) observer!.observe(drawn, { attributes: true, attributeFilter: ['style'] })
    updateCursor()
    return () => {
      observer?.disconnect()
      rfb.removeEventListener('connect', connect)
      rfb.removeEventListener('disconnect', disconnect)
      try {
        rfb.disconnect()
      } catch {
        /* already closed */
      }
      target.replaceChildren()
    }
  }, [socket?.handle, socket?.url])
  const releaseAll = () => {
    if (!keys.current.size && !buttons.current.size) return
    keys.current.clear()
    buttons.current.clear()
    queue.current.push({ kind: 'releaseAll' })
  }
  useEffect(() => {
    if (!controlling) {
      queue.current.clear()
      keys.current.clear()
      buttons.current.clear()
      return
    }
    keyboard.current?.focus({ preventScroll: true })
    const blur = () => releaseAll()
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [controlling])
  const box = () => screen.current?.querySelector('canvas')?.getBoundingClientRect()
  const point = (event: { clientX: number; clientY: number }, clampInside = false) => {
    const rect = box()
    return rect ? toFramebuffer(event.clientX, event.clientY, rect, size.current, clampInside) : undefined
  }
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!controlling) return
    event.preventDefault()
    event.stopPropagation()
    keyboard.current?.focus({ preventScroll: true })
    const button = buttonName(event.button)
    const position = point(event)
    if (!button || !position) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    buttons.current.add(button)
    queue.current.push({ kind: 'button', button, down: true, ...position })
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!controlling) return
    const position = point(event, buttons.current.size > 0)
    if (position) queue.current.move(position.x, position.y)
  }
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!controlling) return
    const button = buttonName(event.button)
    if (!button || !buttons.current.has(button)) return
    event.preventDefault()
    buttons.current.delete(button)
    const position = point(event, true)
    if (position) queue.current.push({ kind: 'button', button, down: false, ...position })
  }
  useEffect(() => {
    const element = screen.current?.parentElement
    if (!element) return
    // Non-passive so the chat does not scroll while the pointer is over the guest.
    const onWheel = (event: WheelEvent) => {
      if (!controlling) return
      event.preventDefault()
      const position = point(event)
      const steps = wheel.current.step(event.deltaX, event.deltaY, event.deltaMode)
      if (position && (steps.deltaX || steps.deltaY)) queue.current.push({ kind: 'wheel', ...position, ...steps })
    }
    element.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => element.removeEventListener('wheel', onWheel, { capture: true })
  }, [controlling])
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!controlling) return
    if (event.key === 'Escape' && event.shiftKey) {
      event.preventDefault()
      releaseAll()
      keyboard.current?.blur()
      onReleaseKeyboard()
      return
    }
    // IME composition owns these keys; the committed text arrives on compositionend.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    const keysym = keysymOf(event)
    if (!keysym) return
    const code = /^[A-Za-z0-9]{1,40}$/.test(event.code) ? event.code : 'Unidentified'
    keys.current.set(code, keysym)
    queue.current.push({ kind: 'key', code, keysym, down: true })
  }
  const keyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!controlling || event.nativeEvent.isComposing) return
    event.preventDefault()
    const code = /^[A-Za-z0-9]{1,40}$/.test(event.code) ? event.code : 'Unidentified'
    const keysym = keys.current.get(code)
    if (keysym === undefined) return
    keys.current.delete(code)
    queue.current.push({ kind: 'key', code, keysym, down: false })
    // macOS never reports key-ups for keys released while Command was down.
    if (code.startsWith('Meta') || code.startsWith('OS'))
      for (const [other, value] of [...keys.current]) {
        if (MODIFIER_CODES.has(other)) continue
        keys.current.delete(other)
        queue.current.push({ kind: 'key', code: other, keysym: value, down: false })
      }
  }
  return (
    <div
      className={`desktop-canvas${controlling ? ' controlling' : ''}${stale ? ' stale' : ''}${remoteCursor ? '' : ' local-cursor'}`}
      data-desktop-capture
      onPointerDownCapture={pointerDown}
      onPointerMoveCapture={pointerMove}
      onPointerUpCapture={pointerUp}
      onContextMenu={(event) => controlling && event.preventDefault()}
    >
      <div ref={screen} className="desktop-screen" role="img" aria-label={t('desktopTitle')} />
      {controlling && (
        <textarea
          ref={keyboard}
          className="desktop-keyboard"
          aria-label={t('desktopKeyboard')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onBlur={releaseAll}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(event) => {
            composing.current = false
            const events = textEvents(event.data)
            if (events.length) queue.current.push(...events)
            event.currentTarget.value = ''
          }}
          onInput={(event) => {
            if (!composing.current) event.currentTarget.value = ''
          }}
        />
      )}
      {(!connected || stale) && (
        <div className="desktop-overlay" aria-hidden="true">
          {stale ? t('staleFrame') : t('desktopConnecting')}
        </div>
      )}
    </div>
  )
}
