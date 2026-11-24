import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ATTENTION_LIMITS,
  FLEET_CHAT_ATTENTION_SYNC_CAPABILITY,
  FLEET_ENVIRONMENTS_FEATURE,
  fleetAttentionKey,
  fleetMetaFeatures,
  type FleetAttentionEntry,
  type FleetAttentionUpdatedEvent,
  type FleetInboxItem,
  type MobileLists,
} from '@maestrly/bot-fleet-protocol'
import { INBOX_READ_TTL_MS } from '@maestrly/bot-fleet-protocol/inbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatsReducer, initialChatsState, type ChatsAction, type ChatsState } from '../src/chats/state'
import { createDemoSource, DEMO_FEATURES, DEMO_SERVER, demoInitialReadEntries } from '../src/demo/demo-source'
import { botRecord, environmentRecord } from '../src/fleet/factories'
import { fleetReducer, initialFleetState, type FleetAction, type FleetState } from '../src/fleet/state'
import {
  batchSeenKeysByServer,
  createInboxController,
  INBOX_LEDGER_KEY,
  type InboxServerInput,
} from '../src/inbox/controller'
import { environmentNeedsChatFallback, fallbackChatObservations, fallbackObservations } from '../src/inbox/fallback'
import { sameFallbackObservations, subscribeInboxStoreSlices } from '../src/inbox/sync'
import { inboxItemKey, openInboxItem } from '../src/inbox/types'
import { memoryStores } from '../src/servers/registry'

