import { expect, it } from 'vitest'
import { HttpTransport } from '../src/transport.js'
import { BotDesktopClient, BotOwnerApi } from '../src/bot-conversations.js'

const desktopId = '33333333-3333-4333-8333-333333333333'
const connectionId = '22222222-2222-4222-8222-222222222222'
const conversationId = '11111111-1111-4111-8111-111111111111'
const commandId = '44444444-4444-4444-8444-444444444444'
const leaseToken = '77777777-7777-4777-8777-777777777777'

const desktop = {
  id: desktopId,
  ownerUserId: 'user-1',
  name: 'Laptop',
  online: true,
  lastSeenAt: '2026-09-20T12:00:00.000Z',
  revokedAt: null,
  inventory: null,
  createdAt: '2026-09-20T11:00:00.000Z',
}
const connection = {
  id: connectionId,
  name: 'Grok',
  ownerUserId: 'user-1',
  desktopId,
  clientId: 'maestrly-bot-abc',
  grants: [{ workspaceId: 'ws-1', actions: ['chats:read', 'chats:write'] }],
  revokedAt: null,
  version: 1,
}
const conversation = {
  id: conversationId,
  connectionId,
  desktopId,
  workspaceId: 'ws-1',
  name: 'Release notes',
  baseBranch: 'main',
  selection: { selectionId: 'account/model' },
  managementState: 'active',
  version: 1,
}
const command = { id: commandId, conversationId, kind: 'send', payload: { text: 'hi' }, status: 'queued', version: 1 }

function harness(handler: (input: { url: string; init: RequestInit }) => unknown) {
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
  return { transport: new HttpTransport({ baseUrl: 'https://fixture.test', fetch: fetchImpl }), calls }
}

const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name]

it('reads the owner overview from the personal route and validates what it returns', async () => {
  const { transport, calls } = harness(() => ({
    mcp: {
      url: 'https://fixture.test/mcp/bots',
      resource: 'https://fixture.test/mcp/bots',
      authorizationServer: 'https://fixture.test/api/auth',
      protectedResourceMetadataUrl: 'https://fixture.test/.well-known/oauth-protected-resource/mcp/bots',
      scopes: ['api:read'],
    },
    actions: ['chats:read'],
    desktops: [desktop],
    connections: [connection],
  }))
  const overview = await new BotOwnerApi(transport).overview()
  expect(calls[0]!.url).toBe('https://fixture.test/api/v1/bots')
  expect(calls[0]!.url).not.toContain('organizations')
  expect(overview.connections[0]!.grants[0]!.actions).toEqual(['chats:read', 'chats:write'])
  expect(overview.desktops[0]!.name).toBe('Laptop')
})

it('registers a desktop with an idempotency key and returns the credential exactly once', async () => {
  const { transport, calls } = harness(() => ({ desktop, credential: 'c'.repeat(43) }))
  const registration = await new BotOwnerApi(transport).registerDesktop('Laptop', 'register-1')
  expect(calls[0]!.url).toBe('https://fixture.test/api/v1/bots/desktops')
  expect(headerOf(calls[0]!.init, 'idempotency-key')).toBe('register-1')
  expect(registration.credential).toHaveLength(43)
  expect(JSON.stringify(registration.desktop)).not.toContain('c'.repeat(43))
})

it('creates a connection and reports the MCP configuration the bot needs', async () => {
  const { transport, calls } = harness(() => ({
    connection,
    mcp: {
      url: 'https://fixture.test/mcp/bots',
      resource: 'https://fixture.test/mcp/bots',
      authorizationServer: 'https://fixture.test/api/auth',
      protectedResourceMetadataUrl: 'https://fixture.test/.well-known/oauth-protected-resource/mcp/bots',
      clientId: 'maestrly-bot-abc',
      scopes: ['api:read', 'api:write'],
    },
  }))
  const created = await new BotOwnerApi(transport).connect(
    { name: 'Grok', desktopId, grants: [{ workspaceId: 'ws-1', actions: ['chats:read', 'chats:write'] }] },
    'connect-1'
  )
  expect(calls[0]!.init.method).toBe('POST')
  expect(created.mcp.resource).toBe('https://fixture.test/mcp/bots')
  expect(created.connection.id).toBe(connectionId)
})

it('pauses a conversation through the owner route only', async () => {
  const { transport, calls } = harness(() => ({ ...conversation, managementState: 'paused', version: 2 }))
  const paused = await new BotOwnerApi(transport).setManagement(
    conversationId,
    { expectedVersion: 1, state: 'paused' },
    'pause-1'
  )
  expect(calls[0]!.url).toBe(`https://fixture.test/api/v1/bots/conversations/${conversationId}/management`)
  expect(paused.managementState).toBe('paused')
})

it('sends the device credential on every desktop call and never on an owner call', async () => {
  const { transport, calls } = harness(({ url }) => (url.endsWith('/claim') ? null : { ok: true }))
  const client = new BotDesktopClient(transport, { desktopId, credential: 'd'.repeat(40) })
  await client.publishInventory({ capability: 'bot:conversations:v1', enabled: true, workspaces: [], selections: [] })
  expect(calls[0]!.url).toBe('https://fixture.test/api/v1/bot-desktops/inventory')
  expect(headerOf(calls[0]!.init, 'authorization')).toBe('BotDesktop ' + 'd'.repeat(40))
  expect(headerOf(calls[0]!.init, 'x-maestrly-bot-desktop-id')).toBe(desktopId)
  // No work waiting is a null claim, not an error and not an invented command.
  expect(await client.claim()).toBeNull()
})

it('carries the lease token and fence on every claimed-work call', async () => {
  const { transport, calls } = harness(({ url }) => {
    if (url.includes('/controls') || url.includes('/lease'))
      return {
        cancellationRequested: true,
        managementState: 'active',
        leaseExpiresAt: '2026-09-20T12:00:30.000Z',
      }
    if (url.endsWith('/events')) return { accepted: ['e1'] }
    return { ...command, status: 'succeeded' }
  })
  const client = new BotDesktopClient(transport, { desktopId, credential: 'd'.repeat(40) })
  const lease = { leaseToken, fence: 4 }
  expect((await client.renewLease(commandId, lease)).cancellationRequested).toBe(true)
  expect(String(calls[0]!.init.body)).toContain(leaseToken)
  const controls = await client.controls(commandId, lease)
  expect(controls.managementState).toBe('active')
  expect(calls[1]!.url).toContain(`leaseToken=${leaseToken}&fence=4`)
  expect(
    await client.uploadEvents(commandId, lease, [
      { eventId: 'e1', payload: { type: 'delta', messageId: conversationId, partId: 'p1', kind: 'text', delta: 'hi' } },
    ])
  ).toEqual(['e1'])
  expect(String(calls[2]!.init.body)).toContain('"fence":4')
  const finished = await client.complete(commandId, lease, { status: 'succeeded' })
  expect(finished.status).toBe('succeeded')
  expect(String(calls[3]!.init.body)).toContain('"status":"succeeded"')
})
