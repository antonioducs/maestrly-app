import { describe, expect, it } from 'vitest'
import {
  ROUTINE_CAPABILITY,
  ROUTINE_HOST_CAPABILITY,
  ROUTINE_LIMITS,
  ROUTINE_METHODS,
  ROUTINE_MUTATIONS,
  VOICE_HOST_CAPABILITY,
  VOICE_LIMITS,
  VOICE_MUTATIONS,
  guestFrameSchema,
  hostFrameSchema,
  isTimeZone,
  requestSchema,
  routineMethods,
  routineParamSchemas,
  routineProposalSchema,
  routineRequestSchema,
  routineResultSchemas,
  routineResultSchemasRuntime,
  routineSpecSchema,
  routineTurnContextSchema,
  scheduleSpecSchema,
  voiceMethods,
  voiceRequestSchema,
  voiceResultSchemas,
} from '../src/index.js'

const envelope = { version: 1, id: 'r' }
const spec = {
  name: 'Resumo de segunda',
  request: 'Prepare o resumo semanal da equipe',
  target: { kind: 'bot', id: 'bot-1' },
  schedule: { kind: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
}

describe('routine wire contracts', () => {
  it('shares the v1 envelope and gives every routine method an exhaustive result schema', () => {
    expect(routineMethods.length).toBeGreaterThanOrEqual(14)
    for (const method of routineMethods) expect(routineResultSchemas[method], method).toBeDefined()
    for (const mutation of ROUTINE_MUTATIONS) expect(routineMethods).toContain(mutation)
    expect(requestSchema.safeParse({ ...envelope, method: 'routine.list', params: {} }).success).toBe(true)
    expect(requestSchema.safeParse({ version: 2, id: 'r', method: 'routine.list', params: {} }).success).toBe(false)
    // There is no generic executor hiding in this namespace.
    expect(requestSchema.safeParse({ ...envelope, method: 'routine.exec', params: { command: 'ls' } }).success).toBe(false)
  })

  it('refuses cron, shell, Host paths and credentials inside a routine specification', () => {
    expect(routineSpecSchema.safeParse(spec).success).toBe(true)
    for (const invalid of [
      { ...spec, schedule: { kind: 'cron', expression: '*/5 * * * *' } },
      { ...spec, schedule: { kind: 'daily', hour: 9, minute: 0, timeZone: 'Mars/Olympus' } },
      { ...spec, schedule: { kind: 'daily', hour: 24, minute: 0, timeZone: 'UTC' } },
      // An interval that would hammer the Host every minute is not offered at all.
      { ...spec, schedule: { kind: 'interval', anchorUtc: '2026-01-01T00:00:00.000Z', everyMinutes: 1, timeZone: 'UTC' } },
      { ...spec, command: 'rm -rf /' },
      { ...spec, workingDirectory: '/Users/someone/state' },
      { ...spec, apiKey: 'sk-live-1234' },
      { ...spec, target: { kind: 'host', id: 'h-1' } },
      { ...spec, target: { kind: 'bot', id: 'bot-1', hostAddress: '10.0.0.4:7777' } },
      { ...spec, request: 'x'.repeat(16_001) },
      { ...spec, name: 'x'.repeat(81) },
      { ...spec, resourceIds: Array.from({ length: 9 }, (_, index) => `a-${index}`) },
    ])
      expect(routineSpecSchema.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 80)).toBe(false)
  })

  it('applies conservative defaults and keeps the ceiling inside product limits', () => {
    const parsed = routineSpecSchema.parse(spec)
    expect(parsed.misfirePolicy).toBe('skip')
    expect(parsed.ceiling.permissionMode).toBe('ask')
    expect(parsed.queueDeadlineMs).toBe(ROUTINE_LIMITS.queueDeadlineMs)
    expect(parsed.resourceIds).toEqual([])
    expect(routineSpecSchema.safeParse({ ...spec, ceiling: { activeMs: 10 * 60 * 60_000, maxTools: 10 } }).success).toBe(false)
    expect(routineSpecSchema.safeParse({ ...spec, queueDeadlineMs: 48 * 60 * 60_000 }).success).toBe(false)
  })

  it('accepts only known IANA zones and every supported calendar shape', () => {
    expect(isTimeZone('America/Sao_Paulo')).toBe(true)
    expect(isTimeZone('UTC')).toBe(true)
    expect(isTimeZone('../../etc/localtime')).toBe(false)
    expect(isTimeZone('Nowhere/Nothing')).toBe(false)
    for (const schedule of [
      { kind: 'once', atUtc: '2026-03-09T12:00:00.000Z', timeZone: 'America/New_York' },
      { kind: 'daily', hour: 7, minute: 30, timeZone: 'America/Sao_Paulo' },
      { kind: 'weekly', daysOfWeek: [1, 3, 5], hour: 9, minute: 0, timeZone: 'Europe/Lisbon' },
      { kind: 'monthly', dayOfMonth: 31, hour: 8, minute: 0, timeZone: 'America/Sao_Paulo' },
      { kind: 'interval', anchorUtc: '2026-01-01T00:00:00.000Z', everyMinutes: 30, timeZone: 'UTC' },
    ])
      expect(scheduleSpecSchema.safeParse(schedule).success, schedule.kind).toBe(true)
    expect(scheduleSpecSchema.safeParse({ kind: 'weekly', daysOfWeek: [0], hour: 9, minute: 0, timeZone: 'UTC' }).success).toBe(false)
    expect(scheduleSpecSchema.safeParse({ kind: 'weekly', daysOfWeek: [], hour: 9, minute: 0, timeZone: 'UTC' }).success).toBe(false)
  })

  it('never lets an activation happen without the preview it was shown', () => {
    const activate = (params: Record<string, unknown>) => requestSchema.safeParse({ ...envelope, method: 'routine.activate', params }).success
    expect(activate({ previewId: 'p', fingerprint: 'a'.repeat(64), idempotencyKey: 'k', confirmSchedule: true })).toBe(true)
    expect(activate({ previewId: 'p', fingerprint: 'a'.repeat(64), idempotencyKey: 'k' })).toBe(false)
    expect(activate({ previewId: 'p', fingerprint: 'a'.repeat(64), idempotencyKey: 'k', confirmSchedule: false })).toBe(false)
    expect(activate({ spec, idempotencyKey: 'k', confirmSchedule: true })).toBe(false)
    // Editing goes back through preview; there is no direct update endpoint.
    expect(routineMethods).not.toContain('routine.update' as never)
  })
})

