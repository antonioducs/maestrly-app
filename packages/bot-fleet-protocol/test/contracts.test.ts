import * as provisioning from '../src/index.js'
import { randomUUID } from 'node:crypto'
import {
  fleetOwnerMemorySchema,
  fleetOwnerMemoryEntrySchema,
  fleetOwnerMemoryPatchRequestSchema,
  fleetInternalOwnerMemorySaveRequestSchema,
  fleetRoutineRunReportSchema,
  fleetActivityKindSchema,
} from '../src/index.js'
import { describe, expect, it } from 'vitest'
import {
  FLEET_ERROR_STATUS,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_SCREEN_UPGRADE,
  FLEET_INTERNAL_ROUTES,
  FLEET_ROUTINE_LIMITS,
  FLEET_COMPACTION_LIMITS,
  FLEET_COMPACTION_SUMMARY_MAX,
  FLEET_CONVERSATION_OPS,
  fleetActivitySchema,
  fleetCompactionConfigSchema,
  fleetCompactionStateSchema,
  fleetPatchBotRequestSchema,
  buildPath,
  compareFleetTranscriptItems,
  fleetRoutineScheduleSchema,
  deriveBotId,
  fleetActivityEntrySchema,
  fleetAddApiKeyAccountRequestSchema,
  fleetArchivedBotsResponseSchema,
  fleetBotSchema,
  fleetCreateBotRequestSchema,
  fleetCreateRoutineRequestSchema,
  fleetErrorEnvelopeSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  fleetInboxItemSchema,
  fleetInstanceEventSchema,
  fleetInstanceHealthSchema,
  fleetInstanceInputSchema,
  fleetInstanceProfileSchema,
  fleetInstanceStatusSchema,
  fleetInteractionResolutionSchema,
  fleetInternalPeerMessageRequestSchema,
  fleetInternalPeersResponseSchema,
  fleetPairRequestSchema,
  fleetPeerMessageSchema,
  fleetPendingInteractionSchema,
  fleetQuestionSchema,
  fleetRoutineSchema,
  fleetSelectionOptionSchema,
  fleetSelectionSchema,
  fleetSelectionsResponseSchema,
  fleetTranscriptItemSchema,
  fleetTranscriptPageSchema,
  formatPairingCode,
  isAllowedFleetUrl,
  isValidTimeZone,
  normalizePairingCode,
  summarizeText,
} from '../src/index.js'

const at = '2026-09-23T12:34:56Z'
const key = '11111111-1111-4111-8111-111111111111'
const schedule = { kind: 'weekly', time: '09:30', days: [1, 3, 5], timezone: 'America/Sao_Paulo' }
const bot = {
  id: 'scout',
  name: 'Scout',
  role: 'Research assistant',
  instructions: 'Find useful links.',
  tint: '#336699',
  ceiling: 'ask',
  selection: null,
  talksTo: ['dev'],
  paused: false,
  lifecycle: 'running',
  setup: { step: 'ready', error: null, errorMessage: null },
  status: 'working',
  activity: { kind: 'tool', tool: 'browser_open', target: 'example.com' },
  pendingCount: 0,
  accounts: { connected: true, providers: [{ id: 'prov_test', label: 'Test' }] },
  takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
  resources: { memoryBytes: 256, memoryLimitBytes: 1024, cpuPercent: 8.5, startedAt: at },
  screen: { width: 1280, height: 800, display: ':0' },
  appVersion: '0.9.2',
  createdAt: at,
  updatedAt: at,
}
const transcript = { kind: 'user', id: 'msg:0', at, text: 'Find a source', source: 'owner', queued: false }
const host = {
  hostname: 'fleet',
  os: 'Ubuntu 24.04',
  kernel: '6.8',
  arch: 'x64',
  cpus: 4,
  cpuPercent: 10,
  memory: { totalBytes: 8_000, usedBytes: 3_000, botsBytes: 2_000 },
  disk: { totalBytes: 100_000, usedBytes: 20_000 },
  uptimeSeconds: 200,
  gatewayVersion: '0.1.0',
  botImage: 'maestrly/bot-instance:local',
  botImageVersion: '0.9.2',
  dockerVersion: '28',
}
const status = {
  appVersion: '0.9.2',
  protocol: 1,
  ready: true,
  accounts: { connected: true, providers: [{ id: 'openai', label: 'OpenAI Plus' }] },
  selection: null,
  ceiling: 'ask',
  profile: { botId: 'scout', name: 'Scout' },
  conversationId: 'conv-1',
  turn: { state: 'running', startedAt: at },
  hold: { state: 'none', reason: null, since: null, interruptedTurn: false },
  queue: [{ inputId: 'input-1', source: 'owner', preview: 'Find a source' }],
  activity: { kind: 'thinking' },
  pending: [],
  lastEventSeq: 3,
}

