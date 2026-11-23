import { createHash } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ATTENTION_LIMITS,
  FLEET_BOT_DELEGATION_DEFAULT,
  FLEET_CHAT_ATTENTION_SYNC_CAPABILITY,
  FLEET_META_FEATURES_LEGACY_MAX,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  FLEET_PROTOCOL_HEADER,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  FLEET_WORKSPACES_HOST_FEATURE,
  fleetAttentionKey,
  fleetAttentionSnapshotSchema,
  fleetAttentionUpdatedEventSchema,
  fleetChatAttentionClearRequestSchema,
  type FleetAttentionUpdatedEvent,
  type FleetBot,
  type FleetChatAttentionKind,
  type FleetGatewayEvent,
  type FleetInstanceEvent,
  type FleetPendingInteraction,
} from '@maestrly/bot-fleet-protocol'
import { AttentionStore } from '../src/attention.js'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { EventHub } from '../src/events.js'
import { HostMonitor } from '../src/host.js'
import { InstanceClient } from '../src/instance.js'
import { Lifecycle } from '../src/lifecycle.js'
import { PushNotifier, type PushMessage } from '../src/push.js'
import { createGatewayServers } from '../src/server.js'
import { Store } from '../src/store.js'

const dirs: string[] = []
const closeFns: Array<() => Promise<void>> = []

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-attention-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const close of closeFns.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

const ts = (second: number) => `2026-11-23T12:00:${String(second).padStart(2, '0')}.000Z`

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function botRecord(id: string, name: string): FleetBot {
  return {
    id,
    name,
    role: '',
    instructions: 'Synthetic instructions',
    tint: '#4978c6',
    ceiling: 'ask',
    selection: null,
    compaction: null,
    compactionSource: null,
    compactionState: null,
    talksTo: [],
    publishArtifacts: false,
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'offline',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: {
      memoryBytes: null,
      memoryLimitBytes: null,
      cpuPercent: null,
      startedAt: null,
      swapBytes: null,
      oomKills: null,
      limitOoms: null,
    },
    screen: { width: 1280, height: 800, display: ':0' },
    appVersion: null,
    capabilities: [],
    usage: null,
    environmentId: null,
    move: null,
    runSettings: FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
    runningRun: null,
    turns: null,
    avatar: null,
    position: null,
    peerSettings: FLEET_PEER_THREAD_SETTINGS_DEFAULT,
    delegation: FLEET_BOT_DELEGATION_DEFAULT,
    sharedFiles: null,
    storage: null,
    createdAt: ts(1),
    updatedAt: ts(1),
  }
}

function seedBot(store: Store, id: string, name: string): FleetBot {
  const bot = botRecord(id, name)
  store.insertBot(bot, {
    controlToken: 'synthetic-control-' + id,
    keyringPassword: 'synthetic-keyring-' + id,
    gatewayToken: 'synthetic-gateway-' + id,
    gatewayTokenSha256: hash('synthetic-gateway-' + id),
  })
  return bot
}

function pending(
  kind: 'permission' | 'question' | 'help',
  id: string,
  at: string,
  runId?: string
): FleetPendingInteraction {
  const base = { id, at, itemId: 'item-' + id, ...(runId ? { runId } : {}) }
  if (kind === 'permission') return { ...base, kind, title: 'Approve tool', detail: null, tool: null }
  if (kind === 'question') return { ...base, kind, questions: [] }
  return { ...base, kind, reason: 'Need input' }
}

function botActivity(
  botId: string,
  kind: 'turn_completed' | 'turn_failed' | 'bot_failed',
  at: string,
  data: Record<string, string | number | boolean | null> = {},
  seq = 1
): FleetGatewayEvent {
  return {
    type: 'activity',
    at,
    entry: { seq, at, botId, environmentId: null, kind, summary: null, data },
  }
}

type FakeWorkspacesHost = {
  origin: string
  capabilities: string[]
  requests: Array<{ method: string; path: string }>
  clearRequests: Array<{ conversationIds: string[] }>
  clearHandler: (conversationIds: string[]) => Promise<{ status: number; body?: { cleared: string[] } } | 'drop'>
  subscriptions: ServerResponse[]
  emit: (event: Omit<FleetInstanceEvent, 'seq' | 'at'> & { seq?: number; at?: string }) => void
  dropStreams: () => void
}

