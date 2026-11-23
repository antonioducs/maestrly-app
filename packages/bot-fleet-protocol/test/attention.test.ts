import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  FLEET_ATTENTION_FEATURE,
  FLEET_ATTENTION_LIMITS,
  FLEET_ATTENTION_QUERY,
  FLEET_CHAT_ATTENTION_QUERY,
  FLEET_CHAT_ATTENTION_SYNC_CAPABILITY,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_META_FEATURES_LEGACY_MAX,
  fleetAttentionEntrySchema,
  fleetAttentionKey,
  fleetAttentionKindSchema,
  fleetAttentionSeenRequestSchema,
  fleetAttentionSeenResponseSchema,
  fleetAttentionSnapshotSchema,
  fleetAttentionSourceSchema,
  fleetAttentionUpdatedEventSchema,
  fleetChatAttentionKindSchema,
  fleetChatAttentionQueryValue,
  fleetChatAttentionSnapshotItemSchema,
  fleetGatewayEventSchema,
  fleetInstanceEventSchema,
  fleetMetaFeatures,
  fleetMetaResponseSchema,
  fleetPushRegistrationRequestSchema,
  fleetPushRegistrationSchema,
  fleetReaderChatAttentionVersion,
  fleetReaderWantsAttention,
  fleetReaderWantsChatAttention,
  parseFleetAttentionKey,
} from '../src/index.js'

const at = '2026-11-23T12:00:00.000Z'

const chatEntry = {
  key: fleetAttentionKey.chat('work', 'conv-1'),
  source: 'chat' as const,
  kind: 'question' as const,
  at,
  title: 'Fix flaky test',
  environmentId: 'work',
  conversationId: 'conv-1',
}

const botEntry = {
  key: fleetAttentionKey.bot('ops-1'),
  source: 'bot' as const,
  kind: 'finished' as const,
  at,
  title: 'Ops Bot',
  botId: 'ops-1',
  runId: 'run-42',
}

const requestEntry = {
  key: fleetAttentionKey.request('ops-1', 'req-7'),
  source: 'request' as const,
  kind: 'approval' as const,
  at,
  title: 'Ops Bot',
  botId: 'ops-1',
  requestId: 'req-7',
}

const basePushRegistration = {
  provider: 'expo' as const,
  token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  platform: 'ios' as const,
  locale: 'en',
  preferences: { waiting: true, replies: true, routines: false, errors: true },
}