describe('domain contracts', () => {
  it('preserves structured permission tools in transcript, pending inbox, and events', () => {
    const tool = { name: 'computer_click', target: '(10, 20)' }
    const permission = {
      kind: 'permission' as const,
      id: 'perm:1',
      at,
      requestId: 'p1',
      title: 'Use MCP tool',
      detail: null,
      state: 'pending' as const,
      resolvedAt: null,
    }
    const pending = { kind: 'permission' as const, id: 'p1', at, title: 'Use MCP tool', detail: null, itemId: 'perm:1' }
    expect(fleetTranscriptItemSchema.parse({ ...permission, tool })).toMatchObject({ tool })
    expect(fleetPendingInteractionSchema.parse({ ...pending, tool })).toMatchObject({ tool })
    expect(fleetInboxItemSchema.parse({ botId: 'scout', interaction: { ...pending, tool } }).interaction).toMatchObject(
      { tool }
    )
    expect(fleetTranscriptItemSchema.parse(permission)).toMatchObject({ tool: null })
    expect(fleetPendingInteractionSchema.parse(pending)).toMatchObject({ tool: null })
    expect(fleetTranscriptItemSchema.safeParse({ ...permission, tool: { name: '', target: null } }).success).toBe(false)
  })
  it('accepts only supported API key accounts and HTTP(S) base URLs', () => {
    const account = { kind: 'openai', name: 'Fake model', key: 'test-key', baseURL: 'http://fake-model:8080/v1' }
    expect(fleetAddApiKeyAccountRequestSchema.parse(account)).toEqual(account)
    expect(fleetAddApiKeyAccountRequestSchema.safeParse({ ...account, kind: 'codex' }).success).toBe(false)
    expect(fleetAddApiKeyAccountRequestSchema.safeParse({ ...account, baseURL: 'ftp://fake-model/v1' }).success).toBe(
      false
    )
    expect(fleetAddApiKeyAccountRequestSchema.safeParse({ ...account, key: '' }).success).toBe(false)
    expect(FLEET_GATEWAY_ROUTES.botApiKeyAccountAdd.path).toBe('/v1/bots/:id/accounts/api-key')
    expect(FLEET_INSTANCE_ROUTES.accountRemove.method).toBe('DELETE')
  })
  it('accepts model options, pending questions, peer messages and transcript pages', () => {
    const selection = { providerId: 'openai', modelId: 'gpt', reasoning: 'medium', fastMode: false }
    const option = {
      id: 'openai::gpt',
      providerId: 'openai',
      providerLabel: 'OpenAI Plus',
      modelId: 'gpt',
      modelLabel: 'GPT',
      efforts: ['medium'],
      fastMode: true,
    }
    const question = {
      question: 'Which site?',
      header: 'Source',
      options: [{ label: 'Official', description: null }],
      multiSelect: false,
    }
    const pending = { kind: 'question', id: 'tool-1', at, questions: [question], itemId: 'item-1' }
    const peerMessage = { id: 'peer-1', at, from: 'scout', to: 'dev', text: 'Please review this.', delivered: true }
    expect(fleetSelectionSchema.parse(selection).reasoning).toBe('medium')
    expect(fleetSelectionOptionSchema.parse(option).id).toBe('openai::gpt')
    expect(fleetSelectionOptionSchema.safeParse({ ...option, id: 'wrong' }).success).toBe(false)
    expect(fleetSelectionsResponseSchema.parse({ options: [option], current: selection }).options).toHaveLength(1)
    expect(fleetQuestionSchema.parse(question).options).toHaveLength(1)
    expect(fleetPendingInteractionSchema.parse(pending).kind).toBe('question')
    expect(fleetInboxItemSchema.parse({ botId: 'scout', interaction: pending }).botId).toBe('scout')
    expect(fleetPeerMessageSchema.parse(peerMessage).delivered).toBe(true)
    expect(fleetTranscriptPageSchema.parse({ items: [transcript], before: null }).items).toHaveLength(1)
    expect(
      fleetInternalPeersResponseSchema.parse({ peers: [{ botId: 'dev', name: 'Dev', role: 'Code', status: 'idle' }] })
        .peers
    ).toHaveLength(1)
  })

  it('accepts realistic bot, host, activity and event snapshots', () => {
    expect(fleetBotSchema.parse(bot).id).toBe('scout')
    expect(fleetHostInfoSchema.parse(host).hostname).toBe('fleet')
    const entry = { seq: 4, at, botId: 'scout', kind: 'turn_completed', summary: 'Found links', data: { count: 3 } }
    expect(fleetActivityEntrySchema.parse(entry).seq).toBe(4)
    expect(fleetGatewayEventSchema.parse({ type: 'bot.updated', at, bot }).type).toBe('bot.updated')
    expect(fleetGatewayEventSchema.parse({ type: 'activity', at, entry }).type).toBe('activity')
    expect(fleetErrorEnvelopeSchema.parse({ code: 'BOT_NOT_RUNNING', message: 'Bot is stopped' }).code).toBe(
      'BOT_NOT_RUNNING'
    )
    expect(FLEET_ERROR_STATUS.PROTOCOL_INCOMPATIBLE).toBe(426)
  })

  it('accepts transcript variants and rejects wrong discriminants or oversized output', () => {
    expect(fleetTranscriptItemSchema.parse(transcript).kind).toBe('user')
    expect(
      fleetTranscriptItemSchema.parse({
        kind: 'question',
        id: 'q:0',
        at,
        toolCallId: 'q',
        questions: [],
        state: 'dismissed',
        answers: null,
      }).kind
    ).toBe('question')
    expect(fleetTranscriptItemSchema.safeParse({ ...transcript, kind: 'unknown' }).success).toBe(false)
    expect(
      fleetTranscriptItemSchema.safeParse({
        kind: 'tool',
        id: 't:0',
        at,
        name: 'browser_open',
        target: null,
        state: 'done',
        output: 'x'.repeat(401),
      }).success
    ).toBe(false)
    expect(fleetInteractionResolutionSchema.parse({ kind: 'question_dismiss' }).kind).toBe('question_dismiss')
    expect(fleetInteractionResolutionSchema.safeParse({ kind: 'permission', reply: 'maybe' }).success).toBe(false)
  })

  it('validates routines and schedule shape without imposing an IANA check in the schema', () => {
    const routine = {
      id: 'r1',
      botId: 'scout',
      title: 'Morning brief',
      prompt: 'Summarize news',
      schedule,
      enabled: true,
      nextRunAt: at,
      lastRunAt: null,
      lastOutcome: null,
      createdAt: at,
      updatedAt: at,
    }
    expect(fleetRoutineSchema.parse(routine).title).toBe('Morning brief')
    expect(
      fleetCreateRoutineRequestSchema.parse({
        title: 'Brief',
        prompt: 'Do it',
        schedule,
        enabled: true,
        idempotencyKey: key,
      }).enabled
    ).toBe(true)
    expect(fleetRoutineSchema.safeParse({ ...routine, schedule: { ...schedule, time: '24:00' } }).success).toBe(false)
    expect(fleetRoutineSchema.safeParse({ ...routine, schedule: { ...schedule, days: [1, 1] } }).success).toBe(false)
    expect(fleetRoutineSchema.safeParse({ ...routine, schedule: { ...schedule, timezone: '' } }).success).toBe(false)
    expect(
      fleetRoutineSchema.safeParse({ ...routine, schedule: { ...schedule, timezone: 'x'.repeat(65) } }).success
    ).toBe(false)
    expect(fleetRoutineSchema.safeParse({ ...routine, schedule: { ...schedule, timezone: 'Made/Up' } }).success).toBe(
      true
    )
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true)
    expect(isValidTimeZone('Made/Up')).toBe(false)
  })

  it('validates gateway, internal, and instance bodies at their limits', () => {
    expect(
      fleetCreateBotRequestSchema.safeParse({
        name: 'A',
        instructions: 'x'.repeat(8000),
        ceiling: 'ask',
        talksTo: [],
        idempotencyKey: key,
      }).success
    ).toBe(true)
    expect(
      fleetCreateBotRequestSchema.safeParse({
        name: 'x'.repeat(41),
        instructions: '',
        ceiling: 'ask',
        talksTo: [],
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(fleetPairRequestSchema.parse({ code: '0123ABCD', deviceName: 'MacBook' }).code).toBe('0123ABCD')
    expect(
      fleetInternalPeerMessageRequestSchema.parse({ to: 'dev', text: 'x'.repeat(4000), idempotencyKey: key }).to
    ).toBe('dev')
    expect(
      fleetInternalPeerMessageRequestSchema.safeParse({ to: 'dev', text: 'x'.repeat(4001), idempotencyKey: key })
        .success
    ).toBe(false)
    expect(
      fleetInstanceInputSchema.parse({ idempotencyKey: key, text: 'x'.repeat(16000), source: 'owner' }).source
    ).toBe('owner')
    expect(
      fleetInstanceInputSchema.safeParse({ idempotencyKey: key, text: 'x'.repeat(16001), source: 'owner' }).success
    ).toBe(false)
    expect(fleetInstanceStatusSchema.parse(status).lastEventSeq).toBe(3)
    expect(
      fleetInstanceProfileSchema.parse({
        botId: 'scout',
        name: 'Scout',
        instructions: 'Find links',
        ceiling: 'ask',
        selection: null,
        gateway: { peersEnabled: true },
      }).botId
    ).toBe('scout')
    expect(fleetInstanceHealthSchema.parse({ ok: true, appVersion: '0.9.2', protocol: 1, ready: true }).ready).toBe(
      true
    )
    expect(fleetInstanceEventSchema.parse({ seq: 4, at, type: 'status', status }).type).toBe('status')
    expect(fleetInstanceEventSchema.safeParse({ seq: 4, at, type: 'reset' }).success).toBe(true)
    expect(
      fleetInstanceEventSchema.safeParse({ seq: 4, at, type: 'turn.finished', outcome: 'unknown', summary: null })
        .success
    ).toBe(false)
  })
})

describe('routes and helpers', () => {
  it('covers the three route families with precise paths', () => {
    expect(FLEET_GATEWAY_ROUTES.botRoutineRun.path).toBe('/v1/bots/:id/routines/:rid/run')
    expect(FLEET_GATEWAY_ROUTES.botRoutineRun.method).toBe('POST')
    expect(FLEET_GATEWAY_ROUTES.botMessageDelete.response).toBeNull()
    expect(FLEET_INTERNAL_ROUTES.peerMessageSend.path).toBe('/internal/v1/peers/messages')
    expect(FLEET_INSTANCE_ROUTES.interactionResolve.path).toBe('/v1/interactions/:id/resolve')
    expect(FLEET_INSTANCE_ROUTES.screenView.path).toBe('/v1/screen/view')
    expect(FLEET_INSTANCE_ROUTES.screenControl.path).toBe('/v1/screen/control')
    expect(FLEET_SCREEN_UPGRADE).toBe('maestrly-rfb')
    expect(
      buildPath(FLEET_GATEWAY_ROUTES.botRoutineRun.path, { id: 'bot one', rid: 'r/1' }, { limit: 20, before: null })
    ).toBe('/v1/bots/bot%20one/routines/r%2F1/run?limit=20')
    expect(() => buildPath('/v1/bots/:id')).toThrow('Missing path parameter')
  })

  it('keeps archived bots in their own collection, so no bot id can shadow them', () => {
    expect(FLEET_GATEWAY_ROUTES.archivedBotsList).toMatchObject({ method: 'GET', path: '/v1/archived-bots' })
    expect(FLEET_GATEWAY_ROUTES.archivedBotRestore).toMatchObject({
      method: 'POST',
      path: '/v1/archived-bots/:id/restore',
    })
    expect(FLEET_GATEWAY_ROUTES.archivedBotDelete).toMatchObject({
      method: 'DELETE',
      path: '/v1/archived-bots/:id',
      response: null,
    })
    // Every concrete path, with any value in its parameters, reaches exactly one route of its method.
    const routes = Object.entries(FLEET_GATEWAY_ROUTES)
    const pattern = (path: string) => new RegExp('^' + path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, '[^/]+') + '$')
    for (const [key, route] of routes)
      for (const value of ['archived', 'archived-bots', 'restore', 'x']) {
        const concrete = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, value)
        const matches = routes.filter(
          ([, other]) => other.method === route.method && pattern(other.path).test(concrete)
        )
        expect(
          matches.map(([name]) => name),
          `${key} ${concrete}`
        ).toEqual([key])
      }
    const archived = {
      id: 'scout',
      name: 'Scout',
      role: '',
      tint: '#4978c6',
      createdAt: '2026-09-24T10:00:00.000Z',
      archivedAt: '2026-09-24T11:00:00.000Z',
      files: 'kept',
    }
    expect(fleetArchivedBotsResponseSchema.parse({ bots: [archived] }).bots[0].files).toBe('kept')
    expect(fleetArchivedBotsResponseSchema.safeParse({ bots: [{ ...archived, files: 'gone' }] }).success).toBe(false)
    for (const kind of ['bot_restored', 'bot_deleted'])
      expect(
        fleetActivityEntrySchema.safeParse({
          seq: 1,
          at: archived.archivedAt,
          botId: null,
          kind,
          summary: 'Scout',
          data: {},
        }).success
      ).toBe(true)
  })

  it('carries the bot compaction model, its state, the compaction transcript item and the setup need', () => {
    const config = {
      providerId: 'prov_a',
      modelId: 'small',
      reasoning: null,
      fastMode: false,
      intervalTokens: FLEET_COMPACTION_LIMITS.intervalTokensDefault,
    }
    expect(fleetCompactionConfigSchema.parse(config)).toEqual(config)
    for (const intervalTokens of [9_999, 1_000_001, 50_000.5])
      expect(fleetCompactionConfigSchema.safeParse({ ...config, intervalTokens }).success).toBe(false)
    expect(fleetPatchBotRequestSchema.parse({ compaction: null })).toEqual({ compaction: null })
    expect(fleetPatchBotRequestSchema.parse({ compaction: config }).compaction).toEqual(config)
    const at = '2026-09-25T10:00:00.000Z'
    const state = {
      configured: false,
      problem: 'unavailable',
      background: { status: 'failed', error: 'summarizer-context-window-unknown' },
      progress: {
        id: 'p1',
        status: 'running',
        phase: 'chunk',
        completed: 1,
        total: 3,
        attempt: null,
        beforeTokens: 180_000,
        afterTokens: null,
        afterQuality: null,
        error: null,
        updatedAt: at,
      },
    }
    expect(fleetCompactionStateSchema.parse(state)).toEqual(state)
    expect(fleetCompactionStateSchema.safeParse({ ...state, problem: 'other' }).success).toBe(false)
    // Older bots and older gateways leave these out.
    expect(
      fleetInstanceProfileSchema.parse({
        botId: 'b',
        name: 'B',
        instructions: '',
        ceiling: 'ask',
        selection: null,
        gateway: { peersEnabled: false },
      }).compaction
    ).toBeNull()
    expect(fleetActivitySchema.parse({ kind: 'setup' })).toEqual({ kind: 'setup', need: 'account' })
    expect(fleetActivitySchema.parse({ kind: 'setup', need: 'compaction' })).toEqual({
      kind: 'setup',
      need: 'compaction',
    })
    expect(fleetActivitySchema.parse({ kind: 'compacting' })).toEqual({ kind: 'compacting' })
    const item = { id: 'm:3', at, kind: 'compaction', origin: 'immediate', summary: 'Goal: ship it', truncated: false }
    expect(fleetTranscriptItemSchema.parse(item)).toEqual(item)
    expect(
      fleetTranscriptItemSchema.safeParse({ ...item, summary: 'x'.repeat(FLEET_COMPACTION_SUMMARY_MAX + 1) }).success
    ).toBe(false)
    expect(fleetTranscriptItemSchema.safeParse({ ...item, origin: 'other' }).success).toBe(false)
    expect(FLEET_CONVERSATION_OPS).toEqual(expect.arrayContaining(['chatCompact', 'chatBackgroundCompactionRetry']))
  })

  it('schedules routines weekly or every N minutes within the limits, and says who created them', () => {
    const weekly = { kind: 'weekly', time: '09:00', days: [1], timezone: 'UTC' }
    expect(fleetRoutineScheduleSchema.parse(weekly)).toEqual(weekly)
    expect(fleetRoutineScheduleSchema.parse({ kind: 'interval', everyMinutes: 15 })).toEqual({
      kind: 'interval',
      everyMinutes: 15,
    })
    for (const everyMinutes of [1, 14, 1441, 30.5])
      expect(fleetRoutineScheduleSchema.safeParse({ kind: 'interval', everyMinutes }).success).toBe(false)
    expect(FLEET_ROUTINE_LIMITS).toEqual({ intervalMinMinutes: 15, intervalMaxMinutes: 1440, botCreatedMax: 10 })
    const at = '2026-09-25T10:00:00.000Z'
    const routine = {
      id: 'r1',
      botId: 'scout',
      title: 'Check',
      prompt: 'Check now',
      schedule: { kind: 'interval', everyMinutes: 30 },
      enabled: true,
      nextRunAt: at,
      lastRunAt: at,
      lastOutcome: 'skipped_busy',
      createdAt: at,
      updatedAt: at,
    }
    // Routines saved before authorship existed were all the owner's.
    expect(fleetRoutineSchema.parse(routine).createdBy).toBe('owner')
    expect(fleetRoutineSchema.parse({ ...routine, createdBy: 'bot' }).createdBy).toBe('bot')
    expect(fleetRoutineSchema.safeParse({ ...routine, createdBy: 'peer' }).success).toBe(false)
    expect(FLEET_INTERNAL_ROUTES.routinesList).toMatchObject({ method: 'GET', path: '/internal/v1/routines' })
    expect(FLEET_INTERNAL_ROUTES.routinePatch).toMatchObject({ method: 'PATCH', path: '/internal/v1/routines/:rid' })
    expect(FLEET_INTERNAL_ROUTES.routineDelete).toMatchObject({ method: 'DELETE', response: null })
    for (const kind of ['routine_created', 'routine_updated', 'routine_deleted'])
      expect(
        fleetActivityEntrySchema.safeParse({ seq: 1, at, botId: 'scout', kind, summary: 'Check', data: {} }).success
      ).toBe(true)
  })

  it('orders transcript items by time, then by their position in the message they share', () => {
    const at = '2026-09-24T21:29:45.794Z'
    const item = (id: string, time = at) => ({ id, at: time })
    // One assistant message's parts share its time; `:10` must not come before `:2`.
    const ids = ['m:1', 'm:10', 'm:18', 'm:4', 'm:6', 'm:7', 'm:8', 'm:2']
    expect(
      ids
        .map((id) => item(id))
        .sort(compareFleetTranscriptItems)
        .map((entry) => entry.id)
    ).toEqual(['m:1', 'm:2', 'm:4', 'm:6', 'm:7', 'm:8', 'm:10', 'm:18'])
    expect(compareFleetTranscriptItems(item('m:9', '2026-09-24T21:29:46.000Z'), item('m:10'))).toBeGreaterThan(0)
    // Different messages (or other ids) with the same time still get one stable order.
    expect(compareFleetTranscriptItems(item('input:b'), item('input:a'))).toBeGreaterThan(0)
    expect(compareFleetTranscriptItems(item('a:2'), item('b:10'))).toBeLessThan(0)
    expect(compareFleetTranscriptItems(item('m:3'), item('m:3'))).toBe(0)
  })

  it('derives valid and deduplicated bot slugs', () => {
    expect(deriveBotId('  São Paulo — Scout  ', [])).toBe('sao-paulo-scout')
    expect(deriveBotId('!?', ['bot'])).toBe('bot-2')
    const long = 'abcdefghijklmnopqrstuvwxyz1234567890'
    expect(deriveBotId(long, [long.slice(0, 32)])).toBe('abcdefghijklmnopqrstuvwxyz1234-2')
    expect(deriveBotId('A', ['a', 'a-2'])).toBe('a-3')
  })

  it('allows only safe fleet origins', () => {
    for (const url of [
      'https://example.com',
      'http://127.250.0.1:7443/',
      'http://[::1]',
      'http://localhost',
      'http://100.127.255.255',
      'http://bot.tail.ts.net',
    ]) {
      expect(isAllowedFleetUrl(url).ok).toBe(true)
    }
    for (const url of [
      'http://100.128.0.1',
      'http://192.168.1.2',
      'http://ts.net',
      'https://user:pass@example.com',
      'https://@example.com',
      'https://example.com/path',
      'https://example.com?',
      'https://example.com/#x',
    ]) {
      expect(isAllowedFleetUrl(url).ok).toBe(false)
    }
    expect(isAllowedFleetUrl('https://example.com/')).toEqual({ ok: true, origin: 'https://example.com' })
  })

  it('normalizes Crockford codes and makes single-line previews', () => {
    expect(normalizePairingCode('oill-abcd')).toBe('0111ABCD')
    expect(formatPairingCode('oill abcd')).toBe('0111-ABCD')
    expect(normalizePairingCode('U123-ABCD')).toBeNull()
    expect(summarizeText(' one\n two   three ', 9)).toBe('one two…')
    expect(summarizeText('hello', 1)).toBe('…')
  })
})