const BASE_NOW = Date.parse('2026-10-12T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(BASE_NOW + offsetMs).toISOString()

function serverInput(overrides: Partial<InboxServerInput> & Pick<InboxServerInput, 'id' | 'name'>): InboxServerInput {
  return {
    features: [FLEET_ATTENTION_FEATURE, FLEET_ENVIRONMENTS_FEATURE],
    supportsAttention: true,
    reachable: true,
    loaded: true,
    entries: new Map(),
    environments: new Map(),
    ...overrides,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('inbox controller', () => {
  it('merges entries across servers with prefixed keys, environment places, stale flag and accurate counts', async () => {
    const { kv } = memoryStores()
    const controller = createInboxController({ kv, now: () => BASE_NOW, tickMs: 0 })
    await controller.start()

    const sameRawKey = fleetAttentionKey.chat('personal', 'c1')
    controller.setServers([
      serverInput({
        id: 'srv-a',
        name: 'Home',
        environments: new Map([
          ['personal', 'Personal'],
          ['company', 'Company'],
        ]),
        entries: new Map([
          [
            sameRawKey,
            {
              key: sameRawKey,
              source: 'chat',
              kind: 'approval',
              at: iso(-10_000),
              title: 'Approve deploy',
              environmentId: 'personal',
              conversationId: 'c1',
            },
          ],
          [
            'chat:company/k1',
            {
              key: 'chat:company/k1',
              source: 'chat',
              kind: 'finished',
              at: iso(-5_000),
              title: 'Invoice report',
              environmentId: 'company',
              conversationId: 'k1',
            },
          ],
        ]),
      }),
      serverInput({
        id: 'srv-b',
        name: 'Office',
        reachable: false,
        environments: new Map([['personal', 'Personal']]),
        entries: new Map([
          [
            sameRawKey,
            {
              key: sameRawKey,
              source: 'chat',
              kind: 'error',
              at: iso(-2_000),
              title: 'Broken build',
              environmentId: 'personal',
              conversationId: 'c1',
            },
          ],
        ]),
      }),
    ])

    const { items, counts, servers } = controller.getState()
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.key)).toEqual([
      'srv-b|chat:personal/c1',
      'srv-a|chat:company/k1',
      'srv-a|chat:personal/c1',
    ])

    // Multi-environment server includes environment name in place; single-environment server shows only server name.
    const fromA = items.find((item) => item.key === 'srv-a|chat:personal/c1')!
    expect(fromA.place).toEqual({ key: 'srv-a/personal', label: 'Home · Personal' })
    expect(fromA.environmentId).toBe('personal')
    expect(fromA.environmentName).toBe('Personal')
    expect(fromA.stale).toBe(false)
    expect(fromA.group).toBe('waiting')

    const fromB = items.find((item) => item.key === 'srv-b|chat:personal/c1')!
    expect(fromB.place).toEqual({ key: 'srv-b', label: 'Office' })
    expect(fromB.stale).toBe(true)
    expect(fromB.group).toBe('new')

    expect(counts).toEqual({ waiting: 1, unread: 2, total: 3 })
    expect(servers).toEqual([
      { id: 'srv-a', name: 'Home', reachable: true, supportsAttention: true, environments: 2, lastSyncedAt: null },
      { id: 'srv-b', name: 'Office', reachable: false, supportsAttention: true, environments: 1, lastSyncedAt: null },
    ])
    controller.stop()
  })

  it('persists ledger under inbox.ledger with debounce and restores it via parseInboxLedger', async () => {
    const { kv } = memoryStores()
    const setSpy = vi.spyOn(kv, 'set')
    let now = BASE_NOW
    const first = createInboxController({ kv, now: () => now, persistDebounceMs: 250, tickMs: 0 })
    await first.start()

    const chatEntry: FleetAttentionEntry = {
      key: 'chat:personal/c1',
      source: 'chat',
      kind: 'finished',
      at: iso(-10_000),
      title: 'Finished task',
      environmentId: 'personal',
      conversationId: 'c1',
    }
    first.setServers([serverInput({ id: 'srv-a', name: 'Home', entries: new Map([[chatEntry.key, chatEntry]]) })])
    first.markRead([inboxItemKey('srv-a', chatEntry.key)])

    // Debounced: not written yet before 250ms.
    expect(setSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith(INBOX_LEDGER_KEY, expect.any(String))
    first.stop()

    // Second controller loads the persisted ledger: item stays read even after server clears it.
    now += 60_000
    const second = createInboxController({ kv, now: () => now, tickMs: 0 })
    await second.start()
    second.setServers([serverInput({ id: 'srv-a', name: 'Home', entries: new Map() })])
    const items = second.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'srv-a|chat:personal/c1', group: 'read', unread: false })
    expect(second.getState().counts).toEqual({ waiting: 0, unread: 0, total: 0 })

    // Corrupt storage falls back safely to an empty ledger.
    await kv.set(INBOX_LEDGER_KEY, '{corrupt json')
    const third = createInboxController({ kv, now: () => now, tickMs: 0 })
    await third.start()
    expect(third.getState().items).toEqual([])
    second.stop()
    third.stop()
  })

  it('keeps waiting items until answered, transitions news to read on markRead/cross-device clear, and supports dismiss/restore', async () => {
    const { kv } = memoryStores()
    let now = BASE_NOW
    const sendSeen = vi.fn()
    const controller = createInboxController({ kv, sendSeen, now: () => now, tickMs: 0 })
    await controller.start()

    const waitingEntry: FleetAttentionEntry = {
      key: 'request:atlas/req-1',
      source: 'request',
      kind: 'approval',
      at: iso(-5_000),
      title: 'Atlas',
      botId: 'atlas',
      requestId: 'req-1',
    }
    const newsEntry: FleetAttentionEntry = {
      key: 'bot:ledger',
      source: 'bot',
      kind: 'finished',
      at: iso(-4_000),
      title: 'Ledger',
      botId: 'ledger',
    }
    const otherNews: FleetAttentionEntry = {
      key: 'chat:personal/c2',
      source: 'chat',
      kind: 'error',
      at: iso(-3_000),
      title: 'Failed job',
      environmentId: 'personal',
      conversationId: 'c2',
    }
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Home',
        entries: new Map([
          [waitingEntry.key, waitingEntry],
          [newsEntry.key, newsEntry],
          [otherNews.key, otherNews],
        ]),
      }),
    ])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 2, total: 3 })

    // markAllRead marks all unread items read; news move to `read`, waiting stays in `waiting`.
    controller.markAllRead()
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 0, total: 1 })
    expect(controller.getState().items.find((i) => i.key === 's1|request:atlas/req-1')?.group).toBe('waiting')
    expect(controller.getState().items.find((i) => i.key === 's1|request:atlas/req-1')?.unread).toBe(false)
    expect(controller.getState().items.find((i) => i.key === 's1|bot:ledger')?.group).toBe('read')
    expect(sendSeen).toHaveBeenCalledTimes(1)
    expect(sendSeen.mock.calls[0]?.[1]).not.toContain('request:atlas/req-1')

    // Dismiss hides an item; restore puts it back.
    const undo = controller.dismiss('s1|bot:ledger')
    expect(controller.getState().items.some((i) => i.key === 's1|bot:ledger')).toBe(false)
    controller.restore(undo)
    expect(controller.getState().items.some((i) => i.key === 's1|bot:ledger')).toBe(true)

    // Server removes answered transient request and cleared news: request vanishes, news stays in read until TTL.
    controller.setServers([serverInput({ id: 's1', name: 'Home', entries: new Map() })])
    expect(controller.getState().items.some((i) => i.key === 's1|request:atlas/req-1')).toBe(false)
    expect(controller.getState().items.find((i) => i.key === 's1|bot:ledger')?.group).toBe('read')
    expect(controller.getState().counts).toEqual({ waiting: 0, unread: 0, total: 0 })

    // After 24h TTL, read items expire.
    now += INBOX_READ_TTL_MS + 1_000
    controller.tick()
    expect(controller.getState().items).toEqual([])
    controller.stop()
  })

  it('batches POST /v1/attention/seen to <=200 keys per server and skips servers without the attention feature', async () => {
    const serversById = new Map([
      ['s-new', { supportsAttention: true }],
      ['s-old', { supportsAttention: false }],
    ])
    const keys: string[] = []
    for (let i = 0; i < 405; i++) keys.push(`s-new|chat:personal/c-${i}`)
    // Duplicate key should be deduplicated; old server keys must never be sent.
    keys.push('s-new|chat:personal/c-0', 's-old|chat:personal/legacy-1', 's-old|bot:old-bot')

    const batches = batchSeenKeysByServer(keys, serversById)
    expect(batches).toHaveLength(3)
    expect(batches.every((b) => b.serverId === 's-new')).toBe(true)
    expect(batches.map((b) => b.keys.length)).toEqual([
      FLEET_ATTENTION_LIMITS.seenKeysMax,
      FLEET_ATTENTION_LIMITS.seenKeysMax,
      5,
    ])
  })

  it('openInboxItem marks read, switches server/environment as needed, and routes chats, bots, and bot lanes via pushLink', async () => {
    const { kv } = memoryStores()
    const sendSeen = vi.fn()
    const controller = createInboxController({ kv, sendSeen, now: () => BASE_NOW, tickMs: 0 })
    await controller.start()

    const chatEntry: FleetAttentionEntry = {
      key: 'chat:company/k1',
      source: 'chat',
      kind: 'finished',
      at: iso(-2_000),
      title: 'Invoices',
      environmentId: 'company',
      conversationId: 'k1',
    }
    const laneEntry: FleetAttentionEntry = {
      key: 'bot:atlas',
      source: 'bot',
      kind: 'help',
      at: iso(-1_000),
      title: 'Atlas',
      environmentId: 'studio',
      botId: 'atlas',
      threadId: 'thread-pixel',
    }
    const oldReqEntry: FleetInboxItem = {
      botId: 'juno',
      interaction: {
        kind: 'permission',
        id: 'req-9',
        at: iso(-500),
        title: 'Run deploy',
        detail: null,
        tool: null,
        itemId: 'it-1',
        runId: 'run-42',
      },
    }
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Home',
        environments: new Map([
          ['personal', 'Personal'],
          ['company', 'Company'],
        ]),
        entries: new Map([
          [chatEntry.key, chatEntry],
          [laneEntry.key, laneEntry],
        ]),
      }),
      serverInput({
        id: 's-old',
        name: 'Legacy',
        features: [],
        supportsAttention: false,
        fallback: fallbackObservations({
          serverId: 's-old',
          serverName: 'Legacy',
          bots: [botRecord({ id: 'juno', name: 'Juno' })],
          environments: [],
          inbox: [oldReqEntry],
          environmentId: null,
          chatLists: null,
        }),
      }),
    ])

    // 1. Same server, different environment -> calls setEnvironment and routes with env.
    const activateServer = vi.fn(async () => {})
    const setEnvironment = vi.fn()
    const pushRoute = vi.fn()
    const chatItem = controller.getState().items.find((i) => i.key === 's1|chat:company/k1')!
    await openInboxItem(chatItem, {
      activeServerId: 's1',
      activeEnvironmentId: 'personal',
      activateServer,
      setEnvironment,
      pushRoute,
      markRead: (keys) => controller.markRead(keys),
    })
    expect(activateServer).not.toHaveBeenCalled()
    expect(setEnvironment).toHaveBeenCalledWith('company')
    expect(pushRoute).toHaveBeenCalledWith('/chat/k1?server=s1&env=company')
    expect(sendSeen).toHaveBeenCalledWith('s1', ['chat:company/k1'])

    // 2. Different server, bot peer thread lane -> activates server and routes to /lane/<bot>?kind=thread&lane=...
    activateServer.mockClear()
    setEnvironment.mockClear()
    pushRoute.mockClear()
    sendSeen.mockClear()
    const threadItem = controller.getState().items.find((i) => i.key === 's1|bot:atlas')!
    await openInboxItem(threadItem, {
      activeServerId: 's-old',
      activeEnvironmentId: null,
      activateServer,
      setEnvironment,
      pushRoute,
      markRead: (keys) => controller.markRead(keys),
    })
    expect(activateServer).toHaveBeenCalledWith('s1')
    expect(pushRoute).toHaveBeenCalledWith('/lane/atlas?kind=thread&lane=thread-pixel&server=s1')
    expect(sendSeen).toHaveBeenCalledWith('s1', ['bot:atlas'])

    // 3. Server WITHOUT attention feature, bot routine run lane -> routes to /lane/<bot>?kind=run&lane=..., NO seen POST!
    pushRoute.mockClear()
    sendSeen.mockClear()
    const legacyItem = controller.getState().items.find((i) => i.key === 's-old|request:juno/req-9')!
    await openInboxItem(legacyItem, {
      activeServerId: 's-old',
      activeEnvironmentId: null,
      activateServer,
      setEnvironment,
      pushRoute,
      markRead: (keys) => controller.markRead(keys),
    })
    expect(pushRoute).toHaveBeenCalledWith('/lane/juno?kind=run&lane=run-42&server=s-old')
    expect(sendSeen).not.toHaveBeenCalled()
    controller.stop()
  })

  it('tracks lastSyncedAt for attention and fallback servers', async () => {
    const { kv } = memoryStores()
    let now = BASE_NOW
    const controller = createInboxController({ kv, now: () => now, tickMs: 0 })
    await controller.start()

    controller.setServers([
      serverInput({ id: 'srv-a', name: 'Attention', supportsAttention: true, loaded: false, lastSyncedAt: null }),
      serverInput({ id: 'srv-f', name: 'Legacy', supportsAttention: false, loaded: false }),
    ])
    expect(controller.getState().servers.map((s) => ({ id: s.id, lastSyncedAt: s.lastSyncedAt }))).toEqual([
      { id: 'srv-a', lastSyncedAt: null },
      { id: 'srv-f', lastSyncedAt: null },
    ])

    // Initial load sets fallback lastSyncedAt and passes through attention lastSyncedAt.
    now = BASE_NOW + 10_000
    const fallbackObs = fallbackObservations({
      serverId: 'srv-f',
      serverName: 'Legacy',
      bots: [botRecord({ id: 'atlas', name: 'Atlas' })],
      environments: [],
      inbox: [
        {
          botId: 'atlas',
          interaction: {
            kind: 'permission',
            id: 'r1',
            at: iso(0),
            title: 'Deploy',
            detail: null,
            tool: null,
            itemId: 'i1',
          },
        },
      ],
      environmentId: null,
      chatLists: null,
    })
    controller.setServers([
      serverInput({
        id: 'srv-a',
        name: 'Attention',
        supportsAttention: true,
        loaded: true,
        lastSyncedAt: BASE_NOW + 5_000,
      }),
      serverInput({ id: 'srv-f', name: 'Legacy', supportsAttention: false, loaded: true, fallback: fallbackObs }),
    ])
    expect(controller.getState().servers.map((s) => ({ id: s.id, lastSyncedAt: s.lastSyncedAt }))).toEqual([
      { id: 'srv-a', lastSyncedAt: BASE_NOW + 5_000 },
      { id: 'srv-f', lastSyncedAt: BASE_NOW + 10_000 },
    ])

    // Unchanged fallback observations or going unreachable do not advance fallback lastSyncedAt.
    now = BASE_NOW + 20_000
    controller.setServers([
      serverInput({
        id: 'srv-a',
        name: 'Attention',
        supportsAttention: true,
        reachable: false,
        loaded: true,
        lastSyncedAt: BASE_NOW + 5_000,
      }),
      serverInput({
        id: 'srv-f',
        name: 'Legacy',
        supportsAttention: false,
        reachable: false,
        loaded: true,
        fallback: fallbackObs,
      }),
    ])
    expect(controller.getState().servers.map((s) => ({ id: s.id, lastSyncedAt: s.lastSyncedAt }))).toEqual([
      { id: 'srv-a', lastSyncedAt: BASE_NOW + 5_000 },
      { id: 'srv-f', lastSyncedAt: BASE_NOW + 10_000 },
    ])

    // Recovering reachability advances fallback lastSyncedAt.
    now = BASE_NOW + 30_000
    controller.setServers([
      serverInput({
        id: 'srv-a',
        name: 'Attention',
        supportsAttention: true,
        reachable: true,
        loaded: true,
        lastSyncedAt: BASE_NOW + 30_000,
      }),
      serverInput({
        id: 'srv-f',
        name: 'Legacy',
        supportsAttention: false,
        reachable: true,
        loaded: true,
        fallback: fallbackObs,
      }),
    ])
    expect(controller.getState().servers.map((s) => ({ id: s.id, lastSyncedAt: s.lastSyncedAt }))).toEqual([
      { id: 'srv-a', lastSyncedAt: BASE_NOW + 30_000 },
      { id: 'srv-f', lastSyncedAt: BASE_NOW + 30_000 },
    ])

    controller.stop()
  })
})