describe('routine proposal lane', () => {
  it('lets a model create an inert card and nothing else', () => {
    expect([...ROUTINE_METHODS]).toEqual(['routine_propose', 'routine_proposal_status'])
    for (const method of ROUTINE_METHODS) {
      expect(routineParamSchemas[method]).toBeDefined()
      expect(routineResultSchemasRuntime[method]).toBeDefined()
    }
    expect(routineResultSchemasRuntime.routine_propose.parse({ proposalId: 'p', status: 'pending', requiresHumanConfirmation: true, guidance: 'ok' }).requiresHumanConfirmation).toBe(true)
    expect(routineResultSchemasRuntime.routine_propose.safeParse({ proposalId: 'p', status: 'pending', requiresHumanConfirmation: false, guidance: '' }).success).toBe(false)
  })

  it('gives a proposal no way to pick another target, author or identity', () => {
    const propose = (params: Record<string, unknown>) => routineParamSchemas.routine_propose.safeParse(params).success
    expect(propose({ name: 'R', request: 'faça', schedule: spec.schedule })).toBe(true)
    expect(propose({ name: 'R', request: 'faça', clarification: 'de manhã é 9h?' })).toBe(true)
    for (const forged of [
      { name: 'R', request: 'faça', targetBotId: 'outro-bot' },
      { name: 'R', request: 'faça', teamId: 'equipe-1' },
      { name: 'R', request: 'faça', author: 'human' },
      { name: 'R', request: 'faça', asUser: true },
      { name: 'R', request: 'faça', permissionMode: 'full-vm' },
      { name: 'R', request: 'faça', approve: true },
    ])
      expect(propose(forged), JSON.stringify(forged)).toBe(false)
  })

  it('records who proposed without ever letting the card claim to be a person', () => {
    const proposal = {
      id: 'p1',
      target: { kind: 'bot', id: 'bot-1' },
      proposedByBotId: 'bot-1',
      turnId: 't1',
      name: 'R',
      request: 'faça',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      revision: 0,
    }
    expect(routineProposalSchema.safeParse(proposal).success).toBe(true)
    expect(routineProposalSchema.safeParse({ ...proposal, author: { kind: 'human' } }).success).toBe(false)
    expect(routineProposalSchema.safeParse({ ...proposal, status: 'active' }).success).toBe(false)
  })

  it('carries the proposal lane and the routine context only as explicit, discriminated shapes', () => {
    expect(guestFrameSchema.safeParse({ type: 'routine.request', id: 'q', turnId: 't', generation: 1, method: 'routine_propose', params: {} }).success).toBe(true)
    expect(guestFrameSchema.safeParse({ type: 'routine.request', id: 'q', turnId: 't', generation: 1, method: 'routine_activate', params: {} }).success).toBe(false)
    expect(hostFrameSchema.safeParse({ type: 'routine.response', id: 'q', result: { proposalId: 'p' } }).success).toBe(true)
    const context = routineTurnContextSchema.parse({
      nowUtc: '2026-01-01T12:00:00.000Z',
      nowLocal: '2026-01-01 09:00',
      timeZone: 'America/Sao_Paulo',
      canPropose: false,
      proposalsRemaining: 0,
      tools: [],
    })
    expect(context.canPropose).toBe(false)
    expect(context.existing).toEqual([])
  })
})

