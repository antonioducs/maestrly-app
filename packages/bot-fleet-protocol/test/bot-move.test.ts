import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_MOVE_FEATURE,
  FLEET_BOT_MOVE_LIMITS,
  FLEET_BOT_MOVE_PHASES,
  FLEET_BOT_MOVE_SHA256_HEADER,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  fleetBotMoveDigestSchema,
  fleetBotMoveRequestSchema,
  fleetBotMoveSchema,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetInstanceBotFreezeSchema,
  fleetInstanceBotImportSchema,
} from '../src/index.js'

const at = '2026-10-17T12:00:00.000Z'
const key = '11111111-1111-4111-8111-111111111111'
const sha = 'a'.repeat(64)
const bot = {
  id: 'scout',
  name: 'Scout',
  role: '',
  instructions: '',
  tint: '#336699',
  ceiling: 'ask',
  selection: null,
  talksTo: [],
  paused: false,
  lifecycle: 'running',
  setup: { step: 'ready', error: null, errorMessage: null },
  status: 'idle',
  activity: null,
  pendingCount: 0,
  accounts: { connected: true, providers: [] },
  takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
  resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
  screen: { width: 1280, height: 800, display: ':1' },
  appVersion: '0.21.0',
  environmentId: 'work',
  createdAt: at,
  updatedAt: at,
}
const move = {
  id: 'move-1',
  botId: 'scout',
  fromEnvironmentId: 'work',
  toEnvironmentId: 'home',
  newEnvironment: false,
  phase: 'exporting',
  state: 'running',
  error: null,
  startedAt: at,
  updatedAt: at,
}
const digest = {
  conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  messages: 3,
  lastSeq: 3,
  messagesSha256: sha,
  memories: 1,
  memoriesSha256: sha,
  files: 4,
  filesSha256: sha,
}

describe('bot move contracts', () => {
  it('names the feature, its limits and the package header', () => {
    expect(FLEET_BOT_MOVE_FEATURE).toBe('bot-move')
    expect(FLEET_BOT_MOVE_SHA256_HEADER).toBe('X-Maestrly-Package-Sha256')
    expect(FLEET_BOT_MOVE_LIMITS.packageMaxBytes).toBeGreaterThan(1024 ** 3)
    expect(FLEET_BOT_MOVE_PHASES).toEqual([
      'prepared',
      'freezing',
      'exporting',
      'importing',
      'verifying',
      'committing',
      'releasing-source',
      'completed',
    ])
  })

  it('moves to an existing environment or a new one, never both and never neither', () => {
    expect(fleetBotMoveRequestSchema.parse({ environmentId: 'home', idempotencyKey: key })).toEqual({
      environmentId: 'home',
      idempotencyKey: key,
    })
    expect(
      fleetBotMoveRequestSchema.parse({ newEnvironment: { name: 'Home' }, idempotencyKey: key }).newEnvironment
    ).toEqual({ name: 'Home' })
    for (const request of [
      { idempotencyKey: key },
      { environmentId: 'home', newEnvironment: { name: 'Home' }, idempotencyKey: key },
      { environmentId: 'Home Office', idempotencyKey: key },
      { newEnvironment: { name: '' }, idempotencyKey: key },
      { newEnvironment: { name: 'Home', memoryLimitBytes: null }, idempotencyKey: key },
      { environmentId: 'home' },
      { environmentId: 'home', idempotencyKey: key, slot: 2 },
    ])
      expect(fleetBotMoveRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false)
  })

  it('carries a running move in the bot, and none from older gateways', () => {
    expect(fleetBotSchema.parse(bot).move).toBeNull()
    expect(fleetBotSchema.parse({ ...bot, move }).move).toEqual(move)
    expect(fleetGatewayEventSchema.parse({ type: 'bot.updated', at, bot: { ...bot, move } })).toMatchObject({
      bot: { move: { phase: 'exporting', state: 'running' } },
    })
    const failed = { ...move, state: 'failed', error: { code: 'INSTANCE_UNAVAILABLE', message: 'Unavailable' } }
    expect(fleetBotMoveSchema.parse(failed).error?.code).toBe('INSTANCE_UNAVAILABLE')
    for (const change of [
      { phase: 'thawing' },
      { state: 'paused' },
      { toEnvironmentId: 'Home Office' },
      { error: { code: 'BROKEN', message: 'x' } },
      { error: { code: 'INTERNAL', message: 'x'.repeat(501) } },
    ])
      expect(fleetBotMoveSchema.safeParse({ ...move, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('reduces what moves to counts and hashes, and nothing more', () => {
    expect(fleetBotMoveDigestSchema.parse(digest)).toEqual(digest)
    expect(fleetBotMoveDigestSchema.parse({ ...digest, conversationId: null, lastSeq: -1 }).lastSeq).toBe(-1)
    expect(fleetInstanceBotFreezeSchema.parse({ digest }).digest).toEqual(digest)
    expect(fleetInstanceBotImportSchema.parse({ digest }).digest).toEqual(digest)
    for (const change of [{ messagesSha256: 'xyz' }, { files: -1 }, { path: '/home/maestrly' }])
      expect(fleetBotMoveDigestSchema.safeParse({ ...digest, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('declares the gateway and instance routes of a move', () => {
    expect(FLEET_GATEWAY_ROUTES.botMove).toMatchObject({ method: 'POST', path: '/v1/bots/:id/move' })
    expect(FLEET_GATEWAY_ROUTES.botMove.body).toBe(fleetBotMoveRequestSchema)
    expect(FLEET_GATEWAY_ROUTES.botMove.response).toBe(fleetBotMoveSchema)
    expect(FLEET_GATEWAY_ROUTES.botMoveGet).toMatchObject({ method: 'GET', path: '/v1/bots/:id/move', body: null })
    expect(FLEET_INSTANCE_ROUTES.botFreeze).toMatchObject({ method: 'POST', path: '/v1/bots/:botId/freeze' })
    expect(FLEET_INSTANCE_ROUTES.botFreeze.response).toBe(fleetInstanceBotFreezeSchema)
    // The package crosses as raw bytes on both legs.
    expect(FLEET_INSTANCE_ROUTES.botExport).toEqual({
      method: 'GET',
      path: '/v1/bots/:botId/export',
      body: null,
      response: null,
    })
    expect(FLEET_INSTANCE_ROUTES.botImport).toMatchObject({ method: 'PUT', path: '/v1/bots/:botId/import', body: null })
    expect(FLEET_INSTANCE_ROUTES.botImport.response).toBe(fleetInstanceBotImportSchema)
  })
})