describe('fallback observations', () => {
  it('derives bot requests from fleet.inbox and waiting/asking chats from active bridge lists', () => {
    const bots = [
      botRecord({ id: 'atlas', name: 'Atlas', tint: '#4f7cac', environmentId: 'studio' }),
      botRecord({ id: 'pixel', name: 'Pixel', tint: '#8a6fd0', environmentId: 'studio' }),
    ]
    const environments = [
      environmentRecord({ id: 'studio', name: 'Studio' }),
      environmentRecord({ id: 'personal', name: 'Personal', kind: 'workspaces' }),
    ]
    const inbox: FleetInboxItem[] = [
      {
        botId: 'atlas',
        interaction: {
          kind: 'permission',
          id: 'r1',
          at: iso(-10_000),
          title: 'Run deploy',
          detail: null,
          tool: null,
          itemId: 'i1',
        },
      },
      {
        botId: 'pixel',
        interaction: {
          kind: 'help',
          id: 'r2',
          at: iso(-5_000),
          reason: 'Sign in to staging',
          itemId: 'i2',
        },
      },
    ]
    const chatLists: MobileLists = {
      chats: [
        {
          id: 'c-ask',
          name: 'Architecture call',
          workspaceId: null,
          workspaceName: null,
          branch: null,
          status: 'asking',
          lastActivityAt: iso(-3_000),
          pinned: false,
          experience: 'standard',
        },
        {
          id: 'c-idle',
          name: 'Old note',
          workspaceId: null,
          workspaceName: null,
          branch: null,
          status: 'idle',
          lastActivityAt: iso(-90_000),
          pinned: false,
          experience: 'standard',
        },
      ],
      workspaces: [
        {
          id: 'ws-1',
          name: 'maestrly',
          defaultBranch: 'main',
          conversations: [
            {
              id: 'c-wait',
              name: 'Fix reconnect',
              workspaceId: 'ws-1',
              workspaceName: 'maestrly',
              branch: 'fix/reconnect',
              status: 'waiting',
              lastActivityAt: iso(-2_000),
              pinned: false,
              experience: 'standard',
            },
          ],
        },
      ],
    }

    const obs = fallbackObservations({
      serverId: 's-old',
      serverName: 'Legacy',
      bots,
      environments,
      inbox,
      environmentId: 'personal',
      chatLists,
    })

    const active = obs.filter((o) => o.active !== null)
    expect(active).toHaveLength(4)
    expect(active.find((o) => o.key === 's-old|request:atlas/r1')).toMatchObject({
      active: { kind: 'approval', unread: true },
      ownRead: true,
      transient: true,
      view: { summary: 'Run deploy', place: { key: 's-old/studio', label: 'Legacy · Studio' } },
    })
    expect(active.find((o) => o.key === 's-old|request:pixel/r2')?.active?.kind).toBe('help')
    expect(active.find((o) => o.key === 's-old|chat:personal/c-ask')).toMatchObject({
      active: { kind: 'question', unread: true },
      view: { source: 'chat', place: { key: 's-old/personal', label: 'Legacy · Personal' } },
    })
    expect(active.find((o) => o.key === 's-old|chat:personal/c-wait')).toMatchObject({
      active: { kind: 'approval', unread: true },
      view: { source: 'workspace', project: 'maestrly' },
    })
    expect(obs.find((o) => o.key === 's-old|chat:personal/c-idle')?.active).toBeNull()
  })
})

