import { FLEET_SCREEN, type ScreenHello } from '@maestrly/bot-fleet-protocol'
import type { FleetScreenChannel } from './screen-channel'
import {
  WheelSteps,
  contentBox,
  crispRendering,
  cursorStyle,
  pngDataUrl,
  screenButtons,
  screenPoint,
  type ContentBox,
} from './screen-geometry'
import { ScreenStreamCore } from './screen-stream-core'

/** noVNC's keyboard module (`@novnc/novnc/core/input/keyboard.js`), which `loadScreenKeyboard` loads. */
type ScreenKeyboard = {
  onkeyevent: (keysym: number, code: string, down: boolean) => void
  grab(): void
  ungrab(): void
}
export type ScreenKeyboardConstructor = new (target: Element) => ScreenKeyboard

/** Decoder failures in a row, with no frame drawn in between, after which the screen gives up. */
const DECODER_FAILURES_MAX = 5

/**
 * Shows a screen's video stream in `target` and sends the owner's input to it. One `<canvas>` of the remote screen's
 * size fills the target, letterboxed; frames are decoded with WebCodecs and acknowledged once drawn, which paces the
 * stream. It keeps the surface of noVNC's client that the screen and its clipboard use: `viewOnly`, `focus()`,
 * `disconnect()`, `clipboardPasteFrom()`, `sendKey()` and the `connect`, `disconnect` and `clipboard` events.
 *
 * Under control the canvas shows the remote pointer's sprite as its own cursor, so the pointer moves without a round
 * trip; a viewer sees the remote pointer where the screen reports it instead.
 */
export class ScreenVideoClient extends EventTarget {
  private readonly canvas: HTMLCanvasElement
  private readonly pointerImage: HTMLImageElement
  private readonly context: CanvasRenderingContext2D | null
  private readonly core: ScreenStreamCore
  private readonly keyboard: ScreenKeyboard
  private readonly wheelSteps = new WheelSteps()
  private readonly resizeObserver: ResizeObserver | null
  private readonly removeListeners: Array<() => void> = []
  private decoder: VideoDecoder | null = null
  private decoderCodec: string | null = null
  private decoderFailures = 0
  /** Frames given to the decoder and not drawn yet, oldest first. */
  private decoding: number[] = []
  private size: { width: number; height: number } = { width: FLEET_SCREEN.width, height: FLEET_SCREEN.height }
  private cursor: { style: string; hotX: number; hotY: number; url: string | null } | null = null
  private remotePointer: { x: number; y: number } | null = null
  private viewOnlyValue = true
  private grabbed = false
  private connected = false
  private ended = false

