import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECODER_FAILURES_MAX, ScreenFrameDecoder } from '../../src/renderer/lib/fleet/screen-frame-decoder'

/** A WebCodecs decoder the test drives: it emits pictures and errors when told. */
class FakeDecoder {
  static made: FakeDecoder[] = []
  state = 'unconfigured'
  chunks: { type: string; timestamp: number }[] = []
  constructor(readonly init: { output(picture: unknown): void; error(error: unknown): void }) {
    FakeDecoder.made.push(this)
  }
  configure() {
    this.state = 'configured'
  }
  decode(chunk: { type: string; timestamp: number }) {
    this.chunks.push(chunk)
  }
  close() {
    this.state = 'closed'
  }
  /** Outputs the picture of a frame given to it. */
  emit(id: number) {
    const picture = { timestamp: id, close: vi.fn() }
    this.init.output(picture)
    return picture
  }
  fail() {
    this.init.error(new Error('decode failed'))
  }
}

function setup(picture: (frame: VideoFrame) => void | Promise<void> = (frame) => frame.close()) {
  FakeDecoder.made = []
  vi.stubGlobal('VideoDecoder', FakeDecoder)
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(init: { type: string; timestamp: number }) {
        Object.assign(this, init)
      }
    }
  )
  const calls = { decoded: [] as number[], failed: 0, fatal: 0 }
  const decoder = new ScreenFrameDecoder({
    decoded: (id) => void calls.decoded.push(id),
    failed: () => void calls.failed++,
    fatal: () => void calls.fatal++,
    picture,
  })
  const frame = (id: number, key = false) => ({ id, key, data: new Uint8Array([0, 0, 1]), codec: 'avc1.42E01F' })
  return { decoder, calls, frame }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ScreenFrameDecoder', () => {
  it('hands each picture over and acknowledges it once drawn', async () => {
    let finish: () => void = () => undefined
    const drawn = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pictures: unknown[] = []
    const { decoder, calls, frame } = setup((picture) => {
      pictures.push(picture)
      return drawn
    })
    decoder.decode(frame(1, true))
    expect(FakeDecoder.made[0].chunks).toEqual([expect.objectContaining({ type: 'key', timestamp: 1 })])
    FakeDecoder.made[0].emit(1)
    expect(pictures).toHaveLength(1)
    expect(calls.decoded).toEqual([])
    finish()
    await drawn
    await Promise.resolve()
    expect(calls.decoded).toEqual([1])
  })

  it('acknowledges the larger id when pictures finish out of order', async () => {
    const pending: Array<() => void> = []
    const { decoder, calls, frame } = setup(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve)
        })
    )
    decoder.decode(frame(1, true))
    decoder.decode(frame(2))
    FakeDecoder.made[0].emit(1)
    FakeDecoder.made[0].emit(2)
    pending[1]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    pending[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.decoded).toEqual([2])
  })

  it('resets after a failure, acknowledging what it held, and gives up after too many in a row', () => {
    const { decoder, calls, frame } = setup()
    decoder.decode(frame(1, true))
    decoder.decode(frame(2))
    FakeDecoder.made[0].fail()
    expect(calls.decoded).toEqual([2])
    expect(calls.failed).toBe(1)
    expect(FakeDecoder.made[0].state).toBe('closed')
    for (let id = 3; id < 3 + DECODER_FAILURES_MAX - 1; id++) {
      decoder.decode(frame(id, true))
      FakeDecoder.made.at(-1)!.fail()
    }
    expect(calls.fatal).toBe(1)
    expect(calls.failed).toBe(DECODER_FAILURES_MAX - 1)
  })

  it('closes pictures that come after it closed, and is fatal without WebCodecs', () => {
    const { decoder, calls, frame } = setup()
    decoder.decode(frame(1, true))
    const made = FakeDecoder.made[0]
    decoder.close()
    const late = made.emit(1)
    expect(late.close).toHaveBeenCalled()
    expect(calls.decoded).toEqual([])
    vi.stubGlobal('VideoDecoder', undefined)
    const other = setup()
    vi.stubGlobal('VideoDecoder', undefined)
    other.decoder.decode(other.frame(1, true))
    expect(other.calls.fatal).toBe(1)
  })
})
