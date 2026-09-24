import { describe, expect, it } from 'vitest'
import {
  FLEET_ERROR_STATUS,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_INTERNAL_ROUTES,
  buildPath,
  deriveBotId,
  fleetActivityEntrySchema,
  fleetAddApiKeyAccountRequestSchema,
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
    expect(
      buildPath(FLEET_GATEWAY_ROUTES.botRoutineRun.path, { id: 'bot one', rid: 'r/1' }, { limit: 20, before: null })
    ).toBe('/v1/bots/bot%20one/routines/r%2F1/run?limit=20')
    expect(() => buildPath('/v1/bots/:id')).toThrow('Missing path parameter')
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
