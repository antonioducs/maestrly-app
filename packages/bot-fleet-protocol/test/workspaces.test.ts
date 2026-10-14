import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_ENV,
  FLEET_BRIDGE_LIMITS,
  FLEET_GATEWAY_ENV,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_BRIDGE_PATH,
  FLEET_WORKSPACES_HOST_FEATURE,
  fleetBridgeTicketResponseSchema,
  fleetCreateEnvironmentRequestSchema,
  fleetEnvironmentKindSchema,
  fleetEnvironmentSchema,
  fleetInstanceHealthSchema,
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
  it('names the feature, the container variables and the bridge path and limits', () => {
    expect(FLEET_WORKSPACES_HOST_FEATURE).toBe('workspaces-host')
    expect(FLEET_BOT_ENV.serverMode).toBe('MAESTRLY_SERVER_MODE')
    expect(FLEET_BOT_ENV.workspacesRoot).toBe('MAESTRLY_WORKSPACES_ROOT')
    // Not the bot gateway token, which images from before environments read as their one bot's.
    expect(FLEET_BOT_ENV.hostGatewayToken).toBe('MAESTRLY_HOST_GATEWAY_TOKEN')
    expect(FLEET_GATEWAY_ENV.workspacesRoot).toBe('MAESTRLY_GATEWAY_WORKSPACES_ROOT')
    expect(FLEET_INSTANCE_BRIDGE_PATH).toBe('/v1/bridge')
    expect(FLEET_BRIDGE_LIMITS).toEqual({ ticketTtlMs: 30_000, perDevice: 8 })
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
