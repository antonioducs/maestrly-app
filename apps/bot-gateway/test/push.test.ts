import { fleetPushDataSchema, type FleetGatewayEvent, type FleetPushRegistration } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { ExpoPushSender, PushNotifier, type PushMessage, type PushOutcome, type PushStore } from '../src/push.js'

const at = '2026-10-13T12:00:00.000Z'
const registration = (overrides: Partial<FleetPushRegistration> = {}): FleetPushRegistration => ({
  provider: 'expo',
  token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
  platform: 'ios',
  locale: 'en',
  preferences: { waiting: true, replies: true, routines: true, errors: true },
  updatedAt: at,
  ...overrides,
})

function setup(
  registrations: Record<string, FleetPushRegistration>,
  outcomes?: (messages: PushMessage[]) => PushOutcome[]
) {
  const sent: PushMessage[][] = []
  const removed: string[] = []
  let clock = Date.parse(at)
  const store: PushStore = {
    activePushRegistrations: () =>
      Object.entries(registrations).map(([deviceId, value]) => ({ deviceId, registration: value })),
    pushRegistration: (deviceId) => registrations[deviceId] ?? null,
    deletePushRegistration: (deviceId) => {
      removed.push(deviceId)
      delete registrations[deviceId]
      return true
    },
    getBot: (id) => (id === 'atlas' ? { name: 'Atlas' } : id === 'ledger' ? { name: 'Ledger' } : null),
  }
  const notifier = new PushNotifier({
    store,
    sender: {
      send: async (messages) => {
        sent.push(messages)
        return outcomes ? outcomes(messages) : messages.map(() => ({ ok: true }))
      },
    },
    serverName: () => 'home-lab',
    now: () => clock,
  })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return { notifier, sent, removed, flush, advance: (ms: number) => (clock += ms) }
}

const inbox = (items: Array<[string, 'permission' | 'question' | 'help', string]>): FleetGatewayEvent => ({
  type: 'inbox.updated',
  at,
  items: items.map(([botId, kind, id]) => ({
    botId,
    interaction:
      kind === 'permission'
        ? {
            kind,
            id,
            at,
            title: 'Run a command',
            detail: null,
            tool: { name: 'bash', target: 'npm run deploy' },
            itemId: 'i-' + id,
          }
        : kind === 'question'
          ? { kind, id, at, questions: [], itemId: 'i-' + id }
          : { kind, id, at, reason: 'secret', itemId: 'i-' + id },
  })),
})
const activity = (
  botId: string,
  kind: 'turn_completed' | 'turn_failed' | 'bot_failed',
  data: Record<string, string> = {},
  seq = 1
): FleetGatewayEvent => ({
  type: 'activity',
  at,
  entry: { seq, at, botId, environmentId: null, kind, summary: 'The secret summary', data },
})

