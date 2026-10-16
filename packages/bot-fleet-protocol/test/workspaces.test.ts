import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_ENV,
  FLEET_BRIDGE_LIMITS,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_CONVERSATION_COMPUTER_LIMITS,
  FLEET_CONVERSATION_COMPUTERS_FEATURE,
  FLEET_GATEWAY_ENV,
  FLEET_WORKSPACES_ENVIRONMENTS_FEATURE,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_BRIDGE_PATH,
  FLEET_INSTANCE_ROUTES,
  FLEET_WORKSPACES_HOST_FEATURE,
  fleetBridgeTicketResponseSchema,
  fleetConversationScreenTicketRequestSchema,
  fleetHostConversationIdSchema,
  fleetCreateEnvironmentRequestSchema,
  fleetEnvironmentKindSchema,
  fleetEnvironmentSchema,
  fleetFeaturesSchema,
  fleetInstanceHealthSchema,
  fleetPatchEnvironmentRequestSchema,
} from '../src/index.js'

const at = '2026-09-29T00:00:00.000Z'
const environment = {
  id: 'acme',
  name: 'Acme',
  lifecycle: 'running',
  setup: { step: 'ready', error: null, errorMessage: null },
  resources: { memoryBytes: 512, memoryLimitBytes: 4 * 1024 ** 3, cpuPercent: 3, startedAt: at },
  memoryLimitBytes: null,
  appVersion: '0.11.0',
  botIds: [],
  createdAt: at,
  updatedAt: at,
}

describe('workspaces environments', () => {
  it('names conversation screens and their limits', () => {
    expect(FLEET_CONVERSATION_COMPUTERS_FEATURE).toBe('conversation-computers')
    expect(FLEET_CONVERSATION_COMPUTER_LIMITS).toEqual({
      slots: 8,
      idleMs: 60_000,
      checkEveryMs: 5_000,
      firstDisplay: 10,
      lastDisplay: 4095,
    })
    expect(FLEET_GATEWAY_ROUTES.conversationScreenTicket).toMatchObject({
      method: 'POST',
      path: '/v1/environments/:eid/conversations/:cid/screen-tickets',
    })
    expect(FLEET_INSTANCE_ROUTES.conversationScreenView.path).toBe(
      '/v1/conversations/:conversationId/screen/:surface/view'
    )
    expect(FLEET_INSTANCE_ROUTES.conversationScreenControl.path).toBe(
      '/v1/conversations/:conversationId/screen/:surface/control'
    )
  })

  it('validates host conversation ids and conversation screen tickets', () => {
    expect(fleetHostConversationIdSchema.safeParse(randomUUID()).success).toBe(true)
    for (const bad of ['', '-a', 'a/b', 'a'.repeat(65), 'ação', 'a b'])
      expect(fleetHostConversationIdSchema.safeParse(bad).success).toBe(false)
    const ticket = fleetConversationScreenTicketRequestSchema
    expect(ticket.safeParse({ mode: 'control', surface: 'apps' }).success).toBe(true)
    expect(ticket.safeParse({ mode: 'view', surface: 'browser' }).success).toBe(true)
    expect(ticket.safeParse({ mode: 'control', surface: 'browser' }).success).toBe(false)
    expect(ticket.safeParse({ mode: 'view', surface: 'apps', extra: 1 }).success).toBe(false)
  })

  it('names the feature, the container variables and the bridge path and limits', () => {
    expect(FLEET_WORKSPACES_HOST_FEATURE).toBe('workspaces-host')
    expect(FLEET_BOT_ENV.serverMode).toBe('MAESTRLY_SERVER_MODE')
    expect(FLEET_BOT_ENV.workspacesRoot).toBe('MAESTRLY_WORKSPACES_ROOT')
    // Not the bot gateway token, which images from before environments read as their one bot's.
    expect(FLEET_BOT_ENV.hostGatewayToken).toBe('MAESTRLY_HOST_GATEWAY_TOKEN')
    expect(FLEET_GATEWAY_ENV.workspacesRoot).toBe('MAESTRLY_GATEWAY_WORKSPACES_ROOT')
    expect(FLEET_INSTANCE_BRIDGE_PATH).toBe('/v1/bridge')
    // One bridge per workspaces environment, with room for those still closing.
    expect(FLEET_BRIDGE_LIMITS).toEqual({ ticketTtlMs: 30_000, perDevice: 16 })
    expect(FLEET_BRIDGE_LIMITS.perDevice).toBeGreaterThanOrEqual(FLEET_ENVIRONMENT_LIMITS.workspacesMax * 2)
  })

  it('reads an environment from a gateway that predates kinds as a bots environment', () => {
    expect(fleetEnvironmentSchema.parse(environment).kind).toBe('bots')
    expect(fleetEnvironmentSchema.parse({ ...environment, kind: 'workspaces' }).kind).toBe('workspaces')
    expect(fleetEnvironmentSchema.safeParse({ ...environment, kind: 'desktops' }).success).toBe(false)
    expect(fleetEnvironmentKindSchema.options).toEqual(['bots', 'workspaces'])
  })

  it('creates a bots environment unless the request asks for workspaces', () => {
    const idempotencyKey = randomUUID()
    expect(fleetCreateEnvironmentRequestSchema.parse({ name: 'W', idempotencyKey }).kind).toBe('bots')
    expect(fleetCreateEnvironmentRequestSchema.parse({ name: 'W', idempotencyKey, kind: 'workspaces' }).kind).toBe(
      'workspaces'
    )
  })

  it('lets an instance say whether it is busy, and says nothing when it does not know', () => {
    const health = { ok: true, appVersion: '0.11.0', protocol: 1, ready: true, capabilities: ['workspaces-host'] }
    expect(fleetInstanceHealthSchema.parse({ ...health, busy: true }).busy).toBe(true)
    expect('busy' in fleetInstanceHealthSchema.parse(health)).toBe(false)
  })

  it('declares the bridge ticket route and the bridge upgrade', () => {
    expect(FLEET_GATEWAY_ROUTES.environmentBridgeTicket).toMatchObject({
      method: 'POST',
      path: '/v1/environments/:eid/bridge-tickets',
      response: fleetBridgeTicketResponseSchema,
    })
    expect(FLEET_GATEWAY_ROUTES.environmentBridgeTicket.body.safeParse({}).success).toBe(true)
    expect(FLEET_GATEWAY_ROUTES.environmentBridgeTicket.body.safeParse({ mode: 'control' }).success).toBe(false)
    expect(FLEET_GATEWAY_ROUTES.bridge).toEqual({ method: 'GET', path: '/v1/bridge', body: null, response: null })
  })

  it('accepts only a ticket path on the bridge route', () => {
    const ticket = { ticket: 't', path: '/v1/bridge?ticket=t', expiresAt: at }
    expect(fleetBridgeTicketResponseSchema.parse(ticket)).toEqual(ticket)
    for (const path of ['/v1/screen?ticket=t', '/v1/bridge?ticket=t&x=1', 'https://elsewhere/v1/bridge?ticket=t'])
      expect(fleetBridgeTicketResponseSchema.safeParse({ ...ticket, path }).success).toBe(false)
  })
})