async function createWorkspacesHost(capabilities: string[]): Promise<FakeWorkspacesHost> {
  let seq = 0
  const state: FakeWorkspacesHost = {
    origin: '',
    capabilities: [...capabilities],
    requests: [],
    clearRequests: [],
    clearHandler: async (conversationIds) => ({ status: 200, body: { cleared: conversationIds } }),
    subscriptions: [],
    emit: (event) => {
      const full = {
        seq: event.seq ?? ++seq,
        at: event.at ?? new Date().toISOString(),
        ...event,
      }
      const frame = 'event: fleet\ndata: ' + JSON.stringify(full) + '\n\n'
      for (const res of [...state.subscriptions]) {
        if (res.destroyed) state.subscriptions = state.subscriptions.filter((item) => item !== res)
        else res.write(frame)
      }
    },
    dropStreams: () => {
      for (const res of state.subscriptions.splice(0)) res.end()
    },
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    state.requests.push({ method: req.method ?? 'GET', path: url })
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url === '/v1/health') {
      return sendJson(200, {
        ok: true,
        appVersion: '1.0.0',
        protocol: 1,
        ready: true,
        capabilities: state.capabilities,
      })
    }
    if (url === '/v1/environment/status') {
      return sendJson(200, {
        environmentId: null,
        capabilities: state.capabilities,
        appVersion: '1.0.0',
        protocol: 1,
        ready: true,
        bots: [],
      })
    }
    if (url.startsWith('/v1/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      state.subscriptions.push(res)
      res.on('close', () => {
        state.subscriptions = state.subscriptions.filter((item) => item !== res)
      })
      return
    }
    if (url === '/v1/chat-attention/clear' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const parsed = fleetChatAttentionClearRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      state.clearRequests.push(parsed)
      const reply = await state.clearHandler(parsed.conversationIds)
      if (reply === 'drop') {
        req.socket.destroy()
        return
      }
      return sendJson(reply.status, reply.body ?? { code: 'INTERNAL', message: 'Failed' })
    }
    return sendJson(404, { code: 'NOT_FOUND', message: 'Not found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  closeFns.push(async () => {
    state.dropStreams()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return state
}

async function createGatewayHarness(hosts: Map<string, FakeWorkspacesHost> = new Map()) {
  const dir = tempDir()
  const store = new Store(dir)
  const auth = new Auth(store)
  const docker = new FakeDockerDriver()
  const config = {
    ...loadConfig({
      MAESTRLY_GATEWAY_DATA_DIR: dir,
      MAESTRLY_GATEWAY_PUBLIC_HOST: '127.0.0.1',
      MAESTRLY_GATEWAY_DISPLAY_NAME: 'home-lab',
    }),
    publicPort: 0,
    internalPort: 0,
  }
  docker.images.add(config.botImage)
  const lifecycle = new Lifecycle(
    store,
    docker,
    config,
    (environmentId, secret) => {
      const host = hosts.get(environmentId)
      if (!host) throw new Error(`No synthetic host registered for ${environmentId}`)
      return new InstanceClient(environmentId, secret, host.origin, 2000)
    },
    5000
  )
  lifecycle.locateGateway = async () => 'maestrly-bot-gateway'
  const events = new EventHub(async () => {})
  lifecycle.onEvent = (event) => events.emit(event)

  const sentPushes: PushMessage[][] = []
  let attentionRef: AttentionStore | null = null
  const push = new PushNotifier({
    store,
    sender: {
      send: async (messages) => {
        sentPushes.push(messages)
        return messages.map(() => ({ ok: true }))
      },
    },
    serverName: () => 'home-lab',
    attentionCount: () => attentionRef?.size ?? 0,
  })

  const servers = createGatewayServers({
    auth,
    config,
    events,
    host: new HostMonitor(config, docker, '0.42.0'),
    lifecycle,
    store,
    push,
  })
  attentionRef = servers.attention
  await servers.listen()
  const origin = `http://127.0.0.1:${(servers.publicServer.address() as { port: number }).port}`
  const paired = auth.pair(auth.createPairing().code, 'Phone', '127.0.0.1', { kind: 'phone', platform: 'ios' })

  closeFns.push(async () => {
    await servers.close()
    store.close()
  })

  const request = (method: string, routePath: string, body?: unknown, token: string | null = paired.token) =>
    fetch(origin + routePath, {
      method,
      headers: {
        [FLEET_PROTOCOL_HEADER]: '1',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  return {
    dir,
    store,
    auth,
    lifecycle,
    events,
    attention: servers.attention,
    origin,
    token: paired.token,
    sentPushes,
    request,
  }
}

describe('schema 26 migration and persistence', () => {
  it('migrates a schema 25 database cleanly, preserving push registrations and adding attention_entries + badge_others', () => {
    const dir = tempDir()
    const initial = new Store(dir)
    const auth = new Auth(initial)
    const paired = auth.pair(auth.createPairing().code, 'Phone', '127.0.0.1')
    // Simulate a schema 25 database (no attention_entries, no badge_others column on push_registrations).
    initial.db.exec('DROP TABLE attention_entries')
    initial.db.exec('ALTER TABLE push_registrations DROP COLUMN badge_others')
    initial.db
      .prepare(
        'INSERT INTO push_registrations(device_id,provider,token,platform,locale,preferences_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(
        paired.deviceId,
        'expo',
        'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
        'ios',
        'en',
        JSON.stringify({ waiting: true, replies: true, routines: true, errors: true }),
        ts(1),
        ts(1)
      )
    initial.db.prepare("UPDATE meta SET value='25' WHERE key='schema_version'").run()
    initial.close()

    const migrated = new Store(dir)
    expect(migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '26' })
    const existing = migrated.pushRegistration(paired.deviceId)
    expect(existing).toMatchObject({
      provider: 'expo',
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
    })
    expect(existing?.badgeOthers).toBeUndefined()

    const saved = migrated.savePushRegistration(paired.deviceId, {
      provider: 'expo',
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
      locale: 'en',
      preferences: { waiting: true, replies: true, routines: true, errors: true },
      badgeOthers: 4,
    })
    expect(saved.badgeOthers).toBe(4)

    const zero = migrated.savePushRegistration(paired.deviceId, {
      provider: 'expo',
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
      locale: 'en',
      preferences: { waiting: true, replies: true, routines: true, errors: true },
      badgeOthers: 0,
    })
    expect(zero.badgeOthers).toBe(0)

    const omitted = migrated.savePushRegistration(paired.deviceId, {
      provider: 'expo',
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
      locale: 'en',
      preferences: { waiting: true, replies: true, routines: true, errors: true },
    })
    expect(omitted.badgeOthers).toBeUndefined()
    migrated.close()
  })
})

describe('AttentionStore', () => {
  it('maps every chat attention kind, handles cleared + snapshot replacement, and ignores envs without capability', () => {
    const dir = tempDir()
    const store = new Store(dir)
    const capableEnvs = new Set(['env-a', 'env-b'])
    const deltas: FleetAttentionUpdatedEvent[] = []
    const attention = new AttentionStore({
      store,
      environmentHasChatSync: (id) => capableEnvs.has(id),
      onUpdate: (event) => deltas.push(event),
      now: () => ts(59),
    })

    // Env without capability is completely ignored.
    attention.chatAttention('legacy-env', 'c0', 'Legacy chat', 'waiting', ts(1))
    attention.chatAttentionSnapshot('legacy-env', [{ conversationId: 'c0', name: 'Legacy', kind: 'plan', at: ts(1) }])
    attention.chatAttentionCleared('legacy-env', 'c0')
    expect(attention.size).toBe(0)
    expect(deltas).toEqual([])

    const kinds: Array<[FleetChatAttentionKind, string]> = [
      ['waiting', 'approval'],
      ['question', 'question'],
      ['plan', 'plan'],
      ['finished', 'finished'],
      ['failed', 'error'],
    ]
    kinds.forEach(([inputKind, expectedKind], idx) => {
      attention.chatAttention('env-a', `c${idx}`, `Chat ${idx}`, inputKind, ts(idx + 1))
      const entry = attention.snapshot().entries.find((item) => item.key === fleetAttentionKey.chat('env-a', `c${idx}`))
      expect(entry).toEqual({
        key: `chat:env-a/c${idx}`,
        source: 'chat',
        kind: expectedKind,
        at: ts(idx + 1),
        title: `Chat ${idx}`,
        environmentId: 'env-a',
        conversationId: `c${idx}`,
      })
    })

    // Another environment is isolated.
    attention.chatAttention('env-b', 'b1', 'Other env', 'question', ts(10))
    expect(attention.size).toBe(6)

    // Duplicate event emits nothing.
    const countBefore = deltas.length
    attention.chatAttention('env-a', 'c0', 'Chat 0', 'waiting', ts(1))
    expect(deltas.length).toBe(countBefore)

    // Clear removes entry; clearing again is a no-op.
    attention.chatAttentionCleared('env-a', 'c4')
    expect(attention.size).toBe(5)
    expect(deltas.at(-1)).toEqual({ type: 'attention.updated', upsert: [], remove: ['chat:env-a/c4'] })
    const afterClear = deltas.length
    attention.chatAttentionCleared('env-a', 'c4')
    expect(deltas.length).toBe(afterClear)

    // Snapshot replaces only env-a's chats (keeps unchanged c1, removes c0/c2/c3, upserts c9), leaving env-b intact.
    attention.chatAttentionSnapshot('env-a', [
      { conversationId: 'c1', name: 'Chat 1', kind: 'question', at: ts(2) },
      { conversationId: 'c9', name: 'Fresh chat', kind: 'plan', at: ts(20) },
      // Duplicate id in snapshot: newer entry wins.
      { conversationId: 'c9', name: 'Fresh chat v2', kind: 'finished', at: ts(21) },
    ])
    expect(attention.snapshot().entries.map((item) => [item.key, item.kind, item.title])).toEqual([
      ['chat:env-a/c9', 'finished', 'Fresh chat v2'],
      ['chat:env-b/b1', 'question', 'Other env'],
      ['chat:env-a/c1', 'question', 'Chat 1'],
    ])
    const snapshotDelta = deltas.at(-1)!
    expect(snapshotDelta.upsert.map((e) => e.key)).toEqual(['chat:env-a/c9'])
    expect(snapshotDelta.remove.sort()).toEqual(['chat:env-a/c0', 'chat:env-a/c2', 'chat:env-a/c3'])

    // Removing env-b drops only env-b's chats.
    attention.observe({ type: 'environment.removed', at: ts(30), environmentId: 'env-b' })
    expect(attention.snapshot().entries.map((item) => item.key)).toEqual(['chat:env-a/c9', 'chat:env-a/c1'])
    store.close()
  })

  it('tracks bot turns, failures, and pending requests, and persists across restart while rebuilding requests', async () => {
    const dir = tempDir()
    const store = new Store(dir)
    seedBot(store, 'atlas', 'Atlas')
    seedBot(store, 'ledger', 'Ledger')

    const attention = new AttentionStore({
      store,
      environmentHasChatSync: () => true,
      now: () => ts(59),
    })

    // Ignored bot activities: peer source, quiet routine, unknown bot.
    attention.observe(botActivity('atlas', 'turn_completed', ts(1), { source: 'peer' }, 1))
    attention.observe(
      botActivity('atlas', 'turn_completed', ts(2), { source: 'routine', runId: 'r0', alert: false }, 2)
    )
    attention.observe(botActivity('ghost', 'turn_completed', ts(3), { source: 'owner' }, 3))
    expect(attention.size).toBe(0)

    // Routine report (alert !== false) includes runId.
    attention.observe(botActivity('atlas', 'turn_completed', ts(4), { source: 'routine', runId: 'run-42' }, 4))
    expect(attention.snapshot().entries).toEqual([
      { key: 'bot:atlas', source: 'bot', kind: 'finished', at: ts(4), title: 'Atlas', botId: 'atlas', runId: 'run-42' },
    ])

    // Latest wins per bot: owner turn replaces routine runId.
    attention.observe(botActivity('atlas', 'turn_completed', ts(5), { source: 'owner' }, 5))
    expect(attention.snapshot().entries).toEqual([
      { key: 'bot:atlas', source: 'bot', kind: 'finished', at: ts(5), title: 'Atlas', botId: 'atlas' },
    ])

    // Peer thread turn surfaces threadId (not runId).
    attention.observe(
      botActivity('atlas', 'turn_completed', ts(6), { source: 'owner', runId: 'th-1', threadId: 'th-1' }, 6)
    )
    expect(attention.snapshot().entries[0]).toMatchObject({ key: 'bot:atlas', threadId: 'th-1' })
    expect(attention.snapshot().entries[0].runId).toBeUndefined()

    // turn_failed / bot_failed -> error.
    attention.observe(botActivity('ledger', 'turn_failed', ts(7), {}, 7))
    expect(attention.snapshot().entries.find((e) => e.key === 'bot:ledger')).toMatchObject({
      kind: 'error',
      title: 'Ledger',
    })
    attention.observe(botActivity('ledger', 'bot_failed', ts(8), {}, 8))
    expect(attention.snapshot().entries.find((e) => e.key === 'bot:ledger')).toMatchObject({
      kind: 'error',
      at: ts(8),
    })

    // Requests mirror inbox.updated.
    attention.observe({
      type: 'inbox.updated',
      at: ts(9),
      items: [
        { botId: 'atlas', interaction: pending('permission', 'p1', ts(9), 'run-9') },
        { botId: 'atlas', interaction: pending('question', 'q1', ts(10)) },
        { botId: 'ledger', interaction: pending('help', 'h1', ts(11)) },
      ],
    })
    expect(
      attention
        .snapshot()
        .entries.filter((e) => e.source === 'request')
        .map((e) => [e.key, e.kind, e.runId ?? null])
    ).toEqual([
      ['request:ledger/h1', 'help', null],
      ['request:atlas/q1', 'question', null],
      ['request:atlas/p1', 'approval', 'run-9'],
    ])

    // Add a chat entry too, then simulate a full gateway restart (reopening SQLite).
    attention.chatAttention('work', 'c1', 'Deploy PR', 'plan', ts(12))
    store.close()

    const reopened = new Store(dir)
    const restarted = new AttentionStore({
      store: reopened,
      environmentHasChatSync: () => true,
      // On restart, only p1 is still pending in live inbox; q1 and h1 are gone.
      initialInbox: [{ botId: 'atlas', interaction: pending('permission', 'p1', ts(9), 'run-9') }],
    })
    expect(
      restarted
        .snapshot()
        .entries.map((e) => e.key)
        .sort()
    ).toEqual(['bot:atlas', 'bot:ledger', 'chat:work/c1', 'request:atlas/p1'])

    // Deleting a bot removes both its bot entry and its pending requests.
    restarted.observe({ type: 'bot.removed', at: ts(20), botId: 'atlas' })
    expect(
      restarted
        .snapshot()
        .entries.map((e) => e.key)
        .sort()
    ).toEqual(['bot:ledger', 'chat:work/c1'])

    // Unknown/malformed keys in seen are safe no-ops.
    expect(
      await restarted.seen({
        keys: ['bot:nobody', 'not-a-key', 'chat:', 'request:ledger/h1', 'bot:ledger', 'bot:ledger'],
      })
    ).toEqual({ cleared: ['bot:ledger'] })
    expect(restarted.snapshot().entries.map((e) => e.key)).toEqual(['chat:work/c1'])
    reopened.close()
  })

  it('handles snapshot interleaving with incremental events, many environments, and entriesMax eviction', () => {
    const dir = tempDir()
    const store = new Store(dir)
    const deltas: FleetAttentionUpdatedEvent[] = []
    const attention = new AttentionStore({
      store,
      environmentHasChatSync: () => true,
      onUpdate: (event) => {
        // Every emitted delta must satisfy the strict protocol schema.
        fleetAttentionUpdatedEventSchema.parse(event)
        deltas.push(event)
      },
      maxEntries: 5,
    })

    // Interleave incremental events and snapshots across 6 environments while enforcing maxEntries = 5.
    for (let i = 1; i <= 6; i++) {
      attention.chatAttention(`env-${i}`, `c-${i}`, `Chat ${i}`, 'question', ts(i))
    }
    expect(attention.size).toBe(5)
    // Oldest (env-1/c-1 at ts(1)) was evicted.
    expect(attention.snapshot().entries.map((e) => e.key)).not.toContain('chat:env-1/c-1')
    expect(attention.snapshot().entries.map((e) => e.key)).toContain('chat:env-6/c-6')

    // Snapshot arriving for env-2 while incremental events stream for env-6.
    attention.chatAttentionSnapshot('env-2', [{ conversationId: 'c-2b', name: 'Replaced', kind: 'plan', at: ts(10) }])
    attention.chatAttention('env-6', 'c-6b', 'Streaming', 'finished', ts(11))
    expect(attention.size).toBe(5)
    expect(attention.snapshot().entries.map((e) => e.key)).toContain('chat:env-2/c-2b')
    expect(attention.snapshot().entries.map((e) => e.key)).not.toContain('chat:env-2/c-2')
    expect(attention.snapshot().entries.map((e) => e.key)).toContain('chat:env-6/c-6b')

    // Evictions are persisted to SQLite across restart.
    store.close()
    const reopened = new Store(dir)
    expect(reopened.listAttentionEntries()).toHaveLength(5)
    reopened.close()

    // Also verify the real protocol limit FLEET_ATTENTION_LIMITS.entriesMax (2000).
    const fullDir = tempDir()
    const fullStore = new Store(fullDir)
    const full = new AttentionStore({
      store: fullStore,
      environmentHasChatSync: () => true,
      onUpdate: (event) => {
        fleetAttentionUpdatedEventSchema.parse(event)
      },
    })
    const batch = Array.from({ length: FLEET_ATTENTION_LIMITS.entriesMax }, (_, i) => ({
      conversationId: `c-${i}`,
      name: `Chat ${i}`,
      kind: 'finished' as const,
      at: new Date(Date.parse('2026-11-23T00:00:00.000Z') + i * 1000).toISOString(),
    }))
    full.chatAttentionSnapshot('bulk-1', batch)
    expect(full.size).toBe(FLEET_ATTENTION_LIMITS.entriesMax)
    full.chatAttention('bulk-2', 'newest', 'Newest', 'waiting', '2026-11-23T23:59:59.000Z')
    expect(full.size).toBe(FLEET_ATTENTION_LIMITS.entriesMax)
    expect(fleetAttentionSnapshotSchema.parse(full.snapshot()).entries).toHaveLength(FLEET_ATTENTION_LIMITS.entriesMax)
    expect(full.snapshot().entries[0].key).toBe('chat:bulk-2/newest')
    expect(full.snapshot().entries.some((e) => e.key === 'chat:bulk-1/c-0')).toBe(false)
    fullStore.close()
  })
})

describe('gateway attention routes, SSE, /v1/meta, instance sync, and push badge', () => {
  it('advertises attention only in moreFeatures and keeps legacy features <= 20', async () => {
    const h = await createGatewayHarness()
    const res = await fetch(h.origin + '/v1/meta')
    expect(res.status).toBe(200)
    const meta = (await res.json()) as { features: string[]; moreFeatures: string[] }
    expect(meta.features.length).toBeLessThanOrEqual(FLEET_META_FEATURES_LEGACY_MAX)
    expect(meta.features).not.toContain(FLEET_ATTENTION_FEATURE)
    expect(meta.moreFeatures).toContain(FLEET_ATTENTION_FEATURE)
  })

  it('enforces auth and schema validation on /v1/attention and /v1/attention/seen', async () => {
    const h = await createGatewayHarness()
    expect((await h.request('GET', '/v1/attention', undefined, null)).status).toBe(401)
    expect((await h.request('POST', '/v1/attention/seen', { keys: ['bot:a'] }, null)).status).toBe(401)
    expect((await h.request('POST', '/v1/attention/seen', { keys: [] })).status).toBe(400)
    expect(
      (
        await h.request('POST', '/v1/attention/seen', {
          keys: Array.from({ length: FLEET_ATTENTION_LIMITS.seenKeysMax + 1 }, (_, i) => `bot:b${i}`),
        })
      ).status
    ).toBe(400)
    expect((await h.request('POST', '/v1/attention/seen', { keys: ['bot:a'], extra: true })).status).toBe(400)

    const initial = await h.request('GET', '/v1/attention')
    expect(initial.status).toBe(200)
    expect(fleetAttentionSnapshotSchema.parse(await initial.json())).toMatchObject({ entries: [] })
  })

  it('routes seen per source, forwards chat clears to capable hosts, and tolerates unreachable hosts without 5xx', async () => {
    const hostA = await createWorkspacesHost([FLEET_WORKSPACES_HOST_FEATURE, FLEET_CHAT_ATTENTION_SYNC_CAPABILITY])
    const hostDown = await createWorkspacesHost([FLEET_WORKSPACES_HOST_FEATURE, FLEET_CHAT_ATTENTION_SYNC_CAPABILITY])
    const hostLegacy = await createWorkspacesHost([FLEET_WORKSPACES_HOST_FEATURE])

    // hostA clears c1 (still-waiting c2 is refused by host); hostDown drops the connection.
    hostA.clearHandler = async (ids) => ({ status: 200, body: { cleared: ids.filter((id) => id === 'c1') } })
    hostDown.clearHandler = async () => 'drop'

    const hosts = new Map([
      ['env-a', hostA],
      ['env-down', hostDown],
      ['env-legacy', hostLegacy],
    ])
    const h = await createGatewayHarness(hosts)
    seedBot(h.store, 'atlas', 'Atlas')

    h.lifecycle.createEnvironment({ name: 'Env A', memoryLimitBytes: null, kind: 'workspaces' })
    h.lifecycle.createEnvironment({ name: 'Env Down', memoryLimitBytes: null, kind: 'workspaces' })
    h.lifecycle.createEnvironment({ name: 'Env Legacy', memoryLimitBytes: null, kind: 'workspaces' })

    await until(
      () =>
        h.lifecycle.environment('env-a')?.lifecycle === 'running' &&
        h.lifecycle.environment('env-down')?.lifecycle === 'running' &&
        h.lifecycle.environment('env-legacy')?.lifecycle === 'running'
    )
    await until(
      () => hostA.subscriptions.length > 0 && hostDown.subscriptions.length > 0 && hostLegacy.subscriptions.length > 0
    )

    // Verify instance events query: chatAttention=2 ONLY with capability, 1 otherwise.
    expect(hostA.requests.find((r) => r.path.startsWith('/v1/events'))?.path).toContain('chatAttention=2')
    expect(hostDown.requests.find((r) => r.path.startsWith('/v1/events'))?.path).toContain('chatAttention=2')
    expect(hostLegacy.requests.find((r) => r.path.startsWith('/v1/events'))?.path).toContain('chatAttention=1')

    // Connect snapshot (with seq: 0!) populates env-a and env-down; legacy chat is ignored by AttentionStore.
    hostA.emit({
      seq: 0,
      type: 'chat.attention.snapshot',
      botId: null,
      conversations: [
        { conversationId: 'c1', name: 'Done chat', kind: 'finished', at: ts(1) },
        { conversationId: 'c2', name: 'Waiting chat', kind: 'waiting', at: ts(2) },
      ],
    })
    hostDown.emit({
      seq: 0,
      type: 'chat.attention.snapshot',
      botId: null,
      conversations: [{ conversationId: 'd1', name: 'Down chat', kind: 'finished', at: ts(3) }],
    })
    hostLegacy.emit({
      type: 'chat.attention',
      botId: null,
      conversationId: 'leg-1',
      name: 'Legacy chat',
      kind: 'question',
    })
    h.events.emit(botActivity('atlas', 'turn_completed', ts(4), { source: 'owner' }, 1))
    h.events.emit({
      type: 'inbox.updated',
      at: ts(5),
      items: [{ botId: 'atlas', interaction: pending('permission', 'req-1', ts(5)) }],
    })

    await until(() => h.attention.size === 5)
    expect(h.attention.snapshot().entries.some((e) => e.environmentId === 'env-legacy')).toBe(false)

    // Open two SSE streams: one WITHOUT attention=1, one WITH attention=1.
    const plainCtrl = new AbortController()
    const optInCtrl = new AbortController()
    closeFns.push(async () => {
      plainCtrl.abort()
      optInCtrl.abort()
    })
    const plainFrames: Array<{ type: string; [key: string]: unknown }> = []
    const optInFrames: Array<{ type: string; [key: string]: unknown }> = []
    const readStream = async (
      urlPath: string,
      signal: AbortSignal,
      sink: Array<{ type: string; [key: string]: unknown }>
    ) => {
      const response = await fetch(h.origin + urlPath, {
        headers: { [FLEET_PROTOCOL_HEADER]: '1', authorization: 'Bearer ' + h.token },
        signal,
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          buf += decoder.decode(part.value, { stream: true })
          let boundary = buf.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buf.slice(0, boundary)
            buf = buf.slice(boundary + 2)
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
            if (dataLine) sink.push(JSON.parse(dataLine.slice(5).trimStart()))
            boundary = buf.indexOf('\n\n')
          }
        }
      } catch {}
    }
    void readStream('/v1/events', plainCtrl.signal, plainFrames)
    void readStream('/v1/events?attention=1', optInCtrl.signal, optInFrames)
    await until(() => plainFrames.some((f) => f.type === 'hello') && optInFrames.some((f) => f.type === 'hello'))

    const seqBefore = h.store.lastActivitySeq()

    // POST /v1/attention/seen with bot, request, reachable chats (c1 cleared, c2 kept), unreachable chat, legacy chat.
    const seenRes = await h.request('POST', '/v1/attention/seen', {
      keys: [
        'bot:atlas',
        'request:atlas/req-1',
        'chat:env-a/c1',
        'chat:env-a/c2',
        'chat:env-down/d1',
        'chat:env-legacy/leg-1',
        'bot:unknown',
      ],
    })
    expect(seenRes.status).toBe(200)
    expect(await seenRes.json()).toEqual({ cleared: ['bot:atlas', 'chat:env-a/c1'] })

    // hostA received grouped clear; hostLegacy was NOT called.
    expect(hostA.clearRequests).toEqual([{ conversationIds: ['c1', 'c2'] }])
    expect(hostLegacy.clearRequests).toEqual([])

    // Local store: bot:atlas removed immediately, request:atlas/req-1 stayed, chat:env-a/c1 NOT removed locally yet!
    const midSnapshot = await (await h.request('GET', '/v1/attention')).json()
    expect(midSnapshot.entries.map((e: { key: string }) => e.key).sort()).toEqual([
      'chat:env-a/c1',
      'chat:env-a/c2',
      'chat:env-down/d1',
      'request:atlas/req-1',
    ])

    // Now hostA emits chat.attention.cleared for c1 (c2 stays waiting).
    hostA.emit({ type: 'chat.attention.cleared', botId: null, conversationId: 'c1' })
    await until(() =>
      optInFrames.some(
        (frame) => frame.type === 'attention.updated' && (frame.remove as string[]).includes('chat:env-a/c1')
      )
    )

    // Emit a normal gateway event so we know plainFrames drained past the attention updates.
    h.events.emit({ type: 'transcript.reset', at: ts(20), botId: 'atlas' })
    await until(
      () =>
        plainFrames.some((f) => f.type === 'transcript.reset') && optInFrames.some((f) => f.type === 'transcript.reset')
    )

    // Reader WITHOUT attention=1 NEVER receives attention.updated; reader WITH attention=1 receives valid deltas.
    expect(plainFrames.some((f) => f.type === 'attention.updated')).toBe(false)
    const attentionFrames = optInFrames.filter((f) => f.type === 'attention.updated')
    expect(attentionFrames.length).toBeGreaterThanOrEqual(2)
    for (const frame of attentionFrames) fleetAttentionUpdatedEventSchema.parse(frame)
    // attention.updated is not part of activity seq replay.
    expect(h.store.lastActivitySeq()).toBe(seqBefore)

    // All-unreachable host still returns 200 with empty cleared.
    const onlyDown = await h.request('POST', '/v1/attention/seen', { keys: ['chat:env-down/d1'] })
    expect(onlyDown.status).toBe(200)
    expect(await onlyDown.json()).toEqual({ cleared: [] })
  })

  it('re-queries with chatAttention=2 on host reconnect after capability upgrade and replaces chats from snapshot', async () => {
    const host = await createWorkspacesHost([FLEET_WORKSPACES_HOST_FEATURE])
    const h = await createGatewayHarness(new Map([['work', host]]))

    h.lifecycle.createEnvironment({ name: 'Work', memoryLimitBytes: null, kind: 'workspaces' })
    await until(() => h.lifecycle.environment('work')?.lifecycle === 'running')
    await until(() => host.subscriptions.length === 1)
    expect(host.requests.filter((r) => r.path.startsWith('/v1/events')).map((r) => r.path)).toEqual([
      expect.stringContaining('chatAttention=1'),
    ])

    // Host upgrades and drops stream; on reconnect health advertises chat-attention-sync -> gateway uses chatAttention=2.
    host.capabilities.push(FLEET_CHAT_ATTENTION_SYNC_CAPABILITY)
    host.dropStreams()
    await until(() => host.requests.filter((r) => r.path.startsWith('/v1/events')).length >= 2, 5000)
    const secondQuery = host.requests.filter((r) => r.path.startsWith('/v1/events'))[1].path
    expect(secondQuery).toContain('chatAttention=2')

    // Host sends connect snapshot (seq: 0) then incremental event (seq: 1), then reconnects with seq reset (seq: 0 + seq: 1).
    host.emit({
      seq: 0,
      type: 'chat.attention.snapshot',
      botId: null,
      conversations: [{ conversationId: 'c1', name: 'First', kind: 'question', at: ts(1) }],
    })
    host.emit({ seq: 1, type: 'chat.attention', botId: null, conversationId: 'c2', name: 'Second', kind: 'plan' })
    await until(() => h.attention.size === 2)

    // Reconnect: host sends fresh snapshot replacing c1/c2 with c3, then incremental c4 with seq: 1 (<= prior seq 1).
    host.dropStreams()
    await until(() => host.requests.filter((r) => r.path.startsWith('/v1/events')).length >= 3, 5000)
    host.emit({
      seq: 0,
      type: 'chat.attention.snapshot',
      botId: null,
      conversations: [{ conversationId: 'c3', name: 'After reconnect', kind: 'finished', at: ts(10) }],
    })
    host.emit({ seq: 1, type: 'chat.attention', botId: null, conversationId: 'c4', name: 'Post reset', kind: 'failed' })
    await until(
      () =>
        h.attention.size === 2 &&
        h.attention.snapshot().entries.some((e) => e.key === 'chat:work/c3') &&
        h.attention.snapshot().entries.some((e) => e.key === 'chat:work/c4')
    )
    expect(
      h.attention
        .snapshot()
        .entries.map((e) => e.key)
        .sort()
    ).toEqual(['chat:work/c3', 'chat:work/c4'])
  })

  it('computes push badge = attentionStore.size + (badgeOthers ?? 0) AFTER applying the triggering event', async () => {
    const host = await createWorkspacesHost([FLEET_WORKSPACES_HOST_FEATURE, FLEET_CHAT_ATTENTION_SYNC_CAPABILITY])
    const h = await createGatewayHarness(new Map([['work', host]]))
    seedBot(h.store, 'atlas', 'Atlas')

    // Pair a second phone that does not send badgeOthers (legacy phone).
    const legacyPhone = h.auth.pair(h.auth.createPairing().code, 'Old Phone', '127.0.0.1', {
      kind: 'phone',
      platform: 'android',
    })

    expect(
      (
        await h.request('PUT', '/v1/devices/self/push', {
          provider: 'expo',
          token: 'ExponentPushToken[newphone111111111111]',
          platform: 'ios',
          locale: 'en',
          preferences: { waiting: true, replies: true, routines: true, errors: true },
          badgeOthers: 3,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await h.request(
          'PUT',
          '/v1/devices/self/push',
          {
            provider: 'expo',
            token: 'ExponentPushToken[oldphone222222222222]',
            platform: 'android',
            locale: 'en',
            preferences: { waiting: true, replies: true, routines: true, errors: true },
          },
          legacyPhone.token
        )
      ).status
    ).toBe(200)

    h.lifecycle.createEnvironment({ name: 'Work', memoryLimitBytes: null, kind: 'workspaces' })
    await until(() => h.lifecycle.environment('work')?.lifecycle === 'running')
    await until(() => host.subscriptions.length === 1)

    // 1) Bot turn completes -> store size becomes 1 BEFORE push computes badge -> new phone badge=4, old phone badge=1.
    h.events.emit(botActivity('atlas', 'turn_completed', ts(1), { source: 'owner' }, 1))
    await until(() => h.sentPushes.length === 1)
    expect(h.sentPushes[0].map((m) => [m.to, m.badge]).sort()).toEqual([
      ['ExponentPushToken[newphone111111111111]', 4],
      ['ExponentPushToken[oldphone222222222222]', 1],
    ])

    // 2) Pending request arrives -> store size becomes 2 -> new phone badge=5, old phone badge=2.
    h.events.emit({
      type: 'inbox.updated',
      at: ts(2),
      items: [{ botId: 'atlas', interaction: pending('question', 'q1', ts(2)) }],
    })
    await until(() => h.sentPushes.length === 2)
    expect(h.sentPushes[1].map((m) => [m.to, m.badge]).sort()).toEqual([
      ['ExponentPushToken[newphone111111111111]', 5],
      ['ExponentPushToken[oldphone222222222222]', 2],
    ])

    // 3) Chat attention arrives -> store size becomes 3 -> new phone badge=6, old phone badge=3.
    host.emit({ type: 'chat.attention', botId: null, conversationId: 'c1', name: 'Release', kind: 'plan' })
    await until(() => h.sentPushes.length === 3)
    expect(h.sentPushes[2].map((m) => [m.to, m.badge]).sort()).toEqual([
      ['ExponentPushToken[newphone111111111111]', 6],
      ['ExponentPushToken[oldphone222222222222]', 3],
    ])

    // 4) Clear bot:atlas via seen -> store size drops to 2 -> test push carries badge=5.
    expect((await h.request('POST', '/v1/attention/seen', { keys: ['bot:atlas'] })).status).toBe(200)
    expect(h.attention.size).toBe(2)
    expect((await h.request('POST', '/v1/devices/self/push/test', {})).status).toBe(200)
    expect(h.sentPushes[3][0].badge).toBe(5)
  })
})