describe('push notifications', () => {
  it('tells each phone, in its language, about a new request with only the bot name and the ids', async () => {
    const h = setup({
      d1: registration(),
      d2: registration({ locale: 'pt-BR', token: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]' }),
    })
    h.notifier.observe(inbox([['atlas', 'permission', 'r1']]))
    await h.flush()
    expect(h.sent).toEqual([
      [
        {
          to: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
          title: 'Atlas',
          body: 'Needs your approval',
          data: { v: 1, device: 'd1', kind: 'bot', id: 'atlas', category: 'waiting' },
        },
        {
          to: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
          title: 'Atlas',
          body: 'Precisa da sua aprovação',
          data: { v: 1, device: 'd2', kind: 'bot', id: 'atlas', category: 'waiting' },
        },
      ],
    ])
    expect(JSON.stringify(h.sent)).not.toContain('deploy')
    // The same request seen again, and requests that went away, send nothing new; a new one does.
    h.notifier.observe(inbox([['atlas', 'permission', 'r1']]))
    h.notifier.observe(inbox([]))
    h.notifier.observe(inbox([['ledger', 'help', 'h1']]))
    await h.flush()
    expect(h.sent.slice(1).flatMap((batch) => batch.map((message) => [message.title, message.body]))).toEqual([
      ['Ledger', 'Needs your help'],
      ['Ledger', 'Precisa da sua ajuda'],
    ])
    expect(JSON.stringify(h.sent)).not.toContain('secret')
  })

  it('sends replies, routine reports and failures as each phone chose', async () => {
    const h = setup({
      d1: registration({ preferences: { waiting: true, replies: false, routines: true, errors: true } }),
    })
    h.notifier.observe(activity('atlas', 'turn_completed', { source: 'owner' }, 1))
    h.notifier.observe(activity('ledger', 'turn_completed', { source: 'routine' }, 2))
    // A run that found nothing new, or that its bot keeps quiet, sends nothing.
    h.notifier.observe(activity('ledger', 'turn_completed', { source: 'routine', runId: 'r', alert: false }, 6))
    h.notifier.observe(activity('ledger', 'turn_completed', { source: 'peer' }, 3))
    h.notifier.observe(activity('atlas', 'turn_failed', {}, 4))
    h.notifier.observe(activity('atlas', 'bot_failed', {}, 5))
    await h.flush()
    expect(h.sent.flat().map((message) => [message.title, message.body, message.data.category])).toEqual([
      ['Ledger', 'Routine report ready', 'routines'],
      ['Atlas', 'A turn failed', 'errors'],
      ['Atlas', 'Stopped unexpectedly', 'errors'],
    ])
  })

  it('tells about the chats of the workspaces host', async () => {
    const h = setup({ d1: registration() })
    await h.notifier.chat('workspaces', 'c1', 'Fix the flaky test', 'plan')
    await h.notifier.chat('workspaces', 'c1', 'Fix the flaky test', 'plan')
    await h.notifier.chat('workspaces', 'c2', 'Changelog', 'finished')
    await h.notifier.chat('zello', 'c3', 'Pricing', 'failed')
    // The same chat id on another workspaces host is another chat.
    await h.notifier.chat('zello', 'c1', 'Invoices', 'plan')
    expect(
      h.sent.flat().map((message) => [message.title, message.body, message.data.kind, message.data.id, message.data.env])
    ).toEqual([
      ['Fix the flaky test', 'Has a plan for you', 'chat', 'c1', 'workspaces'],
      ['Changelog', 'Finished its turn', 'chat', 'c2', 'workspaces'],
      ['Pricing', 'Stopped with an error', 'chat', 'c3', 'zello'],
      ['Invoices', 'Has a plan for you', 'chat', 'c1', 'zello'],
    ])
    for (const message of h.sent.flat()) expect(fleetPushDataSchema.parse(message.data)).toEqual(message.data)
    // After the window, the same news notifies again.
    h.advance(25_000)
    await h.notifier.chat('workspaces', 'c1', 'Fix the flaky test', 'plan')
    expect(h.sent).toHaveLength(5)
  })

  it('forgets a phone the push service no longer knows', async () => {
    const h = setup({ d1: registration(), d2: registration() }, (messages) =>
      messages.map((message) => (message.data.device === 'd2' ? { ok: false, unregistered: true } : { ok: true }))
    )
    h.notifier.observe(inbox([['atlas', 'question', 'q1']]))
    await h.flush()
    expect(h.removed).toEqual(['d2'])
  })

  it('sends a test to one phone, and says when it cannot', async () => {
    const h = setup({ d1: registration({ locale: 'pt-BR' }) })
    await h.notifier.test('d1')
    expect(h.sent[0][0]).toMatchObject({
      title: 'Maestrly',
      body: 'As notificações de home-lab funcionam.',
      data: { kind: 'test', id: null },
    })
    await expect(h.notifier.test('nobody')).rejects.toBeInstanceOf(GatewayError)
    const failing = setup({ d1: registration() }, (messages) => messages.map(() => ({ ok: false, unregistered: true })))
    await expect(failing.notifier.test('d1')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    expect(failing.removed).toEqual(['d1'])
  })
})

describe('Expo push sender', () => {
  it('posts in batches of 100, with the access token, and reads each ticket', async () => {
    const bodies: unknown[][] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown[]
      bodies.push(body)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer expo-token')
      return new Response(
        JSON.stringify({
          data: body.map((_, index) =>
            index === 1
              ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok', id: 't' }
          ),
        })
      )
    })
    const sender = new ExpoPushSender({ accessToken: 'expo-token', fetch: fetch as unknown as typeof globalThis.fetch })
    const message = (index: number): PushMessage => ({
      to: `ExponentPushToken[${String(index).padStart(10, 'x')}]`,
      title: 'Atlas',
      body: 'Needs your approval',
      data: { v: 1, device: 'd', kind: 'bot', id: 'atlas', category: 'waiting' },
    })
    const outcomes = await sender.send(Array.from({ length: 150 }, (_, index) => message(index)))
    expect(bodies.map((body) => body.length)).toEqual([100, 50])
    expect(bodies[0][0]).toMatchObject({ title: 'Atlas', sound: 'default', priority: 'high', channelId: 'default' })
    expect(outcomes[0]).toEqual({ ok: true })
    expect(outcomes[1]).toEqual({ ok: false, unregistered: true })
    expect(outcomes[101]).toEqual({ ok: false, unregistered: true })
  })

  it('reports a failed request as not delivered, keeping the tokens', async () => {
    const down = new ExpoPushSender({
      accessToken: null,
      fetch: (async () => new Response('', { status: 503 })) as never,
    })
    expect(
      await down.send([
        { to: 'x', title: 't', body: 'b', data: { v: 1, device: 'd', kind: 'test', id: null, category: null } },
      ])
    ).toEqual([{ ok: false, unregistered: false }])
    const offline = new ExpoPushSender({
      accessToken: null,
      fetch: (async () => Promise.reject(new Error('offline'))) as never,
    })
    expect(
      await offline.send([
        { to: 'x', title: 't', body: 'b', data: { v: 1, device: 'd', kind: 'test', id: null, category: null } },
      ])
    ).toEqual([{ ok: false, unregistered: false }])
  })
})