describe('demo server attention', () => {
  it('exposes waiting, unread finished/error, and read groups across multiple environments and clears seen news', async () => {
    expect(DEMO_FEATURES).toContain(FLEET_ATTENTION_FEATURE)
    const source = createDemoSource({ stepMs: 0, autoplay: false })
    const meta = await source.call('meta')
    expect(fleetMetaFeatures(meta)).toContain(FLEET_ATTENTION_FEATURE)

    const snapshot = await source.call('attention')
    const { environments } = await source.call('environmentsList')
    const envIds = new Set(snapshot.entries.map((item) => item.environmentId).filter(Boolean))
    expect(envIds.size).toBeGreaterThanOrEqual(2)

    const { kv } = memoryStores()
    const controller = createInboxController({
      kv,
      seedEntries: (id, now) => (id === DEMO_SERVER.id ? demoInitialReadEntries(now) : null),
      now: () => BASE_NOW,
      tickMs: 0,
    })
    await controller.start()
    controller.setServers([
      serverInput({
        id: DEMO_SERVER.id,
        name: DEMO_SERVER.name,
        features: DEMO_FEATURES,
        environments: new Map(environments.map((env) => [env.id, env.name])),
        entries: new Map(snapshot.entries.map((item) => [item.key, item])),
      }),
    ])

    const items = controller.getState().items
    const groups = new Set(items.map((item) => item.group))
    expect(groups).toEqual(new Set(['waiting', 'new', 'read']))
    const waitingKinds = new Set(items.filter((i) => i.group === 'waiting').map((i) => i.kind))
    expect(waitingKinds).toEqual(new Set(['approval', 'question', 'plan']))
    const newKinds = new Set(items.filter((i) => i.group === 'new').map((i) => i.kind))
    expect(newKinds.has('finished')).toBe(true)
    expect(newKinds.has('error')).toBe(true)

    // attentionSeen clears news entries and emits attention.updated, while keeping waiting entries intact.
    const deltas: FleetAttentionUpdatedEvent[] = []
    const stream = source.openEvents({
      onEvent: () => {},
      onAttention: (event) => deltas.push(event),
      onState: () => {},
    })
    const seenResult = await source.call('attentionSeen', {
      body: { keys: ['bot:ledger', 'chat:personal/c-push'] },
    })
    expect(seenResult.cleared).toEqual(['bot:ledger'])
    expect(deltas).toEqual([{ type: 'attention.updated', upsert: [], remove: ['bot:ledger'] }])
    stream.close()
    controller.stop()
  })
})

