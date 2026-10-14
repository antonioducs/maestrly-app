import {
  ScreenMessageReader,
  SCREEN_LIMITS,
  decodeServerMessage,
  encodeAck,
  encodeClipboardInput,
  encodeKey,
  encodeKeyframeRequest,
  encodePointerInput,
  encodeScreenMessage,
  encodeWheel,
  type ScreenServerEvent,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import type { EncoderEvent } from '../../src/main/fleet/instance/screen-encoder'
import {
  SCREEN_LEVELS,
  ScreenSession,
  type ScreenEncoderPort,
  type ScreenPeer,
} from '../../src/main/fleet/instance/screen-session'

const KiB = 1024

class FakeEncoder implements ScreenEncoderPort {
  readonly calls: [string, ...unknown[]][] = []
  keyframe = () => void this.calls.push(['keyframe'])
  invalidate = (id: number) => void this.calls.push(['invalidate', id])
  tune = (level: unknown) => void this.calls.push(['tune', level])
  pointer = (x: number, y: number, buttons: number) => void this.calls.push(['pointer', x, y, buttons])
  wheel = (dx: number, dy: number) => void this.calls.push(['wheel', dx, dy])
  key = (keysym: number, down: boolean) => void this.calls.push(['key', keysym, down])
  clipboard = (text: string) => void this.calls.push(['clipboard', text])
  watch = (flags: unknown) => void this.calls.push(['watch', flags])
  release = () => void this.calls.push(['release'])
  named(name: string): unknown[][] {
    return this.calls.filter(([call]) => call === name).map(([, ...args]) => args)
  }
}

class FakePeer implements ScreenPeer {
  closed = false
  private readonly reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
  readonly events: ScreenServerEvent[] = []
  send(bytes: Uint8Array): void {
    for (const message of this.reader.push(bytes)) this.events.push(decodeServerMessage(message))
  }
  close(): void {
    this.closed = true
  }
  frames(): number[] {
    return this.events.flatMap((event) => (event.type === 'frame' ? [event.id] : []))
  }
}

/** Timers the test advances by hand. */
class Clock {
  now = 0
  private timers: { at: number; callback: () => void }[] = []
  readonly deps = {
    now: () => this.now,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { at: this.now + ms, callback }
      this.timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      this.timers = this.timers.filter((entry) => entry !== (timer as unknown))
    },
    log: (message: string) => void this.logs.push(message),
  }
  readonly logs: string[] = []
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const next = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.timers = this.timers.filter((timer) => timer !== next)
      this.now = next.at
      next.callback()
    }
    this.now = end
  }
}

const frame = (id: number, ref: number, key = false, size = 10): EncoderEvent => ({
  type: 'frame',
  id,
  ref,
  key,
  data: new Uint8Array(size),
})
const tuned = (level: number, paintover = false) => ({ ...SCREEN_LEVELS[level], paintover, paintoverAfterFrames: 10 })

function setup() {
  const clock = new Clock()
  const encoder = new FakeEncoder()
  const session = new ScreenSession(encoder, { width: 1280, height: 800 }, clock.deps)
  const join = (mode: 'view' | 'control') => {
    const peer = new FakePeer()
    const handle = session.attach(peer, mode)
    return { peer, handle, ack: (id: number) => handle.receive(encodeAck(id)) }
  }
  return { clock, encoder, session, join }
}

