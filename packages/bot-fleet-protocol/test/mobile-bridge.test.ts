import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  MOBILE_CHANNELS,
  MobileBridgeClient,
  MobileBridgeError,
  decodeMobileValue,
  encodeMobileValue,
  fleetBridgeOrigin,
  mobileChatItemSchema,
  type MobileBridgeSocket,
  type MobileBridgeState,
  type MobileEvent,
} from '../src/index.js'

describe('bridge origins', () => {
  it('writes the Origin a WebSocket client sends for an address', () => {
    expect(fleetBridgeOrigin('https://Bots.Example.dev')).toBe('https://bots.example.dev')
    expect(fleetBridgeOrigin('wss://bots.example.dev:443')).toBe('https://bots.example.dev')
    expect(fleetBridgeOrigin('ws://127.0.0.1:7443')).toBe('http://127.0.0.1:7443')
    expect(fleetBridgeOrigin('http://localhost:80/')).toBe('http://localhost')
    for (const bad of ['ftp://x.dev', 'https://u:p@x.dev', 'https://x.dev/path', 'https://x.dev?q=1', 'nope'])
      expect(fleetBridgeOrigin(bad)).toBeNull()
  })
  it('accepts a normalized origin in a ticket request, and none', () => {
    const body = FLEET_GATEWAY_ROUTES.environmentBridgeTicket.body
    expect(body.parse({})).toEqual({})
    expect(body.parse({ origin: 'https://bots.example.dev' })).toEqual({ origin: 'https://bots.example.dev' })
    expect(() => body.parse({ origin: 'https://bots.example.dev/' })).toThrow()
    expect(() => body.parse({ origin: 'https://Bots.example.dev' })).toThrow()
    expect(() => body.parse({ extra: 1 })).toThrow()
  })
})

describe('mobile chat items', () => {
  it('are transcript items or dispatch cards', () => {
    expect(
      mobileChatItemSchema.parse({ kind: 'assistant', id: 'a', at: '2026-10-13T12:00:00.000Z', text: 'Hi', streaming: false })
    ).toMatchObject({ kind: 'assistant' })
    expect(
      mobileChatItemSchema.parse({
        kind: 'dispatch',
        id: 'd',
        at: '2026-10-13T12:00:00.000Z',
        state: 'done',
        conversations: [
          { conversationId: 'c1', title: 'Push', status: 'started', workspaceName: 'maestrly', error: null },
        ],
      })
    ).toMatchObject({ kind: 'dispatch' })
  })
})

describe('bridge values', () => {
  it('round-trips undefined array entries and objects that use reserved keys', () => {
    const value = { list: [1, undefined, 3], tricky: { $undef: 1, other: 'x' }, skip: undefined }
    const encoded = JSON.parse(JSON.stringify(encodeMobileValue(value)))
    expect(encoded).toEqual({ list: [1, { $undef: 1 }, 3], tricky: { $esc: { $undef: 1, other: 'x' } } })
    expect(decodeMobileValue(encoded)).toEqual({ list: [1, undefined, 3], tricky: { $undef: 1, other: 'x' } })
  })
})