describe('focused bot auto-seen (B3)', () => {
  it('marks bot:<id> read and sends seen on open, on new arrival while focused, and on foreground return', async () => {
    const { kv } = memoryStores()
    const sendSeen = vi.fn()
    let now = BASE_NOW
    const controller = createInboxController({ kv, sendSeen, now: () => now, tickMs: 0 })
    await controller.start()

    const botEntry = (atMs: number): FleetAttentionEntry => ({
      key: fleetAttentionKey.bot('atlas'),
      source: 'bot',
      kind: 'finished',
      at: new Date(atMs).toISOString(),
      title: 'Atlas',
      botId: 'atlas',
    })
    const reqEntry: FleetAttentionEntry = {
      key: fleetAttentionKey.request('atlas', 'req-1'),
      source: 'request',
      kind: 'approval',
      at: iso(-5_000),
      title: 'Atlas',
      botId: 'atlas',
      requestId: 'req-1',
    }

    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([
          [botEntry(BASE_NOW - 10_000).key, botEntry(BASE_NOW - 10_000)],
          [reqEntry.key, reqEntry],
        ]),
      }),
    ])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    expect(sendSeen).not.toHaveBeenCalled()

    // Focusing Atlas while foregrounded immediately marks bot:atlas read + sends seen, leaving waiting request untouched.
    const blur = controller.focusBot('s1', 'atlas')
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 0, total: 1 })
    expect(sendSeen).toHaveBeenCalledTimes(1)
    expect(sendSeen).toHaveBeenLastCalledWith('s1', ['bot:atlas'])

    // A new reply arrives while Atlas stays focused and foregrounded -> auto-marked read + seen immediately.
    now = BASE_NOW + 10_000
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([
          [botEntry(BASE_NOW + 10_000).key, botEntry(BASE_NOW + 10_000)],
          [reqEntry.key, reqEntry],
        ]),
      }),
    ])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 0, total: 1 })
    expect(sendSeen).toHaveBeenCalledTimes(2)
    expect(sendSeen).toHaveBeenLastCalledWith('s1', ['bot:atlas'])

    // While backgrounded, a new reply stays unread and does NOT send seen until foreground returns.
    controller.setForeground(false)
    now = BASE_NOW + 25_000
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([
          [botEntry(BASE_NOW + 25_000).key, botEntry(BASE_NOW + 25_000)],
          [reqEntry.key, reqEntry],
        ]),
      }),
    ])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    expect(sendSeen).toHaveBeenCalledTimes(2)

    // Returning to foreground immediately marks the focused bot read + sends seen.
    now = BASE_NOW + 30_000
    controller.setForeground(true)
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 0, total: 1 })
    expect(sendSeen).toHaveBeenCalledTimes(3)
    expect(sendSeen).toHaveBeenLastCalledWith('s1', ['bot:atlas'])

    // After blurring the bot view, subsequent replies remain unread and do NOT send seen.
    blur()
    now = BASE_NOW + 45_000
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([
          [botEntry(BASE_NOW + 45_000).key, botEntry(BASE_NOW + 45_000)],
          [reqEntry.key, reqEntry],
        ]),
      }),
    ])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    expect(sendSeen).toHaveBeenCalledTimes(3)
    controller.stop()
  })

  it('marks bot:<id> seen when the snapshot loads after push-tap focus registration', async () => {
    const { kv } = memoryStores()
    const sendSeen = vi.fn()
    const controller = createInboxController({ kv, sendSeen, now: () => BASE_NOW, tickMs: 0 })
    await controller.start()

    // Focus happens before snapshot loads (e.g. cold push-tap navigation to bot/lane).
    const blur = controller.focusBot('s1', 'pixel')
    expect(sendSeen).not.toHaveBeenCalled()

    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([
          [
            'bot:pixel',
            {
              key: 'bot:pixel',
              source: 'bot',
              kind: 'finished',
              at: iso(-2_000),
              title: 'Pixel',
              botId: 'pixel',
              runId: 'run-9',
            },
          ],
        ]),
      }),
    ])

    expect(controller.getState().counts.unread).toBe(0)
    expect(sendSeen).toHaveBeenCalledTimes(1)
    expect(sendSeen).toHaveBeenCalledWith('s1', ['bot:pixel'])
    blur()
    controller.stop()
  })
})