describe('memory and routine history contracts', () => {
  it('accepts owner memory entries and rejects oversized content', () => {
    const entry = {
      id: 'om-1',
      content: 'Prefer short answers.',
      status: 'active',
      author: { kind: 'bot', botId: 'scout', name: 'Scout' },
      origin: 'owner',
      replacesId: null,
      replacedById: null,
      createdAt: '2026-09-25T10:00:00.000Z',
      updatedAt: '2026-09-25T10:00:00.000Z',
    }
    expect(fleetOwnerMemorySchema.parse({ revision: 3, activeChars: 21, entries: [entry] }).entries[0].author).toEqual({
      kind: 'bot',
      botId: 'scout',
      name: 'Scout',
    })
    expect(fleetOwnerMemoryEntrySchema.safeParse({ ...entry, content: 'x'.repeat(501) }).success).toBe(false)
    expect(fleetOwnerMemoryPatchRequestSchema.safeParse({}).success).toBe(false)
    expect(
      fleetInternalOwnerMemorySaveRequestSchema.parse({
        content: 'Lives in São Paulo.',
        origin: 'auto',
        idempotencyKey: randomUUID(),
      }).origin
    ).toBe('auto')
  })
  it('carries routine runs and keeps older instance events valid', () => {
    const input = fleetInstanceInputSchema.parse({
      idempotencyKey: randomUUID(),
      text: 'Check prices',
      source: 'routine',
      attachments: [],
      routine: {
        id: 'r1',
        title: 'Prices',
        runId: 'run-1',
        previousRuns: [
          {
            at: '2026-09-24T09:00:00.000Z',
            status: 'completed',
            summary: 'Checked 3 stores',
            pending: null,
            notes: 'Amazon was down',
          },
        ],
      },
    })
    expect(input.routine?.previousRuns?.[0].notes).toBe('Amazon was down')
    const old = fleetInstanceEventSchema.parse({
      seq: 1,
      at: '2026-09-25T10:00:00.000Z',
      type: 'turn.finished',
      outcome: 'completed',
      summary: 'ok',
    })
    expect(old).toMatchObject({ inputId: null, text: null })
    expect(fleetRoutineRunReportSchema.safeParse({ summary: '', pending: null, notes: null }).success).toBe(false)
  })
  it('declares the new routes and events', () => {
    expect(FLEET_GATEWAY_ROUTES.ownerMemoryList.path).toBe('/v1/owner-memory')
    expect(FLEET_GATEWAY_ROUTES.botRoutineRuns.path).toBe('/v1/bots/:id/routines/:rid/runs')
    expect(FLEET_GATEWAY_ROUTES.botMemoryPatch.method).toBe('PATCH')
    expect(FLEET_INTERNAL_ROUTES.routineRunReport.path).toBe('/internal/v1/routines/:rid/runs/:runId/report')
    expect(FLEET_INSTANCE_ROUTES.memoriesList.path).toBe('/v1/memories')
    expect(
      fleetGatewayEventSchema.parse({ type: 'owner_memory.updated', at: '2026-09-25T10:00:00.000Z', revision: 4 }).type
    ).toBe('owner_memory.updated')
    expect(fleetActivityKindSchema.options).toEqual(
      expect.arrayContaining(['owner_memory_saved', 'owner_memory_forgotten'])
    )
  })
})

