import {
  FLEET_SCREEN_CLOSE_CODES,
  ScreenMessageReader,
  decodeClientMessage,
  encodeFrame,
  encodeHello,
  encodePointer,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { GatewayError, type GatewayClient } from '../src/gateway/client'
import { base64Of } from '../src/screen/base64'
import { SCREEN_KEYS, keysymOf, textKeysyms } from '../src/screen/keysyms'
import { screenOutcome, socketScreenOpener, type ScreenLinkEvent, type ScreenSocket } from '../src/screen/link'
import {
  SCREEN_DECODER_SOURCE,
  SCREEN_PAGE_CSP,
  SCREEN_VIEWPORT_SOURCE,
  parseScreenPageMessage,
  screenPageDocument,
} from '../src/screen/screen-page'

const KEY = Uint8Array.of(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 1, 0, 0, 1, 0x65, 9)

describe('screen keys', () => {
  it('types Latin-1 as itself, other characters as Unicode keysyms, and line breaks as Return', () => {
    expect(textKeysyms('Aé 1')).toEqual([0x41, 0xe9, 0x20, 0x31])
    expect(textKeysyms('€😀')).toEqual([0x0100_0000 + 0x20ac, 0x0100_0000 + 0x1f600])
    expect(textKeysyms('a\r\nb\tc')).toEqual([0x61, SCREEN_KEYS.Return, 0x62, SCREEN_KEYS.Tab, 0x63])
  })
  it('skips control characters it cannot type', () => {
    expect(keysymOf(0x07)).toBeNull()
    expect(keysymOf(0x7f)).toBeNull()
    expect(keysymOf(0x9f)).toBeNull()
    expect(keysymOf(0xd800)).toBeNull()
    expect(textKeysyms('a\u0007b')).toEqual([0x61, 0x62])
  })
})

describe('screen frames as base64', () => {
  it('matches Buffer for every remainder and for frames past a chunk', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6200, 6201, 6202]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255)
      expect(base64Of(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})

class FakeSocket implements ScreenSocket {
  binaryType = 'blob'
  readyState = 1
  onmessage: ScreenSocket['onmessage'] = null
  onerror: ScreenSocket['onerror'] = null
  onclose: ScreenSocket['onclose'] = null
  sent: Uint8Array[] = []
  closed = false
  send(data: Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  receive(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer })
  }
  messages() {
    const reader = new ScreenMessageReader(1024 * 1024)
    return this.sent.flatMap((bytes) => reader.push(bytes)).map(decodeClientMessage)
  }
}

function opener(ticket: () => Promise<unknown> = async () => ({ path: '/v1/screen?ticket=abc_1' })) {
  const sockets: Array<{ url: string; origin: string; socket: FakeSocket }> = []
  const call = vi.fn(ticket) as unknown as GatewayClient['call'] & ReturnType<typeof vi.fn>
  const open = socketScreenOpener({
    origin: 'https://Bots.Example.dev',
    call,
    createSocket: (url, origin) => {
      const socket = new FakeSocket()
      sockets.push({ url, origin, socket })
      return socket
    },
  })
  const events: ScreenLinkEvent[] = []
  return { open, call, sockets, events, onEvent: (event: ScreenLinkEvent) => void events.push(event) }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a bot screen over the gateway', () => {
  it('asks for a ticket that names the phone’s Origin, then connects with it', async () => {
    const { open, call, sockets, onEvent } = opener()
    open({ botId: 'juno', mode: 'control', surface: 'apps' }, onEvent)
    await settle()
    expect(call).toHaveBeenCalledWith('botScreenTicket', {
      params: { id: 'juno' },
      body: { mode: 'control', surface: 'apps', origin: 'https://bots.example.dev' },
    })
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('wss://Bots.Example.dev/v1/screen?ticket=abc_1')
    expect(sockets[0].origin).toBe('https://bots.example.dev')
    expect(sockets[0].socket.binaryType).toBe('arraybuffer')
  })

  it('reports the screen and its frames, and sends input and acknowledgements', async () => {
    const { open, sockets, events, onEvent } = opener()
    const link = open({ botId: 'juno', mode: 'control', surface: 'apps' }, onEvent)
    await settle()
    const socket = sockets[0].socket
    socket.receive(encodeHello({ version: 1, width: 1280, height: 800, mode: 'control' }))
    socket.receive(encodePointer(640, 441))
    socket.receive(encodeFrame(7, true, KEY))
    expect(events.map((event) => event.type)).toEqual(['open', 'pointer', 'frame'])
    expect(events[0]).toEqual({ type: 'open', width: 1280, height: 800 })
    expect(events[2]).toMatchObject({ type: 'frame', id: 7, key: true, codec: 'avc1.640028' })
    link.pointer(10.4, 20.6, 1)
    link.wheel(0, 2)
    link.key(SCREEN_KEYS.Return, true)
    link.decoded(7)
    expect(socket.messages()).toEqual(
      expect.arrayContaining([
        { type: 'pointer', x: 10, y: 21, buttons: 1 },
        { type: 'wheel', dx: 0, dy: 2 },
        { type: 'key', keysym: SCREEN_KEYS.Return, down: true },
        { type: 'ack', id: 7 },
      ])
    )
  })

  it('ends once, with the close that says why, and not at all once closed', async () => {
    const first = opener()
    first.open({ botId: 'juno', mode: 'view', surface: 'apps' }, first.onEvent)
    await settle()
    first.sockets[0].socket.onclose?.({ code: FLEET_SCREEN_CLOSE_CODES.botOffline, reason: 'offline' })
    expect(first.events).toEqual([
      { type: 'end', end: { code: FLEET_SCREEN_CLOSE_CODES.botOffline, reason: 'offline' } },
    ])

    const second = opener()
    const link = second.open({ botId: 'juno', mode: 'view', surface: 'apps' }, second.onEvent)
    await settle()
    link.close()
    expect(second.sockets[0].socket.closed).toBe(true)
    second.sockets[0].socket.onclose?.({ code: 1000 })
    expect(second.events).toEqual([])
  })

  it('opens no socket for a screen closed while its ticket was on the way, or for a ticket it does not expect', async () => {
    const early = opener()
    early.open({ botId: 'juno', mode: 'view', surface: 'apps' }, early.onEvent).close()
    await settle()
    expect(early.sockets).toEqual([])
    expect(early.events).toEqual([])

    const odd = opener(async () => ({ path: '/v1/screen?ticket=a&next=//elsewhere' }))
    odd.open({ botId: 'juno', mode: 'view', surface: 'apps' }, odd.onEvent)
    await settle()
    expect(odd.sockets).toEqual([])
    expect(odd.events).toMatchObject([{ type: 'end', end: { error: expect.any(Error) } }])
  })

  it('tells the view what an ended screen means', () => {
    const closed = (code: number, reason = '') => ({ code, reason })
    const refused = (code: GatewayError['code'], message = '') => ({ error: new GatewayError(code, 409, message) })
    expect(screenOutcome(closed(FLEET_SCREEN_CLOSE_CODES.released), 'control')).toBe('released')
    expect(screenOutcome(closed(FLEET_SCREEN_CLOSE_CODES.botOffline), 'view')).toBe('offline')
    expect(screenOutcome(closed(FLEET_SCREEN_CLOSE_CODES.ticketInvalid), 'view')).toBe('retry')
    expect(screenOutcome(closed(FLEET_SCREEN_CLOSE_CODES.ticketInvalid, 'limit'), 'control')).toBe('conflict')
    expect(screenOutcome(closed(1006), 'view')).toBe('error')
    expect(screenOutcome(refused('FORBIDDEN'), 'control')).toBe('lost')
    expect(screenOutcome(refused('BOT_NOT_RUNNING'), 'view')).toBe('offline')
    expect(
      screenOutcome(refused('CONFLICT', 'Restart this environment to update it before opening this screen.'), 'view')
    ).toBe('restart')
    expect(screenOutcome(refused('CONFLICT', 'Screen control limit reached'), 'control')).toBe('conflict')
    expect(screenOutcome({ error: new Error('offline') }, 'view')).toBe('error')
  })
})

