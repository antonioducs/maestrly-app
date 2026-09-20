import { expect, it } from 'vitest'
import { HttpTransport } from '../src/transport.js'
import { ConnectorsApi } from '../src/connectors.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const connectionId = '33333333-3333-4333-8333-333333333333'

const connection = {
  id: connectionId,
  organizationId,
  ownerUserId: 'owner',
  clientId: 'grok-bot',
  name: 'Grok Bot',
  grants: [{ projectId, actions: ['tasks:read', 'tasks:write'] }],
  cancelOnRevoke: true,
  version: 1,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-09-20T12:00:00.000Z',
  updatedAt: '2026-09-20T12:00:00.000Z',
}

const endpoint = {
  id: '44444444-4444-4444-8444-444444444444',
  connectionId,
  url: 'https://routines.grok.example/hook',
  enabled: true,
  secretFingerprint: 'a'.repeat(32),
  lastStatus: null,
  lastDeliveredAt: null,
  failureCount: 0,
  createdAt: '2026-09-20T12:00:00.000Z',
  updatedAt: '2026-09-20T12:00:00.000Z',
}

function transportFor(handler: (input: { url: string; init: RequestInit }) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    const body = handler(call)
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: body === undefined ? 204 : 200,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { api: new ConnectorsApi(new HttpTransport({ baseUrl: 'https://fixture.test', fetch: fetchImpl })), calls }
}

it('reads the connector overview and validates every connection it returns', async () => {
  const { api, calls } = transportFor(() => ({
    mcpUrl: 'https://fixture.test/mcp',
    protectedResourceMetadataUrl: 'https://fixture.test/.well-known/oauth-protected-resource/mcp',
    authorizationServer: 'https://fixture.test/api/auth',
    actions: ['tasks:read'],
    dynamicRegistration: false,
    connections: [connection],
  }))
  const overview = await api.overview(organizationId)
  expect(calls[0]!.url).toBe(`https://fixture.test/api/v1/organizations/${organizationId}/connectors`)
  expect(overview.connections[0]!.grants[0]!.actions).toEqual(['tasks:read', 'tasks:write'])
})

it('sends the callback secret but only ever reads back its fingerprint', async () => {
  const { api, calls } = transportFor(() => endpoint)
  const stored = await api.setNotificationEndpoint(organizationId, connectionId, {
    url: 'https://routines.grok.example/hook',
    secret: 'a-callback-secret-that-is-long-enough',
    enabled: true,
  })
  expect(calls[0]!.init.method).toBe('PUT')
  expect(calls[0]!.url).toBe(
    `https://fixture.test/api/v1/organizations/${organizationId}/connectors/${connectionId}/notification-endpoint`
  )
  expect(String(calls[0]!.init.body)).toContain('a-callback-secret-that-is-long-enough')
  expect(JSON.stringify(stored)).not.toContain('a-callback-secret-that-is-long-enough')
  expect(stored.secretFingerprint).toBe('a'.repeat(32))
})

it('reports a connection without a callback instead of inventing one', async () => {
  const { api } = transportFor(() => ({ endpoint: null }))
  expect(await api.notificationEndpoint(organizationId, connectionId)).toBeNull()
})

it('removes a callback with a request that expects no content', async () => {
  const { api, calls } = transportFor(() => undefined)
  await api.removeNotificationEndpoint(organizationId, connectionId)
  expect(calls[0]!.init.method).toBe('DELETE')
})
