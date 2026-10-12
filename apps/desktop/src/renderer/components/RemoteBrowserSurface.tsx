import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2, X } from 'lucide-react'
import {
  BROWSER_STREAM_LIMITS,
  BROWSER_MODIFIERS,
  type BrowserSelectRequest,
  type BrowserStreamCursorName,
  type BrowserStreamFrame,
  type BrowserStreamInput,
  type BrowserStreamSource,
} from '../../shared/browser-stream'
import { useHostApi } from '@/lib/hosts/host-context'
import { useHostInfo } from '@/lib/hosts/use-hosts'
import { keyUpInput, routeKeyDown, type KeyInput, type KeyOs } from '@/lib/remote-browser-keys'
import { fitFrame, toFramePoint, toSurfaceRect, wheelPixels, type FrameFit } from '@/lib/remote-browser-view'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from '@/components/ui/select'

/**
 * The browser of a conversation that runs on a remote host, drawn from the frames the host streams (see
 * shared/browser-stream). Unlike this computer's browser it is DOM, not a native view: the drawer's menus, the tool
 * palette and dialogs simply cover it. Pointer input maps from the canvas to the page; keys and text go through a
 * hidden text field, which composes accents, IME input and emoji before they are sent.
 */

type Phase = 'connecting' | 'live' | 'taken-over' | 'offline' | 'error'

interface Props {
  /** The conversation's id on its host. */
  convId: string
  /** False while the Browser tab is not shown: the stream stops. */
  active: boolean
  /** Focuses the address bar above the surface (Command/Control+L). */
  onFocusAddress: () => void
}

interface DrawnFrame {
  bitmap: ImageBitmap
  width: number
  height: number
  kind: 'tab' | 'popup'
}

const BACKGROUND = '#0A0A0B'
const POPUP_BANNER_H = 36
const RESIZE_DEBOUNCE_MS = 150
const NOTICE_MS = 6_000

function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const osOf = (): KeyOs => {
  const os = window.api?.platformInfo?.os
  return os === 'mac' || os === 'win' ? os : 'linux'
}

/** Mouse modifiers as the host sees them: the Mac's Command is Linux's Control (Command+click opens a new tab). */
function mouseModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, os: KeyOs) {
  let bits = 0
  if (event.altKey) bits |= BROWSER_MODIFIERS.alt
  if (os === 'mac' ? event.metaKey || event.ctrlKey : event.ctrlKey) bits |= BROWSER_MODIFIERS.control
  if (event.shiftKey) bits |= BROWSER_MODIFIERS.shift
  return bits
}