describe('seen retries and dismiss semantics (S2)', () => {
  it('retries failed seen calls (batched <= 200) on next snapshot load for locally read NEWS only', async () => {
    const { kv } = memoryStores()
    let shouldFail = true
    const sent: Array<{ serverId: string; keys: string[] }> = []
    const sendSeen = vi.fn(async (serverId: string, keys: string[]) => {
      sent.push({ serverId, keys })
      if (shouldFail) throw new Error('offline')
    })
    let now = BASE_NOW
    const controller = createInboxController({ kv, sendSeen, now: () => now, tickMs: 0 })
    await controller.start()

    // Seed 205 news items + 1 waiting item on s1.
    const entries = new Map<string, FleetAttentionEntry>()
    for (let i = 0; i < 205; i++) {
      const key = `chat:p/c-${i}`
      entries.set(key, {
        key,
        source: 'chat',
        kind: 'finished',
        at: iso(-10_000),
        title: `Chat ${i}`,
        environmentId: 'p',
        conversationId: `c-${i}`,
      })
    }
    entries.set('request:atlas/r1', {
      key: 'request:atlas/r1',
      source: 'request',
      kind: 'approval',
      at: iso(-10_000),
      title: 'Atlas',
      botId: 'atlas',
      requestId: 'r1',
    })

    controller.setServers([serverInput({ id: 's1', name: 'Office', snapshotSeq: 1, entries })])
    expect(sent).toHaveLength(0)

    // Mark all read while offline: sendSeen fails (2 batches: 200 + 5).
    controller.markAllRead()
    expect(sent).toHaveLength(2)
    expect(sent.map((b) => b.keys.length)).toEqual([FLEET_ATTENTION_LIMITS.seenKeysMax, 5])

    // Unrelated SSE update with the SAME snapshotSeq does not re-send seen.
    sent.length = 0
    controller.setServers([serverInput({ id: 's1', name: 'Office', snapshotSeq: 1, entries })])
    expect(sent).toHaveLength(0)

    // Reconnect snapshot (snapshotSeq: 2): c-0 has a NEWER timestamp (should NOT be retried), others still match.
    shouldFail = false
    now = BASE_NOW + 60_000
    const nextEntries = new Map(entries)
    nextEntries.set('chat:p/c-0', {
      key: 'chat:p/c-0',
      source: 'chat',
      kind: 'finished',
      at: iso(50_000),
      title: 'Chat 0 newer',
      environmentId: 'p',
      conversationId: 'c-0',
    })
    controller.setServers([serverInput({ id: 's1', name: 'Office', snapshotSeq: 2, entries: nextEntries })])

    // Retries 204 locally-read news entries in 2 batches (200 + 4), excluding c-0 (newer) and request:atlas/r1 (waiting).
    expect(sent).toHaveLength(2)
    expect(sent.map((b) => b.keys.length)).toEqual([FLEET_ATTENTION_LIMITS.seenKeysMax, 4])
    const allRetried = sent.flatMap((b) => b.keys)
    expect(allRetried).not.toContain('chat:p/c-0')
    expect(allRetried).not.toContain('request:atlas/r1')
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    controller.stop()
  })

  it('sends seen when dismissing a NEWS item, does NOT send seen for a WAITING item, and Undo restores counts', async () => {
    const { kv } = memoryStores()
    const sendSeen = vi.fn()
    const controller = createInboxController({ kv, sendSeen, now: () => BASE_NOW, tickMs: 0 })
    await controller.start()

    const newsEntry: FleetAttentionEntry = {
      key: 'chat:company/k-inv',
      source: 'chat',
      kind: 'error',
      at: iso(-5_000),
      title: 'Invoice export timeouts',
      environmentId: 'company',
      conversationId: 'k-inv',
    }
    const waitingEntry: FleetAttentionEntry = {
      key: 'request:atlas/r1',
      source: 'request',
      kind: 'approval',
      at: iso(-4_000),
      title: 'Atlas',
      botId: 'atlas',
      requestId: 'r1',
    }
    const entries = new Map<string, FleetAttentionEntry>([
      [newsEntry.key, newsEntry],
      [waitingEntry.key, waitingEntry],
    ])
    controller.setServers([serverInput({ id: 's1', name: 'Office', snapshotSeq: 1, entries })])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })

    // Dismissing a WAITING item hides it locally but MUST NOT send seen to the gateway.
    const undoWaiting = controller.dismiss(inboxItemKey('s1', waitingEntry.key))
    expect(sendSeen).not.toHaveBeenCalled()
    expect(controller.getState().counts).toEqual({ waiting: 0, unread: 1, total: 1 })
    controller.restore(undoWaiting)
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })

    // Dismissing a NEWS item sends seen to the gateway.
    const undoNews = controller.dismiss(inboxItemKey('s1', newsEntry.key))
    expect(sendSeen).toHaveBeenCalledTimes(1)
    expect(sendSeen).toHaveBeenCalledWith('s1', [newsEntry.key])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 0, total: 1 })

    // Even after the gateway removes the news entry in response to `seen`, Undo restores it to `new` + counts.
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        snapshotSeq: 1,
        entries: new Map([[waitingEntry.key, waitingEntry]]),
      }),
    ])
    controller.restore(undoNews)
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    expect(controller.getState().items.find((i) => i.key === inboxItemKey('s1', newsEntry.key))?.group).toBe('new')
    controller.stop()
  })
})

