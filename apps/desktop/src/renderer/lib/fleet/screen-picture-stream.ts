import type { FleetScreenChannel } from './screen-channel'
import { ScreenFrameDecoder } from './screen-frame-decoder'
import { ScreenStreamCore } from './screen-stream-core'

/** How a picture stream ended: the screen's close code, or `error` when it broke on this side. */
export type ScreenPictureEnd = { code: number | null; error: boolean }

/**
 * A screen watched only for its pictures, with no input and no canvas of its own: each decoded picture goes to
 * `onPicture`, which draws it where it likes and closes it; the frame is acknowledged once that settles, which paces the
 * stream. It sends `connect` once the screen says hello, and `disconnect` (a `CustomEvent<ScreenPictureEnd>`) once
 * the stream ends.
 */
export class ScreenPicturePlayer extends EventTarget {
  private readonly core: ScreenStreamCore
  private readonly frames: ScreenFrameDecoder
  private connected = false
  private ended = false

  constructor(
    private readonly channel: FleetScreenChannel,
    onPicture: (frame: VideoFrame) => Promise<void>
  ) {
    super()
    this.core = new ScreenStreamCore((bytes) => this.send(bytes), {
      hello: () => {
        if (this.connected || this.ended) return
        this.connected = true
        this.dispatchEvent(new Event('connect'))
      },
      decode: (frame) => this.frames.decode(frame),
      cursor: () => undefined,
      pointer: () => undefined,
      clipboard: () => undefined,
      protocolError: () => this.fail(),
    })
    this.frames = new ScreenFrameDecoder({
      decoded: (id) => this.core.decoded(id),
      failed: () => this.core.decoderFailed(),
      fatal: () => this.fail(),
      picture: onPicture,
    })
    // The channel may hold what arrived before this player: read it once the caller listens.
    queueMicrotask(() => {
      if (this.ended) return
      this.channel.binaryType = 'arraybuffer'
      this.channel.onclose = (event) => this.end({ code: event.code, error: false })
      this.channel.onerror = () => this.fail()
      if (this.channel.readyState === WebSocket.CLOSED) {
        this.end({ code: null, error: false })
        return
      }
      this.channel.onmessage = (event) => this.core.receive(event.data)
    })
  }

  /** Stops watching; no `disconnect` follows. */
  close(): void {
    if (this.ended) return
    this.teardown()
    this.channel.close()
  }

  private send(bytes: Uint8Array): void {
    if (this.ended || this.channel.readyState !== WebSocket.OPEN) return
    try {
      this.channel.send(bytes)
    } catch {
      this.fail()
    }
  }

  private fail(): void {
    if (this.ended) return
    this.channel.close()
    this.end({ code: null, error: true })
  }

  private end(detail: ScreenPictureEnd): void {
    if (this.ended) return
    this.teardown()
    this.dispatchEvent(new CustomEvent<ScreenPictureEnd>('disconnect', { detail }))
  }

  private teardown(): void {
    this.ended = true
    this.frames.close()
    this.channel.onmessage = null
    this.channel.onclose = null
    this.channel.onerror = null
  }
}