describe('attention protocol', () => {
  it('declares constants, limits and routes within protocol bounds', () => {
    expect(FLEET_ATTENTION_FEATURE).toBe('attention')
    expect(FLEET_ATTENTION_FEATURE.length).toBeLessThanOrEqual(40)
    expect(FLEET_ATTENTION_QUERY).toBe('attention')
    expect(FLEET_CHAT_ATTENTION_QUERY).toBe('chatAttention')
    expect(FLEET_CHAT_ATTENTION_SYNC_CAPABILITY).toBe('chat-attention-sync')
    expect(FLEET_CHAT_ATTENTION_SYNC_CAPABILITY.length).toBeLessThanOrEqual(40)
    expect(FLEET_ATTENTION_LIMITS).toEqual({ keyMax: 400, titleMax: 400, entriesMax: 2000, seenKeysMax: 200 })

    expect(FLEET_GATEWAY_ROUTES.attention).toMatchObject({ method: 'GET', path: '/v1/attention', body: null })
    expect(FLEET_GATEWAY_ROUTES.attentionSeen).toMatchObject({ method: 'POST', path: '/v1/attention/seen' })
    expect(FLEET_GATEWAY_ROUTES.attention.response.parse({ entries: [chatEntry], at })).toEqual({
      entries: [chatEntry],
      at,
    })
    expect(FLEET_GATEWAY_ROUTES.attentionSeen.body.parse({ keys: [chatEntry.key] })).toEqual({ keys: [chatEntry.key] })
    expect(FLEET_GATEWAY_ROUTES.attentionSeen.response.parse({ cleared: [chatEntry.key] })).toEqual({
      cleared: [chatEntry.key],
    })
  })

  it('keeps attention kinds aligned with InboxKind and leaves chat attention kinds untouched', () => {
    expect(fleetAttentionSourceSchema.options).toEqual(['chat', 'bot', 'request'])
    expect(fleetAttentionKindSchema.options).toEqual([
      'question',
      'approval',
      'plan',
      'help',
      'error',
      'finished',
      'activity',
    ])
    // Gateway CHAT_PHRASES is a Record over fleetChatAttentionKindSchema: never alter its members.
    expect(fleetChatAttentionKindSchema.options).toEqual(['waiting', 'question', 'plan', 'finished', 'failed'])
  })

  it('builds and parses stable attention keys cleanly', () => {
    const chatKey = fleetAttentionKey.chat('work', 'conv-123')
    expect(chatKey).toBe('chat:work/conv-123')
    expect(parseFleetAttentionKey(chatKey)).toEqual({
      source: 'chat',
      environmentId: 'work',
      conversationId: 'conv-123',
    })

    const nestedChatKey = fleetAttentionKey.chat('work', 'ns/conv-123')
    expect(parseFleetAttentionKey(nestedChatKey)).toEqual({
      source: 'chat',
      environmentId: 'work',
      conversationId: 'ns/conv-123',
    })

    const botKey = fleetAttentionKey.bot('ops-1')
    expect(botKey).toBe('bot:ops-1')
    expect(parseFleetAttentionKey(botKey)).toEqual({ source: 'bot', botId: 'ops-1' })

    const requestKey = fleetAttentionKey.request('ops-1', 'req-9')
    expect(requestKey).toBe('request:ops-1/req-9')
    expect(parseFleetAttentionKey(requestKey)).toEqual({ source: 'request', botId: 'ops-1', requestId: 'req-9' })

    for (const invalid of [
      '',
      'chat:',
      'chat:work',
      'chat:work/',
      'chat:/conv',
      'bot:',
      'bot:ops/extra',
      'request:',
      'request:ops',
      'request:ops/',
      'request:/req',
      'unknown:abc',
    ])
      expect(parseFleetAttentionKey(invalid)).toBeNull()
  })

  it('validates attention entries, snapshots, updated events and seen requests', () => {
    expect(fleetAttentionEntrySchema.parse(chatEntry)).toEqual(chatEntry)
    expect(fleetAttentionEntrySchema.parse(botEntry)).toEqual(botEntry)
    expect(fleetAttentionEntrySchema.parse(requestEntry)).toEqual(requestEntry)
    expect(
      fleetAttentionEntrySchema.parse({
        key: fleetAttentionKey.bot('ops-1'),
        source: 'bot',
        kind: 'activity',
        at,
        title: '',
        environmentId: null,
        botId: 'ops-1',
        conversationId: null,
        requestId: null,
        runId: null,
        threadId: 'thread-1',
      }).threadId
    ).toBe('thread-1')

    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, key: '' })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, key: 'k'.repeat(401) })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, source: 'email' })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, kind: 'cleared' })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, at: '2026-11-23T12:00:00+02:00' })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, title: 'x'.repeat(401) })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...chatEntry, environmentId: 'Bad Env' })).toThrow()
    expect(() => fleetAttentionEntrySchema.parse({ ...botEntry, botId: 'Bad Bot' })).toThrow()

    const snapshot = { entries: [chatEntry, botEntry, requestEntry], at }
    expect(fleetAttentionSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      fleetAttentionSnapshotSchema.parse({ entries: Array.from({ length: 2001 }, () => chatEntry), at })
    ).toThrow()

    const updated = { type: 'attention.updated' as const, upsert: [chatEntry], remove: [botEntry.key] }
    expect(fleetAttentionUpdatedEventSchema.parse(updated)).toEqual(updated)
    expect(() => fleetAttentionUpdatedEventSchema.parse({ ...updated, type: 'inbox.updated' })).toThrow()

    expect(fleetAttentionSeenRequestSchema.parse({ keys: [chatEntry.key, botEntry.key] })).toEqual({
      keys: [chatEntry.key, botEntry.key],
    })
    expect(() => fleetAttentionSeenRequestSchema.parse({ keys: [] })).toThrow()
    expect(() => fleetAttentionSeenRequestSchema.parse({ keys: [''] })).toThrow()
    expect(() =>
      fleetAttentionSeenRequestSchema.parse({ keys: Array.from({ length: 201 }, (_, i) => `bot:b${i}`) })
    ).toThrow()
    expect(() => fleetAttentionSeenRequestSchema.parse({ keys: [chatEntry.key], extra: true })).toThrow()

    expect(fleetAttentionSeenResponseSchema.parse({ cleared: [] })).toEqual({ cleared: [] })
    expect(fleetAttentionSeenResponseSchema.parse({ cleared: [chatEntry.key] })).toEqual({ cleared: [chatEntry.key] })
  })

  it('keeps attention.updated outside the closed fleetGatewayEventSchema union', () => {
    const event = { type: 'attention.updated', upsert: [chatEntry], remove: [botEntry.key] }
    expect(fleetAttentionUpdatedEventSchema.safeParse(event).success).toBe(true)
    expect(fleetGatewayEventSchema.safeParse(event).success).toBe(false)
    expect(fleetGatewayEventSchema.safeParse({ ...event, at }).success).toBe(false)
  })

  it('announces the attention feature only in moreFeatures without overflowing legacy features', () => {
    const legacyFeatures = Array.from({ length: FLEET_META_FEATURES_LEGACY_MAX }, (_, i) => `f${i}`)
    expect(legacyFeatures).not.toContain(FLEET_ATTENTION_FEATURE)
    const meta = {
      protocol: 1 as const,
      gatewayVersion: '1.0.0',
      botImage: 'maestrly/bot:latest',
      botImageVersion: null,
      features: legacyFeatures,
      moreFeatures: [FLEET_ATTENTION_FEATURE],
    }
    const legacyDesktopSchema = fleetMetaResponseSchema.omit({ moreFeatures: true }).extend({
      features: z.array(z.string()).max(FLEET_META_FEATURES_LEGACY_MAX),
    })
    expect(legacyDesktopSchema.parse(meta).features).toHaveLength(FLEET_META_FEATURES_LEGACY_MAX)
    expect(fleetMetaFeatures(fleetMetaResponseSchema.parse(meta))).toContain(FLEET_ATTENTION_FEATURE)
  })

  it('parses attention and versioned chatAttention query flags', () => {
    expect(fleetReaderWantsAttention(new URLSearchParams(''))).toBe(false)
    expect(fleetReaderWantsAttention(new URLSearchParams('attention=1'))).toBe(true)
    expect(fleetReaderWantsAttention(new URLSearchParams('attention=2'))).toBe(false)
    expect(fleetReaderWantsAttention(new URLSearchParams('attention=x'))).toBe(false)

    for (const [query, version, wants] of [
      ['', 0, false],
      ['chatAttention=', 0, false],
      ['chatAttention=1', 1, true],
      ['chatAttention=2', 2, true],
      ['chatAttention=x', 0, false],
      ['chatAttention=3', 0, false],
      ['since=0&chatAttention=2', 2, true],
    ] as const) {
      const params = new URLSearchParams(query)
      expect(fleetReaderChatAttentionVersion(params)).toBe(version)
      expect(fleetReaderWantsChatAttention(params)).toBe(wants)
    }
  })

  it('gates chatAttention=2 on chat-attention-sync so older hosts keep emitting chat.attention', () => {
    expect(fleetChatAttentionQueryValue([])).toBe(1)
    expect(fleetChatAttentionQueryValue(['workspaces-host', 'mobile-api', 'host-routines'])).toBe(1)
    expect(fleetChatAttentionQueryValue([FLEET_CHAT_ATTENTION_SYNC_CAPABILITY])).toBe(2)
    expect(fleetChatAttentionQueryValue(['workspaces-host', FLEET_CHAT_ATTENTION_SYNC_CAPABILITY, 'mobile-api'])).toBe(
      2
    )

    // Already-released hosts check `search.get('chatAttention') === '1'`, so sending `2` unconditionally would cause
    // them to stop emitting all `chat.attention` events and silently break chat pushes.
    const legacyHostWantsChatAttention = (search: URLSearchParams) => search.get(FLEET_CHAT_ATTENTION_QUERY) === '1'
    expect(
      legacyHostWantsChatAttention(
        new URLSearchParams({ [FLEET_CHAT_ATTENTION_QUERY]: String(fleetChatAttentionQueryValue([])) })
      )
    ).toBe(true)
    expect(
      legacyHostWantsChatAttention(
        new URLSearchParams({
          [FLEET_CHAT_ATTENTION_QUERY]: String(fleetChatAttentionQueryValue([FLEET_CHAT_ATTENTION_SYNC_CAPABILITY])),
        })
      )
    ).toBe(false)
  })

  it('parses chatAttention=2 instance events (cleared and snapshot)', () => {
    expect(
      fleetInstanceEventSchema.parse({
        seq: 4,
        at,
        type: 'chat.attention.cleared',
        conversationId: 'conv-1',
      })
    ).toEqual({
      seq: 4,
      at,
      botId: null,
      type: 'chat.attention.cleared',
      conversationId: 'conv-1',
    })
    expect(() =>
      fleetInstanceEventSchema.parse({
        seq: 4,
        at,
        type: 'chat.attention.cleared',
        conversationId: '',
      })
    ).toThrow()

    const conversation = { conversationId: 'conv-1', name: 'Deploy check', kind: 'plan' as const, at }
    expect(fleetChatAttentionSnapshotItemSchema.parse(conversation)).toEqual(conversation)
    expect(
      fleetInstanceEventSchema.parse({
        seq: 5,
        at,
        type: 'chat.attention.snapshot',
        conversations: [conversation],
      })
    ).toEqual({
      seq: 5,
      at,
      botId: null,
      type: 'chat.attention.snapshot',
      conversations: [conversation],
    })
    expect(
      fleetInstanceEventSchema.parse({
        seq: 6,
        at,
        type: 'chat.attention.snapshot',
        conversations: [],
      })
    ).toMatchObject({ type: 'chat.attention.snapshot', conversations: [] })
    expect(() =>
      fleetInstanceEventSchema.parse({
        seq: 7,
        at,
        type: 'chat.attention.snapshot',
        conversations: Array.from({ length: 2001 }, () => conversation),
      })
    ).toThrow()
    expect(() =>
      fleetInstanceEventSchema.parse({
        seq: 8,
        at,
        type: 'chat.attention.snapshot',
        conversations: [{ ...conversation, kind: 'cleared' }],
      })
    ).toThrow()
  })

  it('accepts optional badgeOthers on push registration while keeping the schema strict', () => {
    expect(fleetPushRegistrationRequestSchema.parse(basePushRegistration)).toEqual(basePushRegistration)
    expect(fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: 0 }).badgeOthers).toBe(0)
    expect(fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: 12 }).badgeOthers).toBe(12)
    expect(fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: 99_999 }).badgeOthers).toBe(
      99_999
    )
    expect(
      fleetPushRegistrationSchema.parse({ ...basePushRegistration, badgeOthers: 3, updatedAt: at }).badgeOthers
    ).toBe(3)
    expect(fleetPushRegistrationSchema.parse({ ...basePushRegistration, updatedAt: at }).badgeOthers).toBeUndefined()

    expect(() => fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: -1 })).toThrow()
    expect(() => fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: 1.5 })).toThrow()
    expect(() => fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, badgeOthers: 100_000 })).toThrow()
    expect(() => fleetPushRegistrationRequestSchema.parse({ ...basePushRegistration, unknownKey: 1 })).toThrow()

    // Older gateways validate registrations with a strict schema that predates `badgeOthers`.
    const legacyRegistrationSchema = fleetPushRegistrationRequestSchema.omit({ badgeOthers: true }).strict()
    expect(legacyRegistrationSchema.safeParse(basePushRegistration).success).toBe(true)
    expect(legacyRegistrationSchema.safeParse({ ...basePushRegistration, badgeOthers: 1 }).success).toBe(false)
  })

  it('lets the gateway clear chat attention marks on a host that syncs them', () => {
    const route = FLEET_INSTANCE_ROUTES.chatAttentionClear
    expect(route).toMatchObject({ method: 'POST', path: '/v1/chat-attention/clear' })
    expect(route.body.parse({ conversationIds: ['conv-1', 'conv-2'] })).toEqual({
      conversationIds: ['conv-1', 'conv-2'],
    })
    expect(() => route.body.parse({ conversationIds: [] })).toThrow()
    expect(() => route.body.parse({ conversationIds: [''] })).toThrow()
    expect(() => route.body.parse({ conversationIds: Array.from({ length: 201 }, (_, i) => `c${i}`) })).toThrow()
    expect(() => route.body.parse({ conversationIds: ['conv-1'], extra: true })).toThrow()
    expect(route.response.parse({ cleared: [] })).toEqual({ cleared: [] })
    expect(route.response.parse({ cleared: ['conv-1'] })).toEqual({ cleared: ['conv-1'] })
  })
})