describe('chat fallback for older desktop hosts on attention-capable gateways (S3)', () => {
  it('checks chat-attention-sync capability and merges active environment chat fallback alongside gateway entries', async () => {
    const oldEnv = environmentRecord({
      id: 'legacy-ws',
      name: 'Legacy Desk',
      kind: 'workspaces',
      capabilities: ['mobile-api'],
    })
    const newEnv = environmentRecord({
      id: 'new-ws',
      name: 'New Desk',
      kind: 'workspaces',
      capabilities: ['mobile-api', FLEET_CHAT_ATTENTION_SYNC_CAPABILITY],
    })
    const environments = [oldEnv, newEnv]

    expect(environmentNeedsChatFallback(environments, 'legacy-ws')).toBe(true)
    expect(environmentNeedsChatFallback(environments, 'new-ws')).toBe(false)
    expect(environmentNeedsChatFallback(environments, 'unknown')).toBe(false)
    expect(environmentNeedsChatFallback(environments, null)).toBe(false)

    const chatLists: MobileLists = {
      chats: [
        {
          id: 'c-ask',
          name: 'Need input',
          workspaceId: null,
          workspaceName: null,
          branch: null,
          status: 'asking',
          lastActivityAt: iso(-3_000),
          pinned: false,
          experience: 'standard',
        },
      ],
      workspaces: [],
    }
    const chatFallback = fallbackChatObservations({
      serverId: 's1',
      serverName: 'Office',
      environments,
      environmentId: 'legacy-ws',
      chatLists,
    })

    const { kv } = memoryStores()
    const controller = createInboxController({ kv, now: () => BASE_NOW, tickMs: 0 })
    await controller.start()
    controller.setServers([
      serverInput({
        id: 's1',
        name: 'Office',
        supportsAttention: true,
        loaded: true,
        snapshotSeq: 1,
        environments: new Map([
          ['legacy-ws', 'Legacy Desk'],
          ['new-ws', 'New Desk'],
        ]),
        entries: new Map([
          [
            'bot:atlas',
            {
              key: 'bot:atlas',
              source: 'bot',
              kind: 'finished',
              at: iso(-2_000),
              title: 'Atlas',
              botId: 'atlas',
            },
          ],
        ]),
        fallback: chatFallback,
      }),
    ])

    const items = controller.getState().items
    expect(items.map((item) => item.key)).toEqual(['s1|bot:atlas', 's1|chat:legacy-ws/c-ask'])
    expect(controller.getState().counts).toEqual({ waiting: 1, unread: 1, total: 2 })
    controller.stop()
  })
})