describe('ScreenSession', () => {
  it('greets a client and withholds delta frames until a key frame', () => {
    const { encoder, session, join } = setup()
    expect(encoder.named('tune')).toEqual([[tuned(1)]])
    const { peer } = join('control')
    expect(peer.events[0]).toEqual({ type: 'hello', hello: { version: 1, width: 1280, height: 800, mode: 'control' } })
    expect(encoder.named('keyframe')).toHaveLength(1)
    session.handle(frame(1, 0))
    session.handle(frame(2, -1, true))
    session.handle(frame(3, 2))
    expect(peer.frames()).toEqual([2, 3])
    expect(encoder.named('invalidate')).toEqual([])
  })

  it('sends the latest cursor to a client that joins later', () => {
    const { session, join } = setup()
    session.handle({ type: 'cursor', hotX: 1, hotY: 1, png: Uint8Array.of(1) })
    session.handle({ type: 'cursor', hotX: 4, hotY: 8, png: Uint8Array.of(2) })
    const { peer } = join('view')
    expect(peer.events.slice(0, 2)).toEqual([
      { type: 'hello', hello: { version: 1, width: 1280, height: 800, mode: 'view' } },
      { type: 'cursor', hotX: 4, hotY: 8, png: Uint8Array.of(2) },
    ])
  })

  it('skips and invalidates a frame whose reference a client lacks, once for all clients', () => {
    const { encoder, session, join } = setup()
    const a = join('view')
    const b = join('view')
    session.handle(frame(1, -1, true))
    a.ack(1)
    b.ack(1)
    session.handle(frame(2, 1, false, 300 * KiB))
    // 2 is still in flight for both, and 3 would overflow their windows.
    session.handle(frame(3, 2, false, 10 * KiB))
    session.handle(frame(4, 3))
    expect(a.peer.frames()).toEqual([1, 2])
    expect(b.peer.frames()).toEqual([1, 2])
    expect(encoder.named('invalidate')).toEqual([[3], [4]])
  })

  it("drops delta frames that overflow a client's window, and always sends to an idle client", () => {
    const { encoder, session, join } = setup()
    const busy = join('view')
    session.handle(frame(1, -1, true))
    busy.ack(1)
    session.handle(frame(2, 1, false, 200 * KiB))
    session.handle(frame(3, 2, false, 100 * KiB))
    expect(busy.peer.frames()).toEqual([1, 2])
    expect(encoder.named('invalidate')).toEqual([[3]])
    busy.ack(2)
    session.handle(frame(4, 2, false, 300 * KiB))
    expect(busy.peer.frames()).toEqual([1, 2, 4])
  })

  it('predicts past a dropped frame', () => {
    const { session, join } = setup()
    const client = join('view')
    session.handle(frame(10, -1, true))
    client.ack(10)
    session.handle(frame(11, 10, false, 250 * KiB))
    session.handle(frame(12, 11, false, 10 * KiB))
    client.ack(11)
    session.handle(frame(13, 12))
    session.handle(frame(14, 11))
    expect(client.peer.frames()).toEqual([10, 11, 14])
  })

  it('always sends key frames, outside the window, and never invalidates them', () => {
    const { encoder, session, join } = setup()
    const client = join('view')
    session.handle(frame(1, -1, true, 300 * KiB))
    // Behind key frames, delta frames still get the whole window.
    session.handle(frame(2, 1, false, 200 * KiB))
    session.handle(frame(3, -1, true, 300 * KiB))
    session.handle(frame(4, 3, false, 50 * KiB))
    session.handle(frame(5, 4, false, 10 * KiB))
    expect(client.peer.frames()).toEqual([1, 2, 3, 4])
    expect(encoder.named('invalidate')).toEqual([[5]])
    expect(session.stats().clients[0].inFlight).toBe(850 * KiB)
  })

  it('leaves the window alone for round trips that a key frame delays', () => {
    const { clock, session, join } = setup()
    const client = join('view')
    const window = () => session.stats().clients[0].window
    // A narrow link: the key frame takes a second to cross, and the delta frame behind it waits as long.
    session.handle(frame(1, -1, true, 150 * KiB))
    session.handle(frame(2, 1, false, KiB))
    clock.advance(1_100)
    client.ack(1)
    client.ack(2)
    expect(window()).toBe(256 * KiB)
    // Delta frames on their own measure the link: 300 ms, then 500 ms behind a queue, which shrinks the window.
    session.handle(frame(3, 2, false, KiB))
    clock.advance(300)
    client.ack(3)
    expect(window()).toBe(256 * KiB + 256)
    session.handle(frame(4, 3, false, KiB))
    clock.advance(500)
    client.ack(4)
    expect(window()).toBe(Math.floor((256 * KiB + 256) * 0.7))
  })

  it('paints over only while a key frame crosses every link quickly', () => {
    const { clock, encoder, session, join } = setup()
    const tunes = () => encoder.named('tune').map(([tuning]) => tuning)
    const client = join('control')
    let id = 0
    // A key frame acknowledged after `rtt`, then a small delta frame after the link's base round trip.
    const measure = (rtt: number, base: number) => {
      session.handle(frame(++id, -1, true, 150 * KiB))
      clock.advance(rtt)
      client.ack(id)
      session.handle(frame(++id, id - 1))
      clock.advance(base)
      client.ack(id)
      clock.advance(500)
    }
    // 1.5 Mbit/s: the key frame holds the link for 800 ms.
    measure(1_100, 300)
    expect(session.stats().paintover).toBe(false)
    expect(tunes()).toEqual([tuned(1)])
    // 10 Mbit/s: 130 ms.
    measure(430, 300)
    expect(session.stats().paintover).toBe(true)
    expect(tunes()).toEqual([tuned(1), tuned(1, true)])
    expect(clock.logs.at(-1)).toMatch(/paint-over on: .* about 130 ms/)
    // Between the two thresholds it stays on; above them it turns off.
    measure(480, 300)
    expect(tunes()).toHaveLength(2)
    measure(550, 300)
    expect(tunes()).toEqual([tuned(1), tuned(1, true), tuned(1)])
    // A client that has not measured its link yet turns it off as well.
    measure(430, 300)
    expect(session.stats().paintover).toBe(true)
    join('view')
    clock.advance(500)
    expect(session.stats().paintover).toBe(false)
    expect(clock.logs.at(-1)).toMatch(/until every client has measured/)
  })

  it('waits for the paint-over before asking for a catch-up key frame', () => {
    const { clock, encoder, session, join } = setup()
    const client = join('view')
    session.handle(frame(1, -1, true, 150 * KiB))
    clock.advance(40)
    client.ack(1)
    session.handle(frame(2, 1))
    clock.advance(10)
    client.ack(2)
    clock.advance(2_000)
    expect(session.stats().paintover).toBe(true)
    const asked = () => encoder.named('keyframe').length
    const start = asked()
    session.handle(frame(3, 99))
    // At 30 fps the paint-over comes 333 ms after the last frame: the session gives it 250 ms more.
    clock.advance(500)
    expect(asked()).toBe(start)
    clock.advance(200)
    expect(asked()).toBe(start + 1)
  })

  it('adapts the window from round trips', () => {
    const { clock, session, join } = setup()
    const client = join('view')
    const window = () => session.stats().clients[0].window
    expect(window()).toBe(256 * KiB)
    session.handle(frame(1, -1, true))
    client.ack(1)
    let id = 1
    const roundTrip = (size: number, rtt: number) => {
      session.handle(frame(++id, id - 1, false, size))
      clock.advance(rtt)
      client.ack(id)
    }
    for (let i = 0; i < 3; i++) roundTrip(40_000, 50)
    expect(window()).toBe(256 * KiB + 3 * 10_000)
    for (let i = 0; i < 20; i++) roundTrip(1024 * KiB, 50)
    expect(window()).toBe(4 * 1024 * KiB)

    roundTrip(1_000, 200)
    expect(window()).toBe(Math.floor(4 * 1024 * KiB * 0.7))
    // A second late frame within the minimum round trip of the first does not shrink it again.
    const before = window()
    session.handle(frame(++id, id - 1, false, 1_000))
    session.handle(frame(++id, id - 1, false, 1_000))
    clock.advance(200)
    client.ack(id - 1)
    clock.advance(10)
    client.ack(id)
    expect(window()).toBe(Math.floor(before * 0.7))

    for (let i = 0; i < 20; i++) {
      clock.advance(100)
      roundTrip(1_000, 300)
    }
    expect(window()).toBe(64 * KiB)

    client.ack(999_999)
    expect(window()).toBe(64 * KiB)

    session.handle(frame(++id, id - 1))
    session.handle(frame(++id, id - 1))
    session.handle(frame(++id, id - 1))
    expect(session.stats().clients[0].inFlight).toBe(30)
    client.ack(id)
    expect(session.stats().clients[0].inFlight).toBe(0)
  })

  it('asks for a catch-up key frame on a still screen, at most once a second', () => {
    const { clock, encoder, session, join } = setup()
    const client = join('view')
    session.handle(frame(1, -1, true))
    client.ack(1)
    clock.advance(2_000)
    const asked = () => encoder.named('keyframe').length
    const start = asked()
    session.handle(frame(2, 99))
    clock.advance(200)
    expect(asked()).toBe(start)
    clock.advance(200)
    expect(asked()).toBe(start + 1)
    session.handle(frame(3, 99))
    clock.advance(800)
    expect(asked()).toBe(start + 1)
    clock.advance(400)
    expect(asked()).toBe(start + 2)
  })

  it('steps the ladder', () => {
    const { clock, encoder, session, join } = setup()
    const client = join('view')
    let id = 0
    let last: number | null = null
    // Good frames predict from the last good one; bad ones from a frame the client never got.
    const good = () => {
      session.handle(frame(++id, last ?? -1, last === null))
      client.ack(id)
      last = id
    }
    const bad = () => session.handle(frame(++id, 999_999))
    const tunes = () => encoder.named('tune').map(([tuning]) => tuning)
    clock.advance(1_600)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 7; j++) good()
      for (let j = 0; j < 3; j++) bad()
      clock.advance(100)
    }
    expect(tunes()).toEqual([tuned(1), tuned(2)])
    const changedAt = clock.now
    // Drops keep coming, but a level holds for 2 s.
    while (clock.now < changedAt + 1_900) {
      good()
      bad()
      clock.advance(100)
    }
    expect(tunes()).toHaveLength(2)

    // Clean frames: once the drops leave the window and 60 frames and 5 s passed without one, it climbs back.
    clock.advance(2_100)
    const quiet = clock.now
    expect(tunes()).toEqual([tuned(1), tuned(2), tuned(3)])
    for (let i = 0; i < 40; i++) {
      good()
      clock.advance(100)
    }
    expect(clock.now - quiet).toBeLessThan(5_000)
    expect(tunes()).toHaveLength(3)
    for (let i = 0; i < 30; i++) {
      good()
      clock.advance(100)
    }
    expect(tunes()).toEqual([tuned(1), tuned(2), tuned(3), tuned(2)])
    expect(session.stats().level).toBe(2)

    // A still screen measures nothing, so it never climbs.
    clock.advance(30_000)
    expect(tunes()).toHaveLength(4)
  })

  it('forwards input only from the controller', () => {
    const { clock, encoder, session, join } = setup()
    const input = [
      encodePointerInput(10, 20, 1),
      encodeWheel(0, 2),
      encodeKey(0x61, true),
      encodeClipboardInput('ação'),
    ]
    const viewer = join('view')
    for (const message of input) viewer.handle.receive(message)
    expect(encoder.calls.filter(([name]) => ['pointer', 'wheel', 'key', 'clipboard'].includes(name))).toEqual([])
    const controller = join('control')
    session.handle(frame(1, -1, true))
    viewer.ack(1)
    controller.ack(1)
    controller.handle.receive(Uint8Array.from(Buffer.concat(input.map((message) => Buffer.from(message)))))
    expect(encoder.calls.filter(([name]) => ['pointer', 'wheel', 'key', 'clipboard'].includes(name))).toEqual([
      ['pointer', 10, 20, 1],
      ['wheel', 0, 2],
      ['key', 0x61, true],
      ['clipboard', 'ação'],
    ])
    clock.advance(1_000)
    const keyframes = encoder.named('keyframe').length
    viewer.handle.receive(encodeKeyframeRequest())
    expect(encoder.named('keyframe')).toHaveLength(keyframes + 1)
    expect(viewer.peer.closed).toBe(false)
  })

  it('routes clipboard to controllers and pointer to viewers, and keeps watch flags', () => {
    const { encoder, session, join } = setup()
    const viewer = join('view')
    expect(encoder.named('watch')).toEqual([[{ pointer: true, clipboard: false }]])
    const controller = join('control')
    expect(encoder.named('watch').at(-1)).toEqual([{ pointer: true, clipboard: true }])
    session.handle({ type: 'pointer', x: 5, y: 6 })
    session.handle({ type: 'clipboard', tooLarge: false, text: 'copiado' })
    session.handle({ type: 'clipboard', tooLarge: true, text: '' })
    const kinds = (peer: FakePeer) => peer.events.filter((event) => event.type !== 'hello')
    expect(kinds(viewer.peer)).toEqual([{ type: 'pointer', x: 5, y: 6 }])
    expect(kinds(controller.peer)).toEqual([
      { type: 'clipboard', tooLarge: false, text: 'copiado' },
      { type: 'clipboard', tooLarge: true, text: '' },
    ])
    viewer.handle.detach()
    expect(encoder.named('watch').at(-1)).toEqual([{ pointer: false, clipboard: true }])
    expect(encoder.named('release')).toEqual([])
    controller.handle.detach()
    expect(encoder.named('release')).toEqual([[]])
    expect(encoder.named('watch').at(-1)).toEqual([{ pointer: false, clipboard: false }])
    expect(session.clientCount).toBe(0)
  })

  it('closes only the client that breaks the protocol', () => {
    const { clock, session, join } = setup()
    const broken = join('control')
    const other = join('view')
    broken.handle.receive(encodeScreenMessage(0x7f))
    expect(broken.peer.closed).toBe(true)
    expect(clock.logs.some((line) => line.includes('invalid message'))).toBe(true)
    session.handle(frame(1, -1, true))
    expect(other.peer.frames()).toEqual([1])
    expect(broken.peer.frames()).toEqual([])
    expect(session.clientCount).toBe(1)
  })

  it('closes a client that stops acknowledging for 10 s', () => {
    const { clock, session, join } = setup()
    const silent = join('view')
    const live = join('view')
    session.handle(frame(1, -1, true))
    live.ack(1)
    clock.advance(9_900)
    expect(silent.peer.closed).toBe(false)
    clock.advance(300)
    expect(silent.peer.closed).toBe(true)
    expect(live.peer.closed).toBe(false)
  })

  it('close() ends every client, and a client joining afterwards is closed at once', () => {
    const { session, join } = setup()
    const a = join('view')
    const b = join('control')
    session.close()
    expect([a.peer.closed, b.peer.closed]).toEqual([true, true])
    const late = join('view')
    expect(late.peer.closed).toBe(true)
    expect(late.peer.events).toEqual([])
  })

  it('logs each change of quality level', () => {
    const { clock, session, join } = setup()
    const client = join('view')
    clock.advance(1_600)
    let id = 0
    let last: number | null = null
    for (let i = 0; i < 10; i++) {
      session.handle(frame(++id, last ?? -1, last === null))
      client.ack(id)
      last = id
      session.handle(frame(++id, 999_999))
    }
    clock.advance(500)
    expect(clock.logs.some((line) => /quality level 2/.test(line))).toBe(true)
  })
})
