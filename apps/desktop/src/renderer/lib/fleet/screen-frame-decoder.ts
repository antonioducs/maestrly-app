/** Decoder failures in a row, with no frame drawn in between, after which a screen gives up. */
export const DECODER_FAILURES_MAX = 5

export interface ScreenFrameDecoderOptions {
  /** A frame was drawn, or lost: the screen may send more. Acknowledgements cover every earlier frame too. */
  decoded(id: number): void
  /** The decoder failed and was reset: the screen needs a key frame. */
  failed(): void
  /** WebCodecs is missing, or the decoder failed too often: the screen cannot be shown. */
  fatal(): void
  /** Draws a decoded picture and closes it; a promise acknowledges the frame once it settles. */
  picture(frame: VideoFrame): void | Promise<void>
}

/**
 * The WebCodecs side of a screen: H.264 access units in, pictures out, and acknowledgements as they are drawn. The
 * frame id travels as the chunk's timestamp. A decoder that fails is replaced at the next key frame, and the frames it
 * held are acknowledged as lost.
 */
export class ScreenFrameDecoder {
  private decoder: VideoDecoder | null = null
  private codec: string | null = null
  private failures = 0
  /** Frames given to the decoder and not drawn yet, oldest first. */
  private decoding: number[] = []
  private acknowledged = -1
  private closed = false

  constructor(private readonly options: ScreenFrameDecoderOptions) {}

  decode(frame: { id: number; key: boolean; data: Uint8Array; codec: string }): void {
    if (this.closed) return
    if (typeof VideoDecoder !== 'function') {
      this.options.fatal()
      return
    }
    if (!this.decoder || this.decoder.state === 'closed' || this.codec !== frame.codec) {
      this.reset()
      const decoder: VideoDecoder = new VideoDecoder({
        output: (picture) => this.output(picture, decoder),
        error: () => this.failed(decoder),
      })
      this.decoder = decoder
      this.codec = frame.codec
      try {
        decoder.configure({ codec: frame.codec, optimizeForLatency: true })
      } catch {
        this.acknowledge(frame.id)
        this.failed(decoder)
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
      this.failed(decoder)
    }
  }

  /** Closes the decoder; a later frame opens a new one. */
  reset(): void {
    const decoder = this.decoder
    this.decoder = null
    this.codec = null
    this.decoding = []
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close()
      } catch {
        // Already closed by its own error.
      }
    }
  }

  /** Stops for good: pictures still on their way are closed undrawn. */
  close(): void {
    this.closed = true
    this.reset()
  }

  private output(picture: VideoFrame, decoder: VideoDecoder): void {
    const id = picture.timestamp
    if (decoder !== this.decoder || this.closed) {
      picture.close()
      return
    }
    this.failures = 0
    this.decoding = this.decoding.filter((pending) => pending > id)
    let drawn: void | Promise<void>
    try {
      drawn = this.options.picture(picture)
    } catch {
      drawn = undefined
    }
    if (drawn instanceof Promise)
      drawn.then(
        () => this.acknowledge(id),
        () => this.acknowledge(id)
      )
    else this.acknowledge(id)
  }

  /** The screen counts what it sent until acknowledged: an acknowledgement covers every frame before it too. */
  private acknowledge(id: number): void {
    if (this.closed || id <= this.acknowledged) return
    this.acknowledged = id
    this.options.decoded(id)
  }

  private failed(decoder: VideoDecoder): void {
    if (decoder !== this.decoder || this.closed) return
    const last = this.decoding.at(-1)
    this.reset()
    if (last !== undefined) this.acknowledge(last)
    if (++this.failures >= DECODER_FAILURES_MAX) {
      this.options.fatal()
      return
    }
    this.options.failed()
  }
}