describe('bot provisioning contracts', () => {
  const apiKey = { type: 'api-key', kind: 'openai', name: 'Test', key: 'synthetic', baseURL: null }
  it('accepts transferable accounts and rejects extra fields, excess items and missing expiry', () => {
    const items = [
      apiKey,
      { type: 'github-copilot', label: 'Test', token: 'synthetic' },
      { type: 'cursor', label: 'Test', apiKey: 'synthetic', expiresAt: null },
    ]
    expect(provisioning.fleetAccountImportRequestSchema.parse({ items })).toEqual({ items })
    for (const items of [
      [{ ...apiKey, extra: 1 }],
      Array(51).fill(apiKey),
      [{ type: 'cursor', label: 'Test', apiKey: 'synthetic' }],
    ]) {
      expect(provisioning.fleetAccountImportRequestSchema.safeParse({ items }).success).toBe(false)
    }
  })
  it('validates login methods, slots and callback endpoints', () => {
    expect(provisioning.fleetLoginStartRequestSchema.parse({ kind: 'codex', method: 'device' }).slot).toBe('auto')
    expect(provisioning.fleetLoginStartRequestSchema.safeParse({ kind: 'grok', method: 'browser' }).success).toBe(false)
    expect(
      provisioning.fleetLoginStartRequestSchema.safeParse({ kind: 'codex', method: 'browser', slot: 'acc_x1' }).success
    ).toBe(true)
    expect(
      provisioning.fleetLoginStartRequestSchema.safeParse({ kind: 'codex', method: 'browser', slot: '../x' }).success
    ).toBe(false)
    const attempt = {
      loginId: 'l1',
      kind: 'codex',
      accountId: null,
      method: 'browser',
      state: 'pending',
      expiresAt: at,
      browser: { authUrl: 'https://auth.openai.com/oauth/authorize', callback: { port: 1455, path: '/auth/callback' } },
      device: null,
      manual: null,
      account: null,
      error: null,
    }
    expect(provisioning.fleetLoginAttemptSchema.parse(attempt)).toEqual(attempt)
    for (const callback of [
      { port: 80, path: '/auth/callback' },
      { port: 1455, path: '/a?b' },
    ]) {
      expect(
        provisioning.fleetLoginAttemptSchema.safeParse({ ...attempt, browser: { ...attempt.browser, callback } })
          .success
      ).toBe(false)
    }
  })
  it('bounds skill installs and requires MCP connection details', () => {
    const file = { path: 'SKILL.md', data: 'eA==', executable: false }
    expect(provisioning.fleetSkillInstallRequestSchema.parse({ name: 'test', files: [file] }).name).toBe('test')
    for (const input of [
      { name: 'My Skill', files: [file] },
      { name: 'test', files: Array(401).fill(file) },
      { name: 'test', files: [{ ...file, path: 'x'.repeat(241) }] },
    ]) {
      expect(provisioning.fleetSkillInstallRequestSchema.safeParse(input).success).toBe(false)
    }
    for (const transport of ['http', 'stdio'])
      expect(provisioning.fleetMcpServerImportSchema.safeParse({ name: 'x', transport, enabled: true }).success).toBe(
        false
      )
    const server = {
      name: 'x',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { K: 'v' },
    }
    expect(provisioning.fleetMcpServerImportSchema.parse(server)).toEqual(server)
  })
  it('defaults feature flags for older peers and includes configuration activity', () => {
    expect(
      provisioning.fleetMetaResponseSchema.parse({
        protocol: 1,
        gatewayVersion: '1',
        botImage: 'i',
        botImageVersion: null,
      }).features
    ).toEqual([])
    expect(fleetBotSchema.parse(bot).capabilities).toEqual([])
    expect(fleetInstanceStatusSchema.parse(status).capabilities).toEqual([])
    expect(fleetActivityKindSchema.options).toContain('bot_configured')
  })
  it('allows only provider sign-in URLs and extracts loopback redirects', () => {
    for (const [kind, url] of [
      ['codex', 'https://auth.openai.com/oauth/authorize?x=1'],
      ['codex', 'https://auth.openai.com/codex/device'],
      ['claude', 'https://claude.com/cai/oauth/authorize?code=true'],
      ['grok', 'https://accounts.x.ai/device?code=1'],
    ] as const)
      expect(provisioning.fleetLoginUrlAllowed(kind, url)).toBe(true)
    for (const [kind, url] of [
      ['codex', 'https://auth.openai.com.evil.io/'],
      ['claude', 'http://claude.com/'],
      ['grok', 'https://x.ai.evil.io/'],
      ['codex', 'https://user:pw@auth.openai.com/'],
    ] as const)
      expect(provisioning.fleetLoginUrlAllowed(kind, url)).toBe(false)
    expect(
      provisioning.fleetLoginCallbackFromAuthUrl(
        'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A33749%2Fcallback'
      )
    ).toEqual({ port: 33749, path: '/callback' })
    expect(
      provisioning.fleetLoginCallbackFromAuthUrl(
        'https://claude.com/cai/oauth/authorize?redirect_uri=https://platform.claude.com/oauth/code/callback'
      )
    ).toBeNull()
  })
  it('declares matching gateway and instance provisioning routes', () => {
    const routes = [
      ['botAccountsList', 'accountsList', 'GET', '/accounts'],
      ['botAccountsImport', 'accountsImport', 'POST', '/accounts/import'],
      ['botSubscriptionRemove', 'subscriptionRemove', 'DELETE', '/subscriptions/:kind/:slot'],
      ['botLoginStart', 'loginStart', 'POST', '/logins'],
      ['botLoginGet', 'loginGet', 'GET', '/logins/:lid'],
      ['botLoginCallback', 'loginCallback', 'POST', '/logins/:lid/callback'],
      ['botLoginCode', 'loginCode', 'POST', '/logins/:lid/code'],
      ['botLoginCancel', 'loginCancel', 'DELETE', '/logins/:lid'],
      ['botSkillsList', 'skillsList', 'GET', '/skills'],
      ['botSkillInstall', 'skillInstall', 'POST', '/skills'],
      ['botSkillRemove', 'skillRemove', 'DELETE', '/skills/:name'],
      ['botMcpServersList', 'mcpServersList', 'GET', '/mcp-servers'],
      ['botMcpServersImport', 'mcpServersImport', 'POST', '/mcp-servers/import'],
      ['botMcpServerRemove', 'mcpServerRemove', 'DELETE', '/mcp-servers/:sid'],
    ] as const
    for (const [gateway, instance, method, path] of routes) {
      expect(FLEET_GATEWAY_ROUTES[gateway]).toMatchObject({ method, path: '/v1/bots/:id' + path })
      expect(FLEET_INSTANCE_ROUTES[instance]).toMatchObject({
        method,
        path: '/v1' + path,
        body: FLEET_GATEWAY_ROUTES[gateway].body,
        response: FLEET_GATEWAY_ROUTES[gateway].response,
      })
    }
  })
})