describe('the screen’s page', () => {
  it('reads only the messages it sends, within their bounds', () => {
    expect(parseScreenPageMessage({ t: 'tap', x: 12, y: 30 })).toEqual({ t: 'tap', x: 12, y: 30 })
    expect(parseScreenPageMessage('{"t":"ready","video":true}')).toEqual({ t: 'ready', video: true })
    expect(parseScreenPageMessage({ t: 'scroll', x: 1, y: 2, dx: 0, dy: -3 })).toEqual({
      t: 'scroll',
      x: 1,
      y: 2,
      dx: 0,
      dy: -3,
    })
    expect(parseScreenPageMessage({ t: 'fatal', reason: 'unsupported' })).toEqual({ t: 'fatal', reason: 'unsupported' })
    for (const bad of [
      null,
      'not json',
      { t: 'tap', x: -1, y: 0 },
      { t: 'tap', x: 1.5, y: 0 },
      { t: 'scroll', x: 0, y: 0, dx: 0, dy: 99 },
      { t: 'decoded', id: '3' },
      { t: 'fatal', reason: 'other' },
      { t: 'navigate', url: 'https://example.com' },
    ])
      expect(parseScreenPageMessage(bad)).toBeNull()
  })

  type View = { s: number; tx: number; ty: number }
  type Size = { w: number; h: number }
  const geometry = new Function(
    `${SCREEN_VIEWPORT_SOURCE}; return { fitView, clampView, rectView, zoomAround, centerOn, stopRect, remotePoint };`
  )() as {
    fitView(port: Size, size: Size): View
    clampView(view: View, port: Size, size: Size): View
    rectView(rect: Size & { x: number; y: number }, port: Size, size: Size): View
    zoomAround(view: View, point: { x: number; y: number }, s: number, port: Size, size: Size): View
    stopRect(point: { x: number; y: number }, size: Size): Size & { x: number; y: number }
    remotePoint(view: View, point: { x: number; y: number }): { x: number; y: number }
  }
  const port = { w: 390, h: 614 }
  const size = { w: 1280, h: 800 }

  it('fits the whole screen, centered, and keeps a zoomed one covering the port', () => {
    const fit = geometry.fitView(port, size)
    expect(fit.s).toBeCloseTo(390 / 1280)
    expect(fit.tx).toBe(0)
    expect(fit.ty).toBeCloseTo((614 - 800 * fit.s) / 2)
    // No zooming out past the whole screen, nor in past 2.5×; a zoomed screen cannot leave a gap at an edge.
    expect(geometry.clampView({ s: 0.01, tx: 50, ty: 50 }, port, size)).toEqual(fit)
    expect(geometry.clampView({ s: 9, tx: 0, ty: 0 }, port, size).s).toBe(2.5)
    const zoomed = geometry.clampView({ s: 1, tx: 100, ty: -5000 }, port, size)
    expect(zoomed).toEqual({ s: 1, tx: 0, ty: 614 - 800 })
  })

  it('frames where the bot stopped with room around it, and maps a tap back to the screen', () => {
    const rect = geometry.stopRect({ x: 640, y: 441 }, size)
    expect(rect).toEqual({ x: 460, y: 328.5, w: 360, h: 225 })
    // Near an edge the rect stays on the screen.
    expect(geometry.stopRect({ x: 5, y: 790 }, size)).toEqual({ x: 0, y: 575, w: 360, h: 225 })
    const view = geometry.rectView(rect, port, size)
    expect(view.s).toBeCloseTo(390 / (360 * 1.2))
    const middle = geometry.remotePoint(view, { x: port.w / 2, y: port.h / 2 })
    expect(middle.x).toBeCloseTo(640)
    expect(middle.y).toBeCloseTo(441)
    // Zooming around a point keeps the screen's pixel under it in place.
    const before = geometry.remotePoint(view, { x: 100, y: 200 })
    const after = geometry.remotePoint(geometry.zoomAround(view, { x: 100, y: 200 }, 1.6, port, size), {
      x: 100,
      y: 200,
    })
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  /** The page's decoder over a fake WebCodecs: each decoder either draws what it is given or fails. */
  function decoderWith(behavior: { failConfigure?: boolean; failDecode?: boolean } = {}) {
    const decoders: Array<{ config: unknown; closed: boolean }> = []
    class FakeChunk {
      constructor(readonly init: { type: string; timestamp: number }) {}
    }
    class FakeDecoder {
      state = 'configured'
      record = { config: null as unknown, closed: false }
      constructor(private readonly init: { output(picture: unknown): void; error(): void }) {
        decoders.push(this.record)
      }
      configure(config: unknown) {
        if (behavior.failConfigure) throw new Error('unsupported codec')
        this.record.config = config
      }
      decode(chunk: FakeChunk) {
        if (behavior.failDecode) return queueMicrotask(() => this.init.error())
        queueMicrotask(() => this.init.output({ timestamp: chunk.init.timestamp, close() {} }))
      }
      close() {
        this.state = 'closed'
        this.record.closed = true
      }
    }
    const calls: unknown[][] = []
    const create = new Function('VideoDecoder', 'EncodedVideoChunk', `${SCREEN_DECODER_SOURCE}; return createDecoder;`)(
      FakeDecoder,
      FakeChunk
    ) as (sink: Record<string, (...args: unknown[]) => void>) => {
      decode(frame: { id: number; key: boolean; codec: string; data: Uint8Array }): void
      restart(): void
      close(): void
    }
    const decoder = create({
      decoded: (id) => void calls.push(['decoded', id]),
      failed: () => void calls.push(['failed']),
      fatal: (reason) => void calls.push(['fatal', reason]),
      picture: (picture) => void calls.push(['picture', (picture as { timestamp: number }).timestamp]),
    })
    return { decoder, decoders, calls }
  }
  const frame = (id: number, key = true) => ({ id, key, codec: 'avc1.640028', data: KEY })

  it('decodes with low latency, draws each picture, then acknowledges it', async () => {
    const { decoder, decoders, calls } = decoderWith()
    decoder.decode(frame(1))
    decoder.decode(frame(2, false))
    await settle()
    expect(decoders).toHaveLength(1)
    expect(decoders[0].config).toEqual({ codec: 'avc1.640028', optimizeForLatency: true })
    expect(calls).toEqual([
      ['picture', 1],
      ['decoded', 1],
      ['picture', 2],
      ['decoded', 2],
    ])
  })

  it('acknowledges what a failed decoder held, asks for a key frame, and gives up after repeated failures', async () => {
    const { decoder, decoders, calls } = decoderWith({ failDecode: true })
    decoder.decode(frame(1))
    await settle()
    expect(calls).toEqual([['decoded', 1], ['failed']])
    expect(decoders[0].closed).toBe(true)
    for (let id = 2; id <= 5; id++) {
      decoder.decode(frame(id))
      await settle()
    }
    expect(calls.at(-1)).toEqual(['fatal', 'decoder'])
  })

  it('says when the phone has no video decoder', () => {
    const calls: unknown[][] = []
    const create = new Function('VideoDecoder', 'EncodedVideoChunk', `${SCREEN_DECODER_SOURCE}; return createDecoder;`)(
      undefined,
      undefined
    )
    create({
      decoded: (id: number) => calls.push(['decoded', id]),
      failed: () => calls.push(['failed']),
      fatal: (reason: string) => calls.push(['fatal', reason]),
      picture: () => undefined,
    }).decode(frame(4))
    expect(calls).toEqual([
      ['decoded', 4],
      ['fatal', 'unsupported'],
    ])
  })

  it('is one self-contained document under a policy that loads nothing', () => {
    const theme = { base: '#1b1d1b', ink: '#e7e4dc', muted: '#888', cue: '#f2bd52', onCue: '#1f201e' }
    for (const transport of ['react-native', 'parent'] as const) {
      const html = screenPageDocument(transport, theme, { width: 1280, height: 800 })
      expect(html).toContain(`content="${SCREEN_PAGE_CSP}"`)
      expect(html).toContain('<canvas id="screen" width="1280" height="800">')
      // The script holds only code of ours: nothing in it can end its element early.
      expect(html.match(/<\/script/gi)).toHaveLength(1)
      expect(html).toContain('--cue:#f2bd52')
    }
    expect(SCREEN_PAGE_CSP).toMatch(/default-src 'none'/)
    expect(SCREEN_PAGE_CSP).not.toMatch(/connect-src|https?:/)
    // A theme value that could leave its declaration is left out.
    const unsafe = screenPageDocument(
      'parent',
      { ...theme, cue: 'red;}</style><script>alert(1)</script>' },
      {
        width: 1280,
        height: 800,
      }
    )
    expect(unsafe).not.toContain('alert(1)')
    expect(unsafe).not.toContain('--cue:')
  })
})