describe('voice wire contracts', () => {
  it('gives every voice method an exhaustive result schema and shares the envelope', () => {
    expect(voiceMethods.length).toBeGreaterThanOrEqual(13)
    for (const method of voiceMethods) expect(voiceResultSchemas[method], method).toBeDefined()
    for (const mutation of VOICE_MUTATIONS) expect(voiceMethods).toContain(mutation)
    expect(requestSchema.safeParse({ ...envelope, method: 'voice.status', params: {} }).success).toBe(true)
  })

  it('accepts audio only through the explicit chunked transfer, never a path or a URL', () => {
    const begin = (params: Record<string, unknown>) => voiceRequestSchema.safeParse({ ...envelope, method: 'voice.upload.begin', params }).success
    const valid = { target: { kind: 'bot', id: 'b' }, clientClipId: 'c', sizeBytes: 32_044, durationMs: 1_000, sha256: 'a'.repeat(64) }
    expect(begin(valid)).toBe(true)
    expect(begin({ ...valid, path: '/tmp/audio.wav' })).toBe(false)
    expect(begin({ ...valid, url: 'https://example.com/a.mp3' })).toBe(false)
    expect(begin({ ...valid, mimeType: 'audio/webm' })).toBe(false)
    expect(begin({ ...valid, sizeBytes: VOICE_LIMITS.maxWavBytes + 1 })).toBe(false)
    expect(begin({ ...valid, durationMs: VOICE_LIMITS.maxDurationMs + 1 })).toBe(false)
    expect(begin({ ...valid, sha256: 'nope' })).toBe(false)
    // Reading back is by identity, and one chunk at a time.
    expect(voiceRequestSchema.safeParse({ ...envelope, method: 'voice.clip.read', params: { clipId: 'c', offset: 0, length: VOICE_LIMITS.chunkBytes + 1 } }).success).toBe(false)
  })

  it('refuses to send a voice message without confirmed, current text', () => {
    const send = (params: Record<string, unknown>) => voiceRequestSchema.safeParse({ ...envelope, method: 'voice.send', params }).success
    expect(send({ clipId: 'c', transcriptRevision: 1, editedText: 'oi', clientMessageId: 'm' })).toBe(true)
    expect(send({ clipId: 'c', transcriptRevision: 1, editedText: '', clientMessageId: 'm' })).toBe(false)
    expect(send({ clipId: 'c', editedText: 'oi', clientMessageId: 'm' })).toBe(false)
    // The recipient comes from the clip, so a send cannot be redirected to another bot.
    expect(send({ clipId: 'c', transcriptRevision: 1, editedText: 'oi', clientMessageId: 'm', target: { kind: 'bot', id: 'outro' } })).toBe(false)
  })
})

describe('capability negotiation', () => {
  it('names the new capabilities explicitly so an older Host or guest is told to update', () => {
    expect(ROUTINE_HOST_CAPABILITY).toBe('routines.v1')
    expect(VOICE_HOST_CAPABILITY).toBe('voice.messages.v1')
    expect(ROUTINE_CAPABILITY).toBe('bot.routines.v1')
  })
  it('keeps the routine namespace disjoint from the team namespace', () => {
    for (const method of routineMethods) expect(method.startsWith('routine.')).toBe(true)
    for (const method of voiceMethods) expect(method.startsWith('voice.')).toBe(true)
    expect(routineRequestSchema.safeParse({ ...envelope, method: 'team.list', params: {} }).success).toBe(false)
  })
})