const BUTTONS = ['left', 'middle', 'right'] as const
const heldButton = (buttons: number) => (buttons & 1 ? 'left' : buttons & 4 ? 'middle' : buttons & 2 ? 'right' : 'none')

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function RemoteBrowserSurface({ convId, active, onFocusAddress }: Props) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const host = useHostInfo()
  const online = host.state === 'online'
  const os = osOf()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamRef = useRef<{ streamId: string | null; source: number; kind: BrowserStreamSource['kind'] } | null>(null)
  const drawnRef = useRef<DrawnFrame | null>(null)
  const fitRef = useRef<FrameFit | null>(null)
  const keysDownRef = useRef(new Map<string, KeyInput>())
  const selectAnswered = useRef(false)

  const [phase, setPhase] = useState<Phase>(online ? 'connecting' : 'offline')
  const [hasFrame, setHasFrame] = useState(false)
  const [source, setSource] = useState<Pick<BrowserStreamSource, 'kind' | 'popup'>>({ kind: 'tab', popup: null })
  const [cursor, setCursor] = useState<BrowserStreamCursorName>('default')
  const [select, setSelect] = useState<BrowserSelectRequest | null>(null)
  const [notice, setNotice] = useState<'file-chooser' | null>(null)
  const [retry, setRetry] = useState(0)
  const [surfaceReady, setSurfaceReady] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const surfaceSize = useCallback(() => {
    const el = containerRef.current
    return el ? { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) } : { width: 0, height: 0 }
  }, [])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const box = { width: container.clientWidth, height: container.clientHeight }
    const pixelWidth = Math.max(1, Math.round(box.width * dpr))
    const pixelHeight = Math.max(1, Math.round(box.height * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = BACKGROUND
    context.fillRect(0, 0, canvas.width, canvas.height)
    const drawn = drawnRef.current
    if (!drawn) {
      fitRef.current = null
      return
    }
    // A sign-in window is drawn below its banner, which covers the top of the surface.
    const top = drawn.kind === 'popup' ? Math.min(POPUP_BANNER_H, box.height) : 0
    const fit = fitFrame({ width: box.width, height: box.height - top }, drawn, drawn.kind)
    fit.y += top
    fitRef.current = fit
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(drawn.bitmap, fit.x * dpr, fit.y * dpr, fit.width * dpr, fit.height * dpr)
  }, [])

  const clearFrame = useCallback(() => {
    drawnRef.current?.bitmap.close()
    drawnRef.current = null
    setHasFrame(false)
    paint()
  }, [paint])

  const send = useCallback(
    (input: BrowserStreamInput) => {
      const id = streamRef.current?.streamId
      if (id) api.browserStreamInput(convId, id, input)
    },
    [api, convId]
  )

  // The stream: started while the tab shows, the host is reachable and the window is visible; stopped otherwise.
  useEffect(() => {
    if (!active || !online || !visible || !surfaceReady) {
      setPhase(online ? 'connecting' : 'offline')
      return
    }
    let disposed = false
    const stream = { streamId: null as string | null, source: 0, kind: 'tab' as BrowserStreamSource['kind'] }
    streamRef.current = stream
    const decoder: { busy: boolean; pending: { frame: BrowserStreamFrame; ack: () => void } | null } = {
      busy: false,
      pending: null,
    }
    setPhase('connecting')
    setSource({ kind: 'tab', popup: null })
    setSelect(null)
    setNotice(null)

    const decode = async () => {
      decoder.busy = true
      while (decoder.pending && !disposed) {
        const { frame, ack } = decoder.pending
        decoder.pending = null
        try {
          const bitmap = await createImageBitmap(new Blob([base64Bytes(frame.data)], { type: 'image/jpeg' }))
          if (!disposed && frame.source === stream.source && stream.kind !== 'none') {
            drawnRef.current?.bitmap.close()
            drawnRef.current = { bitmap, width: frame.width, height: frame.height, kind: stream.kind }
            paint()
            setHasFrame(true)
            setPhase('live')
          } else bitmap.close()
        } catch {
          /* A frame that does not decode is skipped; the next one replaces it. */
        }
        // Every frame is acknowledged, drawn or not: the host sends the next ones only then.
        ack()
      }
      decoder.busy = false
    }

    const offs = [
      api.onBrowserStreamFrame((frame) => {
        if (frame.convId !== convId) return
        const ack = () => api.browserStreamAck(convId, frame.streamId, frame.seq)
        if (frame.streamId !== stream.streamId || frame.source !== stream.source) return ack()
        // A frame that arrives while another decodes replaces the one waiting, which is dropped.
        decoder.pending?.ack()
        decoder.pending = { frame, ack }
        if (!decoder.busy) void decode()
      }),
      api.onBrowserStreamSource((next) => {
        if (next.convId !== convId || next.streamId !== stream.streamId || next.source < stream.source) return
        if (next.source !== stream.source || next.kind !== stream.kind) {
          stream.source = next.source
          stream.kind = next.kind
          setSelect(null)
          if (next.kind === 'none') clearFrame()
        }
        setSource({ kind: next.kind, popup: next.popup })
        setPhase('live')
      }),
      api.onBrowserStreamEnded((ended) => {
        if (ended.convId !== convId || ended.streamId !== stream.streamId) return
        stream.streamId = null
        setSelect(null)
        setPhase(ended.reason === 'taken-over' ? 'taken-over' : ended.reason === 'unavailable' ? 'error' : 'connecting')
      }),
      api.onBrowserStreamCursor((next) => {
        if (next.convId === convId && next.streamId === stream.streamId) setCursor(next.cursor)
      }),
      api.onBrowserSelect((request) => {
        if (request.convId !== convId || request.streamId !== stream.streamId || request.source !== stream.source)
          return
        selectAnswered.current = false
        setSelect(request)
      }),
      api.onBrowserStreamNotice((next) => {
        if (next.convId === convId && next.streamId === stream.streamId) setNotice(next.notice)
      }),
    ]

    const { width, height } = surfaceSize()
    api.browserStreamStart(convId, width, height).then(
      ({ streamId }) => {
        if (disposed) {
          api.browserStreamStop(convId, streamId)
          return
        }
        stream.streamId = streamId
        if (document.activeElement === inputRef.current) send({ type: 'focus', focused: true })
      },
      () => {
        if (!disposed) setPhase('error')
      }
    )
    return () => {
      disposed = true
      for (const off of offs) off()
      decoder.pending = null
      if (stream.streamId) api.browserStreamStop(convId, stream.streamId)
      if (streamRef.current === stream) streamRef.current = null
    }
  }, [api, convId, active, online, visible, surfaceReady, host.epoch, retry, surfaceSize, paint, clearFrame, send])

  // A new conversation or host starts from a blank surface.
  useEffect(() => clearFrame, [convId, host.id, clearFrame])

  // Main catches Cmd/Ctrl+T and W while the keyboard is here; a surface removed with the focus must not keep them.
  const keyboardReported = useRef(false)
  const reportKeyboard = (focused: boolean) => {
    if (keyboardReported.current === focused) return
    keyboardReported.current = focused
    window.api.drawerBrowserKeyboardFocus(focused)
  }
  useEffect(
    () => () => {
      if (!keyboardReported.current) return
      keyboardReported.current = false
      window.api.drawerBrowserKeyboardFocus(false)
    },
    []
  )

  // The host's page follows the surface's size; the last frame is redrawn at once meanwhile.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      paint()
      const { width, height } = surfaceSize()
      setSurfaceReady(width > 0 && height > 0)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const stream = streamRef.current
        if (stream?.streamId && width > 0 && height > 0) api.browserStreamResize(convId, stream.streamId, width, height)
      }, RESIZE_DEBOUNCE_MS)
    }
    onResize()
    const observer = new ResizeObserver(onResize)
    observer.observe(container)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [api, convId, paint, surfaceSize])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // --- Pointer input ---------------------------------------------------------------------------------------------

  const pointRef = useRef<{
    move: BrowserStreamInput | null
    wheel: { x: number; y: number; dx: number; dy: number; modifiers: number } | null
    raf: number
  }>({
    move: null,
    wheel: null,
    raf: 0,
  })

  const framePoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    const drawn = drawnRef.current
    const fit = fitRef.current
    if (!canvas || !drawn || !fit) return null
    const rect = canvas.getBoundingClientRect()
    return toFramePoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, fit, drawn)
  }

  const flushPointer = useCallback(() => {
    const pending = pointRef.current
    if (pending.raf) cancelAnimationFrame(pending.raf)
    pending.raf = 0
    if (pending.move) send(pending.move)
    pending.move = null
    if (pending.wheel) {
      const { x, y, dx, dy, modifiers } = pending.wheel
      send({ type: 'wheel', x, y, deltaX: dx, deltaY: dy, modifiers })
    }
    pending.wheel = null
  }, [send])

  const schedulePointer = () => {
    const pending = pointRef.current
    if (!pending.raf) pending.raf = requestAnimationFrame(flushPointer)
  }

  const focusInput = (at?: { x: number; y: number }) => {
    const input = inputRef.current
    if (!input) return
    // The text field sits where the person clicked, so an IME's candidate window opens near the text.
    if (at) {
      input.style.left = `${Math.round(at.x)}px`
      input.style.top = `${Math.round(at.y)}px`
    }
    if (document.activeElement !== input) input.focus({ preventScroll: true })
  }

  const onMouseButton = (event: React.MouseEvent<HTMLCanvasElement>, action: 'down' | 'up') => {
    const point = framePoint(event)
    if (action === 'down') {
      event.preventDefault()
      const canvasRect = canvasRef.current?.getBoundingClientRect()
      focusInput(canvasRect && { x: event.clientX - canvasRect.left, y: event.clientY - canvasRect.top })
    }
    if (!point || (action === 'down' && !point.inside)) return
    flushPointer()
    send({
      type: 'mouse',
      action,
      x: point.x,
      y: point.y,
      button: BUTTONS[event.button] ?? 'none',
      buttons: event.buttons & 7,
      clickCount: Math.min(3, Math.max(1, event.detail || 1)),
      modifiers: mouseModifiers(event, os),
    })
  }

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const point = framePoint(event)
    if (!point || (!point.inside && !event.buttons)) return
    pointRef.current.move = {
      type: 'mouse',
      action: 'move',
      x: point.x,
      y: point.y,
      button: heldButton(event.buttons),
      buttons: event.buttons & 7,
      clickCount: 0,
      modifiers: mouseModifiers(event, os),
    }
    schedulePointer()
  }

  // React's wheel listener is passive; the surface takes the wheel for itself.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = framePoint(event)
      if (!point?.inside) return
      const { deltaX, deltaY } = wheelPixels(event, drawnRef.current?.height ?? 0)
      const pending = pointRef.current
      const previous = pending.wheel
      pending.wheel = {
        x: point.x,
        y: point.y,
        dx: (previous?.dx ?? 0) + deltaX,
        dy: (previous?.dy ?? 0) + deltaY,
        modifiers: mouseModifiers(event, os),
      }
      schedulePointer()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  })

  useEffect(
    () => () => {
      const pending = pointRef.current
      if (pending.raf) cancelAnimationFrame(pending.raf)
    },
    []
  )

  // --- Keyboard, text and clipboard ------------------------------------------------------------------------------

  const flushText = () => {
    const input = inputRef.current
    if (!input?.value) return
    const text = input.value
    input.value = ''
    for (let start = 0; start < text.length; start += BROWSER_STREAM_LIMITS.maxTextInputChars)
      send({ type: 'text', text: text.slice(start, start + BROWSER_STREAM_LIMITS.maxTextInputChars) })
  }

  const copy = async (cut: boolean) => {
    const id = streamRef.current?.streamId
    if (!id) return
    try {
      const text = await api.browserStreamCopy(convId, id, cut)
      if (text !== null) await navigator.clipboard.writeText(text)
    } catch {
      /* Nothing was copied: the page had no selection, or the host went away meanwhile. */
    }
  }

  const releaseKeys = () => {
    for (const down of keysDownRef.current.values()) send(keyUpInput(down))
    keysDownRef.current.clear()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent
    const route = routeKeyDown(
      {
        key: native.key,
        code: native.code,
        keyCode: native.keyCode,
        location: native.location,
        altKey: native.altKey,
        ctrlKey: native.ctrlKey,
        metaKey: native.metaKey,
        shiftKey: native.shiftKey,
        repeat: native.repeat,
        isComposing: native.isComposing,
      },
      os
    )
    switch (route.route) {
      case 'compose':
      case 'app':
      case 'paste':
        return
      case 'page':
        // Text typed before this key reaches the page first.
        flushText()
        send(route.input)
        keysDownRef.current.set(native.code || native.key, route.input)
        if (!route.typed) event.preventDefault()
        return
      case 'edit':
        event.preventDefault()
        send({ type: 'edit', command: route.command })
        return
      case 'copy':
        event.preventDefault()
        void copy(route.cut)
        return
      case 'browser': {
        event.preventDefault()
        if (route.action === 'focus-address') onFocusAddress()
        else if (route.action === 'reload') api.drawerReload(convId)
        else if (route.action === 'back') api.drawerBack(convId)
        else api.drawerForward(convId)
      }
    }
  }

  const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const id = event.nativeEvent.code || event.nativeEvent.key
    const down = keysDownRef.current.get(id)
    if (!down) return
    keysDownRef.current.delete(id)
    send(keyUpInput(down))
  }

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    // Copy and cut are always enabled in the text field, empty as it is: the page decides what they copy.
    const enable = (event: Event) => event.preventDefault()
    const onClipboard = (event: ClipboardEvent) => {
      event.preventDefault()
      if (event.type !== 'paste') return void copy(event.type === 'cut')
      const text = event.clipboardData?.getData('text/plain') ?? ''
      const html = event.clipboardData?.getData('text/html') ?? ''
      if (!text && !html) return
      if (text.length > BROWSER_STREAM_LIMITS.maxClipboardChars) return
      const id = streamRef.current?.streamId
      if (!id) return
      flushText()
      api.browserStreamPaste(convId, id, {
        text,
        ...(html && html.length <= BROWSER_STREAM_LIMITS.maxPasteHtmlChars ? { html } : {}),
      })
    }
    input.addEventListener('beforecopy', enable)
    input.addEventListener('beforecut', enable)
    input.addEventListener('copy', onClipboard)
    input.addEventListener('cut', onClipboard)
    input.addEventListener('paste', onClipboard)
    return () => {
      input.removeEventListener('beforecopy', enable)
      input.removeEventListener('beforecut', enable)
      input.removeEventListener('copy', onClipboard)
      input.removeEventListener('cut', onClipboard)
      input.removeEventListener('paste', onClipboard)
    }
  })

  // --- <select> lists -----------------------------------------------------------------------------------------------

  const answerSelect = (index: number | null) => {
    const request = select
    if (!request || selectAnswered.current) return
    selectAnswered.current = true
    api.browserStreamChooseOption(convId, request.streamId, request.requestId, index)
    setSelect(null)
  }

  const selectAnchor = (() => {
    const fit = fitRef.current
    if (!select || !fit) return null
    return toSurfaceRect(select.rect, fit)
  })()

  const groups: Array<{ label: string | null; items: Array<{ index: number; label: string; disabled: boolean }> }> = []
  for (const [index, option] of (select?.options ?? []).entries()) {
    const last = groups.at(-1)
    if (last && last.label === option.group) last.items.push({ index, ...option })
    else groups.push({ label: option.group, items: [{ index, label: option.label, disabled: option.disabled }] })
  }

  const overlay = (() => {
    if (!online) return { text: t('remoteBrowser.offline'), action: null }
    if (phase === 'taken-over')
      return {
        text: t('remoteBrowser.takenOver'),
        action: { label: t('remoteBrowser.showHere'), run: () => setRetry((n) => n + 1) },
      }
    if (phase === 'error')
      return {
        text: t('remoteBrowser.unavailable'),
        action: { label: t('remoteBrowser.retry'), run: () => setRetry((n) => n + 1) },
      }
    if (phase === 'live' && source.kind === 'none') return { text: t('remoteBrowser.noTab'), action: null }
    if (!hasFrame) return { text: t('remoteBrowser.connecting'), action: null, busy: true }
    return null
  })()

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-[#0A0A0B]"
      data-testid="remote-browser"
      // The browser chrome of the same conversation runs Cmd/Ctrl+T and W pressed over this page.
      data-browser-surface={convId}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none select-none outline-none"
        style={{ cursor }}
        role="img"
        aria-label={t('remoteBrowser.surface')}
        data-testid="remote-browser-canvas"
        data-live={phase === 'live' && hasFrame ? 'true' : 'false'}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onMouseDown={(event) => onMouseButton(event, 'down')}
        onMouseUp={(event) => onMouseButton(event, 'up')}
        onMouseMove={onMouseMove}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={inputRef}
        aria-label={t('remoteBrowser.keyboard')}
        data-testid="remote-browser-keyboard"
        className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onInput={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) flushText()
        }}
        onCompositionEnd={flushText}
        onFocus={() => {
          reportKeyboard(true)
          send({ type: 'focus', focused: true })
        }}
        onBlur={() => {
          reportKeyboard(false)
          releaseKeys()
          send({ type: 'focus', focused: false })
        }}
      />

      {source.kind === 'popup' && source.popup && phase === 'live' && (
        <div className="absolute inset-x-0 top-0 z-10 flex h-9 items-center gap-2 border-b border-white/[0.08] bg-[#111113] px-3 text-xs text-muted-foreground">
          <KeyRound className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('remoteBrowser.popup', { host: hostOf(source.popup.url) })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              const id = streamRef.current?.streamId
              if (id) api.browserStreamClosePopup(convId, id)
            }}
          >
            {t('remoteBrowser.closePopup')}
          </Button>
        </div>
      )}

      {notice === 'file-chooser' && (
        <div
          role="status"
          className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
          <span className="min-w-0 flex-1">{t('remoteBrowser.fileChooser')}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => setNotice(null)}
            aria-label={t('remoteBrowser.dismiss')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {overlay && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#0A0A0B]/90 text-sm text-muted-foreground">
          {'busy' in overlay && overlay.busy && <Loader2 className="size-5 animate-spin" />}
          <p className="max-w-xs text-center" data-testid="remote-browser-status">
            {overlay.text}
          </p>
          {overlay.action && (
            <Button variant="secondary" size="sm" onClick={overlay.action.run}>
              {overlay.action.label}
            </Button>
          )}
        </div>
      )}

      {select && selectAnchor && (
        <Select
          open
          value={select.selectedIndex >= 0 ? String(select.selectedIndex) : undefined}
          onValueChange={(value) => answerSelect(Number(value))}
          onOpenChange={(open) => {
            if (!open) answerSelect(null)
          }}
        >
          <SelectTrigger
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute border-0 p-0 opacity-0"
            style={{
              left: selectAnchor.x,
              top: selectAnchor.y,
              width: Math.max(1, selectAnchor.width),
              height: Math.max(1, selectAnchor.height),
            }}
          />
          <SelectContent
            data-testid="remote-browser-select"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              focusInput()
            }}
          >
            {groups.map((group, groupIndex) =>
              group.label === null ? (
                group.items.map((item) => (
                  <SelectItem key={item.index} value={String(item.index)} disabled={item.disabled}>
                    {item.label || ' '}
                  </SelectItem>
                ))
              ) : (
                <SelectGroup key={`group-${groupIndex}`}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.items.map((item) => (
                    <SelectItem key={item.index} value={String(item.index)} disabled={item.disabled}>
                      {item.label || ' '}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )
            )}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