  constructor(
    private readonly target: HTMLElement,
    private readonly channel: FleetScreenChannel,
    options: { Keyboard: ScreenKeyboardConstructor }
  ) {
    super()
    const doc = target.ownerDocument
    this.canvas = doc.createElement('canvas')
    this.canvas.width = this.size.width
    this.canvas.height = this.size.height
    this.canvas.tabIndex = -1
    Object.assign(this.canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      outline: 'none',
      touchAction: 'none',
    })
    this.pointerImage = doc.createElement('img')
    this.pointerImage.alt = ''
    this.pointerImage.draggable = false
    this.pointerImage.setAttribute('aria-hidden', 'true')
    Object.assign(this.pointerImage.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      display: 'none',
    })
    this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
    target.append(this.canvas, this.pointerImage)

    this.core = new ScreenStreamCore((bytes) => this.send(bytes), {
      hello: (hello) => this.hello(hello),
      decode: (frame) => this.decode(frame),
      cursor: (hotX, hotY, png) => this.setCursor(hotX, hotY, png),
      pointer: (x, y) => {
        this.remotePointer = x < 0 || y < 0 ? null : { x, y }
        this.placePointer()
      },
      clipboard: (text) =>
        this.dispatchEvent(
          new CustomEvent('clipboard', { detail: text === null ? { text: '', tooLarge: true } : { text } })
        ),
      protocolError: () => this.disconnect(),
    })
    this.keyboard = new options.Keyboard(this.canvas)
    this.keyboard.onkeyevent = (keysym, _code, down) => {
      if (!this.viewOnlyValue && !this.ended) this.core.key(keysym, down)
    }
    const pointer = (event: Event) => this.pointer(event as PointerEvent)
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) this.listen(this.canvas, type, pointer)
    this.listen(this.canvas, 'wheel', (event) => this.wheel(event as WheelEvent), { passive: false })
    this.listen(this.canvas, 'contextmenu', (event) => {
      if (!this.viewOnlyValue) event.preventDefault()
    })
    this.listen(this.pointerImage, 'load', () => this.placePointer())
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layout()) : null
    this.resizeObserver?.observe(this.canvas)
    // The channel may hold what arrived before this client: read it once the caller listens for `connect`.
    queueMicrotask(() => {
      if (this.ended) return
      this.channel.binaryType = 'arraybuffer'
      this.channel.onclose = () => this.end()
      if (this.channel.readyState === WebSocket.CLOSED) {
        this.end()
        return
      }
      this.channel.onmessage = (event) => this.core.receive(event.data)
    })
  }

  get viewOnly(): boolean {
    return this.viewOnlyValue
  }
  set viewOnly(value: boolean) {
    this.viewOnlyValue = value
    if (value && this.grabbed) {
      this.keyboard.ungrab()
      this.grabbed = false
    } else if (!value && !this.grabbed && !this.ended) {
      this.keyboard.grab()
      this.grabbed = true
    }
    this.applyCursor()
    this.placePointer()
  }

  focus(options?: FocusOptions): void {
    this.canvas.focus(options)
  }

  /** Sends a key to the screen: pressed and released when `down` is left out. */
  sendKey(keysym: number, _code: string, down?: boolean): void {
    if (this.ended) return
    if (down === undefined) {
      this.core.key(keysym, true)
      this.core.key(keysym, false)
    } else this.core.key(keysym, down)
  }

  /** Sets the screen's clipboard. Text over the stream's limit is dropped: the clipboard bridge refuses it first. */
  clipboardPasteFrom(text: string): void {
    if (this.ended) return
    try {
      this.core.clipboard(text)
    } catch {
      // Too large for the stream.
    }
  }

  disconnect(): void {
    if (this.ended) return
    this.teardown()
    this.channel.close()
    this.dispatchEvent(new Event('disconnect'))
  }

  private end(): void {
    if (this.ended) return
    this.teardown()
    this.dispatchEvent(new Event('disconnect'))
  }

  private teardown(): void {
    this.ended = true
    if (this.grabbed) this.keyboard.ungrab()
    this.grabbed = false
    this.resizeObserver?.disconnect()
    for (const remove of this.removeListeners.splice(0)) remove()
    this.resetDecoder()
    this.channel.onmessage = null
    this.channel.onclose = null
    this.canvas.remove()
    this.pointerImage.remove()
  }

  private listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, options)
    this.removeListeners.push(() => target.removeEventListener(type, listener, options))
  }

  private send(bytes: Uint8Array): void {
    if (this.ended || this.channel.readyState !== WebSocket.OPEN) return
    this.channel.send(bytes)
  }

  private hello(hello: ScreenHello): void {
    this.size = { width: hello.width, height: hello.height }
    if (this.canvas.width !== hello.width) this.canvas.width = hello.width
    if (this.canvas.height !== hello.height) this.canvas.height = hello.height
    this.layout()
    if (this.connected) return
    this.connected = true
    this.dispatchEvent(new Event('connect'))
  }

  private decode(frame: { id: number; key: boolean; data: Uint8Array; codec: string }): void {
    if (this.ended) return
    if (typeof VideoDecoder !== 'function') {
      this.disconnect()
      return
    }
    if (!this.decoder || this.decoder.state === 'closed' || this.decoderCodec !== frame.codec) {
      this.resetDecoder()
      const decoder: VideoDecoder = new VideoDecoder({
        output: (picture) => this.draw(picture, decoder),
        error: () => this.decoderFailed(decoder),
      })
      this.decoder = decoder
      this.decoderCodec = frame.codec
      try {
        decoder.configure({ codec: frame.codec, optimizeForLatency: true })
      } catch {
        this.core.decoded(frame.id)
        this.decoderFailed(decoder)
        return
      }
    }
    const decoder = this.decoder
    this.decoding.push(frame.id)
    try {
      decoder.decode(
        new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.id, data: frame.data })
      )
    } catch {
      this.decoderFailed(decoder)
    }
  }

  private draw(picture: VideoFrame, decoder: VideoDecoder): void {
    const id = picture.timestamp
    if (decoder !== this.decoder || this.ended) {
      picture.close()
      return
    }
    this.context?.drawImage(picture, 0, 0, this.canvas.width, this.canvas.height)
    picture.close()
    this.decoderFailures = 0
    this.decoding = this.decoding.filter((pending) => pending > id)
    // The screen counts what it sent until acknowledged: an acknowledgement covers every frame before it too.
    this.core.decoded(id)
  }

  /** A decoder that failed is replaced at the next key frame; the frames it held are acknowledged as lost. */
  private decoderFailed(decoder: VideoDecoder): void {
    if (decoder !== this.decoder || this.ended) return
    const last = this.decoding.at(-1)
    this.resetDecoder()
    if (last !== undefined) this.core.decoded(last)
    if (++this.decoderFailures >= DECODER_FAILURES_MAX) {
      this.disconnect()
      return
    }
    this.core.decoderFailed()
  }

  private resetDecoder(): void {
    const decoder = this.decoder
    this.decoder = null
    this.decoderCodec = null
    this.decoding = []
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close()
      } catch {
        // Already closed by its own error.
      }
    }
  }

  private setCursor(hotX: number, hotY: number, png: Uint8Array): void {
    this.cursor = {
      style: cursorStyle(hotX, hotY, png),
      hotX,
      hotY,
      url: png.byteLength ? pngDataUrl(png) : null,
    }
    this.applyCursor()
    this.placePointer()
  }

  /** Under control the remote sprite is the canvas's cursor; a viewer keeps the frame's own cursor. */
  private applyCursor(): void {
    if (this.ended) return
    this.canvas.style.cursor = !this.viewOnlyValue && this.cursor ? this.cursor.style : ''
  }

  /** Where the screen is drawn, relative to the target. */
  private box(): ContentBox {
    const canvas = this.canvas.getBoundingClientRect()
    const target = this.target.getBoundingClientRect()
    return contentBox(
      { left: canvas.left - target.left, top: canvas.top - target.top, width: canvas.width, height: canvas.height },
      this.size.width,
      this.size.height
    )
  }

  private placePointer(): void {
    if (this.ended) return
    const image = this.pointerImage
    const url = this.cursor?.url
    if (!this.viewOnlyValue || !this.remotePointer || !url || !this.cursor) {
      image.style.display = 'none'
      return
    }
    if (image.getAttribute('src') !== url) {
      image.src = url
      // Placed once it loads and has a size.
      if (!image.complete) return
    }
    const box = this.box()
    const { x, y } = this.remotePointer
    Object.assign(image.style, {
      display: 'block',
      width: `${image.naturalWidth * box.scale}px`,
      height: `${image.naturalHeight * box.scale}px`,
      transform: `translate(${box.left + (x - this.cursor.hotX) * box.scale}px, ${
        box.top + (y - this.cursor.hotY) * box.scale
      }px)`,
    })
  }

  private layout(): void {
    if (this.ended) return
    const box = contentBox(this.canvas.getBoundingClientRect(), this.size.width, this.size.height)
    this.canvas.style.imageRendering = crispRendering(box, window.devicePixelRatio || 1)
    this.placePointer()
  }

  private pointer(event: PointerEvent): void {
    if (this.viewOnlyValue || this.ended) return
    if (event.type === 'pointerdown') {
      this.canvas.focus({ preventScroll: true })
      try {
        this.canvas.setPointerCapture(event.pointerId)
      } catch {
        // The pointer is gone already.
      }
    }
    this.sendPointer(event)
  }

  private sendPointer(event: MouseEvent): void {
    const box = contentBox(this.canvas.getBoundingClientRect(), this.size.width, this.size.height)
    const { x, y } = screenPoint(event.clientX, event.clientY, box, this.size.width, this.size.height)
    this.core.pointer(x, y, screenButtons(event.buttons))
  }

  private wheel(event: WheelEvent): void {
    if (this.viewOnlyValue || this.ended) return
    event.preventDefault()
    // The screen scrolls what is under its pointer.
    this.sendPointer(event)
    const { dx, dy } = this.wheelSteps.add(event.deltaX, event.deltaY, event.deltaMode, this.canvas.clientHeight)
    const clamp = (steps: number) => Math.max(-32768, Math.min(32767, steps))
    if (dx || dy) this.core.wheel(clamp(dx), clamp(dy))
  }
}
