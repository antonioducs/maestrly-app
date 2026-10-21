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
  mobileConversationSchema,
  mobileSubscriptionUsageEntrySchema,
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
      mobileChatItemSchema.parse({
        kind: 'assistant',
        id: 'a',
        at: '2026-10-13T12:00:00.000Z',
        text: 'Hi',
        streaming: false,
      })
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

  it('keep the conversation a message came from, and no such field on any other message', () => {
    const message = {
      kind: 'user',
      id: 'u',
      at: '2026-10-13T12:00:00.000Z',
      text: 'Merged.',
      source: 'owner',
      queued: false,
    }
    const fromConversation = { conversationId: 'c7', name: 'Push sender', purpose: 'report' }
    expect(mobileChatItemSchema.parse({ ...message, fromConversation })).toMatchObject({ fromConversation })
    expect(mobileChatItemSchema.parse(message)).not.toHaveProperty('fromConversation')
    // A sender this app cannot name leaves an ordinary message.
    const unknown = { ...message, fromConversation: { ...fromConversation, purpose: 'x' } }
    expect(mobileChatItemSchema.parse(unknown)).not.toHaveProperty('fromConversation')
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

    socket.receive({
      t: 'event',
      origin: 1,
      channel: 'mobile:v1:status',
      args: [{ conversationId: 'c1', status: 'working' }],
    })
    socket.receive({ t: 'event', origin: 1, channel: 'mobile:v1:unknown', args: [{}] })
    socket.receive({
      t: 'event',
      origin: 1,
      channel: 'mobile:v1:status',
      args: [{ conversationId: 'c1', status: 'odd' }],
    })
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
    await expect(
      h.client.invoke('send', { conversationId: 'c1', text: 'hi', attachments: [], clientId: 'nope' })
    ).rejects.toMatchObject({
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

  it('reads subscription usage with only a force flag, and keeps the entries it understands', () => {
    const spec = MOBILE_CHANNELS.subscriptionUsage
    expect(spec.args.parse({})).toEqual({})
    expect(spec.args.parse({ force: true })).toEqual({ force: true })
    expect(spec.args.safeParse({ force: true, accountId: 'acc_1' }).success).toBe(false)

    const ready = {
      providerId: 'builtin_claude_subscription@acc_1',
      providerKind: 'claude',
      providerLabel: 'Claude',
      accountLabel: 'Work',
      state: 'ready',
      fetchedAt: 1_790_000_000_000,
      windows: [
        { id: 'five_hour', kind: 'five-hour', usedPercent: 42, resetsAt: 1_790_000_600_000, durationMins: 300 },
        {
          id: 'seven_day_opus',
          kind: 'weekly-model',
          usedPercent: 100,
          resetsAt: null,
          durationMins: null,
          label: 'Opus',
        },
        { id: 'monthly', kind: 'monthly', usedPercent: 0, resetsAt: null, durationMins: 43_200 },
      ],
    }
    const failed = {
      providerId: 'builtin_codex_subscription',
      providerKind: 'codex',
      providerLabel: 'ChatGPT',
      state: 'error',
      windows: [],
      error: 'token expired',
    }
    expect(mobileSubscriptionUsageEntrySchema.parse(ready).windows.map((window) => window.kind)).toEqual([
      'five-hour',
      'weekly-model',
      'other',
    ])
    expect(mobileSubscriptionUsageEntrySchema.parse(failed).error).toBe('failed')
    expect(mobileSubscriptionUsageEntrySchema.parse({ ...ready, error: undefined }).error).toBeUndefined()

    const overUsed = { ...ready, windows: [{ ...ready.windows[0], usedPercent: 101 }] }
    const negative = { ...ready, windows: [{ ...ready.windows[0], usedPercent: -1 }] }
    expect(mobileSubscriptionUsageEntrySchema.safeParse(overUsed).success).toBe(false)
    expect(mobileSubscriptionUsageEntrySchema.safeParse(negative).success).toBe(false)

    // A provider a newer host adds, or a broken entry, leaves the others readable.
    const result = spec.result.parse({ entries: [ready, { ...ready, providerKind: 'grok' }, overUsed, failed] })
    expect(result.entries.map((entry) => entry.providerId)).toEqual([ready.providerId, failed.providerId])
  })

  it('creates a workspace chat on a new or an existing branch', () => {
    const args = MOBILE_CHANNELS.create.args
    expect(args.safeParse({ workspaceId: 'w', branch: { kind: 'new', name: 'feat/x', base: 'main' } }).success).toBe(
      true
    )
    expect(args.safeParse({ workspaceId: 'w', branch: { kind: 'new', base: 'release' } }).success).toBe(true)
    expect(args.safeParse({ workspaceId: 'w', branch: { kind: 'existing', name: 'release' } }).success).toBe(true)
    expect(args.safeParse({ workspaceId: 'w', branch: { kind: 'existing' } }).success).toBe(false)
    expect(
      args.safeParse({ workspaceId: 'w', branch: { kind: 'existing', name: 'release', base: 'main' } }).success
    ).toBe(false)
    expect(args.safeParse({ workspaceId: 'w', branch: { kind: 'new', name: '  ' } }).success).toBe(false)
  })

  it('decides a plan as the Plan tab does, while a bare decision still suits hosts that predate it', () => {
    const args = MOBILE_CHANNELS.plan.args
    expect(args.safeParse({ conversationId: 'c', action: 'revise', feedback: 'Shorter' }).success).toBe(true)
    expect(
      args.safeParse({
        conversationId: 'c',
        action: 'revise',
        editedPlan: '## Steps\n1. One',
        lineComments: [{ line: 2, text: 'Split this step' }],
      }).success
    ).toBe(true)
    expect(
      args.safeParse({
        conversationId: 'c',
        action: 'approve',
        implementation: { target: 'maestro', profileId: 'global' },
      }).success
    ).toBe(true)
    const standard = {
      target: 'standard',
      settings: { providerId: 'claude', modelId: 'opus', reasoning: 'off', fastMode: false },
      placement: 'worktree',
    }
    expect(args.safeParse({ conversationId: 'c', action: 'approve', implementation: standard }).success).toBe(true)
    // Comments sit on real lines with words in them; a handoff names complete settings and a known placement.
    expect(
      args.safeParse({ conversationId: 'c', action: 'revise', lineComments: [{ line: 0, text: 'x' }] }).success
    ).toBe(false)
    expect(
      args.safeParse({ conversationId: 'c', action: 'revise', lineComments: [{ line: 1, text: ' ' }] }).success
    ).toBe(false)
    expect(
      args.safeParse({ conversationId: 'c', action: 'approve', implementation: { ...standard, placement: 'remote' } })
        .success
    ).toBe(false)
    expect(
      args.safeParse({
        conversationId: 'c',
        action: 'approve',
        implementation: {
          target: 'standard',
          settings: { providerId: 'claude', modelId: 'opus' },
          placement: 'shared',
        },
      }).success
    ).toBe(false)
    expect(MOBILE_CHANNELS.plan.result.parse({ ok: true, conversationId: 'c2' })).toEqual({
      ok: true,
      conversationId: 'c2',
    })
  })

  it('reads plans and plan options from older and newer hosts alike', () => {
    const runtime = { streaming: false, compacting: false, context: null }
    const plan = (value: unknown) => MOBILE_CHANNELS.open.result.shape.runtime.parse({ ...runtime, plan: value }).plan
    expect(plan({ version: 1, title: null, text: 'One' })).toEqual({ version: 1, title: null, text: 'One' })
    expect(plan({ version: 2, title: 'T', text: 'Two', previousText: 'One' })?.previousText).toBe('One')

    const options = MOBILE_CHANNELS.planOptions.result
    const profile = {
      id: 'builtin:fast',
      source: 'builtin',
      name: 'Fast',
      strategy: 'fast',
      orchestrator: { modelId: 'opus', reasoning: 'high' },
      agents: ['Implementer'],
    }
    // A strategy kind or a review stage this app does not know reads as one it does.
    expect(
      options.parse({
        newConversation: true,
        maestro: { profiles: [{ ...profile, source: 'team' }], lastUsedId: null },
        review: { target: 'tests', stage: 'paused' },
      })
    ).toEqual({
      newConversation: true,
      maestro: { profiles: [{ ...profile, source: 'custom' }], lastUsedId: null },
      review: { target: 'code', stage: 'running' },
    })
  })
})

describe('bot conversations', () => {
  const conversation = {
    id: 'c1',
    name: 'Fix login',
    workspaceId: 'w1',
    workspaceName: 'maestrly',
    branch: 'bot/fix-login',
    status: 'idle',
    lastActivityAt: '2026-10-20T12:00:00.000Z',
    pinned: false,
    experience: 'standard',
  }

  it('name the bot that holds a conversation, and read one from an older host or with an unknown state', () => {
    const bot = { name: 'Scout', state: 'active', shared: false }
    expect(mobileConversationSchema.parse({ ...conversation, bot })).toMatchObject({ bot })
    expect(mobileConversationSchema.parse(conversation)).not.toHaveProperty('bot')
    expect(mobileConversationSchema.parse({ ...conversation, bot: { ...bot, state: 'later' } }).bot?.state).toBe(
      'revoked'
    )
  })

  it('keep the bot that sent a message, and leave an ordinary message otherwise', () => {
    const message = {
      kind: 'user',
      id: 'u',
      at: '2026-10-20T12:00:00.000Z',
      text: 'Run the tests.',
      source: 'owner',
      queued: false,
    }
    expect(mobileChatItemSchema.parse({ ...message, sentByBot: { name: 'Scout' } })).toMatchObject({
      sentByBot: { name: 'Scout' },
    })
    expect(mobileChatItemSchema.parse(message)).not.toHaveProperty('sentByBot')
  })

  it('release, block, pause and resume a conversation by its id only', () => {
    const { botManualChat, botManagement } = MOBILE_CHANNELS
    expect(botManualChat.args.safeParse({ conversationId: 'c1', enabled: true }).success).toBe(true)
    expect(botManualChat.args.safeParse({ conversationId: 'c1' }).success).toBe(false)
    expect(botManagement.args.safeParse({ conversationId: 'c1', state: 'paused' }).success).toBe(true)
    expect(botManagement.args.safeParse({ conversationId: 'c1', state: 'revoked' }).success).toBe(false)
  })
})