describe('several workspaces environments', () => {
  it('names the feature and the variable that names the gateway container', () => {
    expect(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE).toBe('workspaces-environments')
    expect(FLEET_GATEWAY_ENV.container).toBe('MAESTRLY_GATEWAY_CONTAINER')
    // Desktops from before it accept 20 features; later ones accept more.
    expect(fleetFeaturesSchema.safeParse(Array.from({ length: 40 }, (_, index) => 'f' + index)).success).toBe(true)
    expect(fleetFeaturesSchema.safeParse(Array.from({ length: 41 }, (_, index) => 'f' + index)).success).toBe(false)
  })

  it('reads an environment from a gateway that predates them with no limit, stop, tint or isolation', () => {
    expect(fleetEnvironmentSchema.parse(environment)).toMatchObject({
      cpuLimit: null,
      idleStopMinutes: null,
      tint: null,
      isolation: null,
    })
    const isolation = { network: 'own', folder: { mode: 'own', path: '/srv/maestrly/acme' }, restartRequired: true }
    expect(
      fleetEnvironmentSchema.parse({
        ...environment,
        kind: 'workspaces',
        cpuLimit: 2.5,
        idleStopMinutes: 60,
        tint: '#4978c6',
        isolation,
      })
    ).toMatchObject({ cpuLimit: 2.5, idleStopMinutes: 60, tint: '#4978c6', isolation })
    for (const change of [
      { cpuLimit: 0.3 },
      { cpuLimit: 1.1 },
      { cpuLimit: 65 },
      { idleStopMinutes: 10 },
      { idleStopMinutes: 30.5 },
      { tint: 'red' },
      { isolation: { ...isolation, network: 'none' } },
    ])
      expect(fleetEnvironmentSchema.safeParse({ ...environment, ...change }).success, JSON.stringify(change)).toBe(
        false
      )
  })

  it('creates and patches the new settings, each enough for a patch', () => {
    const idempotencyKey = randomUUID()
    expect(
      fleetCreateEnvironmentRequestSchema.parse({
        name: 'Company',
        kind: 'workspaces',
        cpuLimit: 0.5,
        idleStopMinutes: 15,
        tint: '#C29A43',
        idempotencyKey,
      })
    ).toMatchObject({ cpuLimit: 0.5, idleStopMinutes: 15, tint: '#C29A43' })
    for (const patch of [{ cpuLimit: null }, { idleStopMinutes: 1440 }, { tint: null }, { hostFolder: 'own' }])
      expect(fleetPatchEnvironmentRequestSchema.parse(patch)).toEqual(patch)
    expect(fleetPatchEnvironmentRequestSchema.safeParse({ hostFolder: 'none' }).success).toBe(false)
  })
})