describe('inbox store slice subscriptions (S5)', () => {
  it('skips setServers on streamed transcript/view/runtime updates and fires on inbox-relevant changes', () => {
    let fleetState: FleetState = initialFleetState
    const fleetListeners = new Set<() => void>()
    const dispatchFleet = (action: FleetAction) => {
      fleetState = fleetReducer(fleetState, action)
      for (const listener of fleetListeners) listener()
    }
    const fleetStore = {
      getState: () => fleetState,
      subscribe: (listener: () => void) => {
        fleetListeners.add(listener)
        return () => fleetListeners.delete(listener)
      },
    }

    let chatsState: ChatsState = initialChatsState
    const chatsListeners = new Set<() => void>()
    const dispatchChats = (action: ChatsAction) => {
      chatsState = chatsReducer(chatsState, action)
      for (const listener of chatsListeners) listener()
    }
    const chatsStore = {
      getState: () => chatsState,
      subscribe: (listener: () => void) => {
        chatsListeners.add(listener)
        return () => chatsListeners.delete(listener)
      },
    }

    const setServersSpy = vi.fn()
    const unsubscribe = subscribeInboxStoreSlices(fleetStore, chatsStore, setServersSpy)

    // Transcript-only updates on fleet store must NOT invoke setServersSpy.
    dispatchFleet({
      type: 'transcript-page',
      botId: 'atlas',
      mode: 'latest',
      page: { items: [], before: null },
    })
    dispatchFleet({
      type: 'event',
      event: {
        type: 'transcript.upsert',
        at: iso(0),
        botId: 'atlas',
        item: { id: 'm1', kind: 'assistant', at: iso(0), text: 'streaming chunk 1', streaming: true },
      },
    })
    dispatchFleet({
      type: 'event',
      event: {
        type: 'transcript.upsert',
        at: iso(100),
        botId: 'atlas',
        item: { id: 'm2', kind: 'assistant', at: iso(100), text: 'streaming chunk 2', streaming: false },
      },
    })
    // Chat transcript & runtime streaming updates must NOT invoke setServersSpy.
    dispatchChats({
      type: 'runtime',
      conversationId: 'c1',
      runtime: { streaming: true, compacting: false, plan: null, context: null },
    })
    dispatchChats({
      type: 'items',
      conversationId: 'c1',
      items: [{ id: 'cm1', kind: 'assistant', at: iso(200), text: 'hello', streaming: false }],
    })
    expect(setServersSpy).not.toHaveBeenCalled()

    // Relevant fleet changes (connection, inbox, bots, environments) DO trigger setServersSpy.
    dispatchFleet({ type: 'connection', state: 'open', retryAt: null })
    expect(setServersSpy).toHaveBeenCalledTimes(1)

    dispatchFleet({
      type: 'snapshot',
      bots: [botRecord({ id: 'atlas', name: 'Atlas' })],
      environments: [environmentRecord({ id: 'studio', name: 'Studio' })],
      inbox: [],
    })
    expect(setServersSpy).toHaveBeenCalledTimes(2)

    // Relevant chat lists changes DO trigger setServersSpy.
    dispatchChats({ type: 'lists', lists: { chats: [], workspaces: [] } })
    expect(setServersSpy).toHaveBeenCalledTimes(3)

    // Structural fallback equality check without JSON.stringify.
    const obsA = fallbackChatObservations({
      serverId: 's1',
      serverName: 'Office',
      environments: [environmentRecord({ id: 'p', name: 'Personal', kind: 'workspaces' })],
      environmentId: 'p',
      chatLists: {
        chats: [
          {
            id: 'c1',
            name: 'Chat 1',
            workspaceId: null,
            workspaceName: null,
            branch: null,
            status: 'asking',
            lastActivityAt: iso(0),
            pinned: false,
            experience: 'standard',
          },
        ],
        workspaces: [],
      },
    })
    const obsB = fallbackChatObservations({
      serverId: 's1',
      serverName: 'Office',
      environments: [environmentRecord({ id: 'p', name: 'Personal', kind: 'workspaces' })],
      environmentId: 'p',
      chatLists: {
        chats: [
          {
            id: 'c1',
            name: 'Chat 1',
            workspaceId: null,
            workspaceName: null,
            branch: null,
            status: 'asking',
            lastActivityAt: iso(0),
            pinned: false,
            experience: 'standard',
          },
        ],
        workspaces: [],
      },
    })
    expect(sameFallbackObservations(obsA, obsB)).toBe(true)
    expect(sameFallbackObservations(obsA, [])).toBe(false)

    unsubscribe()
  })
})
