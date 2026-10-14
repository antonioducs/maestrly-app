import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  decodeServerMessage,
  encodeAck,
  encodeClipboardInput,
  encodeKey,
  encodeKeyframeRequest,
  encodePointerInput,
  encodeWheel,
  h264CodecString,
  type ScreenHello,
  type ScreenServerEvent,
} from '@maestrly/bot-fleet-protocol'

/** What a screen's stream asks of the view that shows it. */
export interface ScreenCoreSink {
  hello(hello: ScreenHello): void
  /** A frame to decode; `codec` is the WebCodecs codec string of the last key frame's SPS. */
  decode(frame: { id: number; key: boolean; data: Uint8Array; codec: string }): void
  cursor(hotX: number, hotY: number, png: Uint8Array): void
  /** The screen's pointer, for viewers: -1, -1 when it is off the screen. */
  pointer(x: number, y: number): void
  /** The screen's clipboard after it changed, or `null` when it holds more than can be sent. */
  clipboard(text: string | null): void
  protocolError(error: Error): void
}

/**
 * The app's side of a screen stream, apart from the DOM: it reads the screen's messages, holds delta frames back until
 * the decoder has a key frame to start from, and writes acknowledgements and input. A frame it does not decode is
 * acknowledged all the same, so the screen never counts it as in flight.
 */
export class ScreenStreamCore {
  private readonly reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
  private waitingForKey = true
  private codec: string | null = null
  private broken = false

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly sink: ScreenCoreSink
  ) {}

  receive(data: ArrayBuffer | Uint8Array): void {
    if (this.broken) return
    let events: ScreenServerEvent[]
    try {
      events = this.reader
        .push(data instanceof Uint8Array ? data : new Uint8Array(data))
        .map((message) => decodeServerMessage(message))
    } catch (error) {
      this.broken = true
      this.sink.protocolError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const event of events) {
      if (event.type === 'hello') this.sink.hello(event.hello)
      else if (event.type === 'frame') this.frame(event)
      else if (event.type === 'cursor') this.sink.cursor(event.hotX, event.hotY, event.png)
      else if (event.type === 'pointer') this.sink.pointer(event.x, event.y)
      else this.sink.clipboard(event.tooLarge ? null : event.text)
    }
  }

  /** A frame was drawn. */
  decoded(id: number): void {
    this.send(encodeAck(id))
  }

  /** The decoder failed or was reset: it needs a key frame, and nothing until then. */
  decoderFailed(): void {
    this.waitingForKey = true
    this.send(encodeKeyframeRequest())
  }

  pointer(x: number, y: number, buttons: number): void {
    this.send(encodePointerInput(x, y, buttons))
  }
  wheel(dx: number, dy: number): void {
    this.send(encodeWheel(dx, dy))
  }
  key(keysym: number, down: boolean): void {
    this.send(encodeKey(keysym, down))
  }
  /** Throws a `ScreenProtocolError` for text over the clipboard limit. */
  clipboard(text: string): void {
    this.send(encodeClipboardInput(text))
  }

  private frame(frame: Extract<ScreenServerEvent, { type: 'frame' }>): void {
    if (frame.key) {
      this.codec = h264CodecString(frame.data) ?? this.codec
      if (!this.codec) {
        this.decoded(frame.id)
        this.decoderFailed()
        return
      }
      this.waitingForKey = false
    } else if (this.waitingForKey || !this.codec) {
      this.decoded(frame.id)
      return
    }
    this.sink.decode({ id: frame.id, key: frame.key, data: frame.data, codec: this.codec })
  }
}