class FakeSocket implements MobileBridgeSocket {
  sent: Array<Record<string, unknown>> = []
  closed: number | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    if (this.closed !== null) return
    this.closed = code
  }
  /** The host closes the socket. */
  drop(code: number) {
    this.closed = code
    this.onclose?.({ code })
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function harness(connect?: () => Promise<MobileBridgeSocket>) {
  const sockets: FakeSocket[] = []
  const states: Array<[MobileBridgeState, unknown]> = []
  const events: MobileEvent[] = []
  let ready = 0
  const client = new MobileBridgeClient({
    connect:
      connect ??
      (async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      }),
    appVersion: '0.16.0',
    client: { deviceName: 'iPhone', os: 'ios', locale: 'pt-BR' },
    onEvent: (event) => events.push(event),
    onState: (state, detail) => states.push([state, detail]),
    onReady: () => ready++,
    random: () => 0.5,
  })
  const welcome = async (socket: FakeSocket) => {
    socket.onopen?.()
    socket.receive({ t: 'welcome', protocol: 1, appVersion: '0.16.0', mobileApi: 1 })
    await Promise.resolve()
  }
  return { client, sockets, states, events, welcome, ready: () => ready }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('mobile bridge client', () => {
  it('says hello as a phone, opens one origin and carries calls and events', async () => {
    const h = harness()
    h.client.start()
    await flush()
    const socket = h.sockets[0]
    socket.onopen?.()
    expect(socket.sent[0]).toEqual({
      t: 'hello',
      protocol: 1,
      appVersion: '0.16.0',
      client: { deviceName: 'iPhone', os: 'ios', locale: 'pt-BR', kind: 'mobile', mobileApi: 1 },
    })
    await expect(h.client.invoke('lists', {})).rejects.toMatchObject({ code: 'DISCONNECTED', retryable: true })
    socket.receive({ t: 'welcome', protocol: 1, appVersion: '0.16.0', mobileApi: 1 })
    expect(socket.sent[1]).toEqual({ t: 'open', origin: 1, role: 'main' })
    expect(h.states.at(-1)?.[0]).toBe('open')
    expect(h.ready()).toBe(1)

    const lists = h.client.invoke('lists', {})
    expect(socket.sent[2]).toEqual({ t: 'invoke', id: 1, origin: 1, channel: 'mobile:v1:lists', args: [{}] })
    socket.receive({ t: 'result', id: 1, ok: true, value: { workspaces: [], chats: [] } })
    await expect(lists).resolves.toEqual({ workspaces: [], chats: [] })

    const failing = h.client.invoke('stop', { conversationId: 'c1' })
    socket.receive({ t: 'result', id: 2, ok: false, error: { message: 'Unknown conversation', code: 'not-found' } })
    await expect(failing).rejects.toMatchObject({ code: 'not-found', message: 'Unknown conversation' })

    socket.receive({ t: 'event', origin: 1, channel: 'mobile:v1:status', args: [{ conversationId: 'c1', status: 'working' }] })
    socket.receive({ t: 'event', origin: 1, channel: 'mobile:v1:unknown', args: [{}] })
    socket.receive({ t: 'event', origin: 1, channel: 'mobile:v1:status', args: [{ conversationId: 'c1', status: 'odd' }] })
    expect(h.events).toEqual([{ key: 'status', payload: { conversationId: 'c1', status: 'working' } }])

    socket.receive({ t: 'ping', n: 7 })
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', n: 7 })
    h.client.stop()
  })

  it('validates arguments before sending, and times out a call nobody answers', async () => {
    const h = harness()
    h.client.start()
    await flush()
    await h.welcome(h.sockets[0])
    await expect(h.client.invoke('send', { conversationId: 'c1', text: 'hi', attachments: [], clientId: 'nope' })).rejects.toMatchObject({
      code: 'INVALID',
    })
    const slow = h.client.invoke('lists', {}, 1000)
    vi.advanceTimersByTime(1000)
    await expect(slow).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    h.client.stop()
  })

  it('reconnects with backoff when the socket drops, failing calls in flight', async () => {
    const h = harness()
    h.client.start()
    await flush()
    await h.welcome(h.sockets[0])
    const inFlight = h.client.invoke('lists', {})
    h.sockets[0].drop(1006)
    await expect(inFlight).rejects.toMatchObject({ code: 'DISCONNECTED', retryable: true })
    expect(h.states.at(-1)).toEqual(['retrying', { retryInMs: 1000 }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.sockets).toHaveLength(2)
    await h.welcome(h.sockets[1])
    expect(h.ready()).toBe(2)
    h.client.stop()
    expect(h.states.at(-1)?.[0]).toBe('closed')
  })

  it('reconnects when the host goes silent', async () => {
    const h = harness()
    h.client.start()
    await flush()
    await h.welcome(h.sockets[0])
    vi.advanceTimersByTime(45_000)
    expect(h.sockets[0].closed).toBe(4001)
    h.client.stop()
  })

  it('stops for good when the host predates phones, refuses the app or the phone was removed', async () => {
    const old = harness()
    old.client.start()
    await flush()
    old.sockets[0].onopen?.()
    old.sockets[0].drop(4002)
    expect(old.states.at(-1)?.[0]).toBe('unsupported')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(old.sockets).toHaveLength(1)

    const refused = harness()
    refused.client.start()
    await flush()
    refused.sockets[0].onopen?.()
    refused.sockets[0].receive({ t: 'refused', reason: 'mobile-api', hostVersion: '0.15.0' })
    expect(refused.states.at(-1)).toEqual(['refused', { hostVersion: '0.15.0' }])

    const newer = harness()
    newer.client.start()
    await flush()
    newer.sockets[0].onopen?.()
    newer.sockets[0].receive({ t: 'welcome', protocol: 1, appVersion: '0.17.0', mobileApi: 2 })
    expect(newer.states.at(-1)?.[0]).toBe('unsupported')

    const removed = harness(async () => {
      throw new MobileBridgeError('UNAUTHORIZED', 'Device token required')
    })
    removed.client.start()
    await flush()
    expect(removed.states.at(-1)?.[0]).toBe('unauthorized')
  })

  it('keeps trying while the server has no workspaces host, and tries at once when asked', async () => {
    let attempts = 0
    const h = harness(async () => {
      attempts++
      throw new MobileBridgeError('UNAVAILABLE', 'No workspaces host')
    })
    h.client.start()
    await flush()
    expect(h.states.at(-1)).toEqual(['unavailable', { retryInMs: 1000 }])
    h.client.reconnectNow()
    await flush()
    expect(attempts).toBe(2)
    h.client.stop()
  })

  it('names every channel once', () => {
    const channels = Object.values(MOBILE_CHANNELS).map((spec) => spec.channel)
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels.every((channel) => channel.startsWith('mobile:v1:'))).toBe(true)
  })
})
