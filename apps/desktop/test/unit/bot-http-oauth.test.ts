/**
 * The embedded bot endpoint, exercised over real HTTP against a real listener and the real SQLite store.
 * Every case goes through the wire: discovery, dynamic registration, the owner's consent, the token
 * endpoint and the MCP endpoint, because the point of this surface is what it accepts from the network.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { BotHttpServer } from '../../src/main/bot/http-server'
import { BOT_TOOLS } from '../../src/main/bot/mcp'
import { LocalBotOAuth } from '../../src/main/bot/oauth'
import { getDb } from '../../src/main/store'

const REDIRECT = 'http://127.0.0.1:9911/callback'
/** The endpoint listens on loopback but is published through a tunnel under this HTTPS URL. */
const PUBLISHED = 'https://bots.maestrly.test'

let oauth: LocalBotOAuth
let endpoint: BotHttpServer
let origin: string
let calls: Array<{ connectionId: string; name: string; input: Record<string, unknown> }>
let toolFailure: string | null

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

beforeEach(async () => {
  freshDb()
  calls = []
  toolFailure = null
  oauth = new LocalBotOAuth()
  endpoint = new BotHttpServer({
    oauth,
    callTool: async (connectionId, name, input) => {
      calls.push({ connectionId, name, input })
      if (toolFailure) throw new Error(toolFailure)
      return { connectionId, name, input }
    },
  })
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  await endpoint.start({ host: '127.0.0.1', port, publicUrl: PUBLISHED })
})

afterEach(async () => {
  await endpoint.stop()
  closeDb()
})

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(
  clientName = 'Grok bot',
  redirectUris: string[] = [REDIRECT],
  extra: Record<string, unknown> = {}
) {
  const response = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris, ...extra }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

async function registered(): Promise<string> {
  const response = await register()
  expect(response.status).toBe(201)
  return response.body.client_id as string
}

async function authorize(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: `${PUBLISHED}/mcp/bots`,
  })
  for (const [key, value] of Object.entries(extra)) {
    if (value === '') params.delete(key)
    else params.set(key, value)
  }
  if (!challenge) params.delete('code_challenge')
  return fetch(`${origin}/oauth/authorize?${params}`, { redirect: 'manual' })
}

async function consentPoll(response: Response): Promise<string> {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
  const html = await response.text()
  const match = html.match(/\/oauth\/authorize\/status\?poll=([A-Za-z0-9_\-%]+)/)
  expect(match).not.toBeNull()
  return decodeURIComponent(match![1])
}

async function pollStatus(poll: string) {
  const response = await fetch(`${origin}/oauth/authorize/status?poll=${encodeURIComponent(poll)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as { status: string; redirectTo?: string }
}

async function postToken(body: Record<string, string>) {
  const response = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

async function rpc(message: unknown, token?: string) {
  const response = await fetch(`${origin}/mcp/bots`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
}

/** A request with headers `fetch` refuses to forge, such as a foreign `Host`. */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${path}`, { headers }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
}

const listMessage = { jsonrpc: '2.0', id: 9, method: 'tools/list' }

interface Grant {
  clientId: string
  verifier: string
  code: string
  access_token: string
  refresh_token: string
  scope: string
}

/** The whole flow a bot walks through, ending with the owner's approval in the application. */
async function grant(options: { scope?: string; connectionId?: string } = {}): Promise<Grant> {
  const clientId = await registered()
  const { verifier, challenge } = pkce()
  const poll = await consentPoll(await authorize(clientId, challenge, options.scope ? { scope: options.scope } : {}))
  expect((await pollStatus(poll)).status).toBe('pending')
  const waiting = oauth.pending()
  expect(waiting).toHaveLength(1)
  oauth.decide(waiting[0].id, true, options.connectionId ?? 'connection-1')
  const answered = await pollStatus(poll)
  expect(answered.status).toBe('ready')
  const target = new URL(answered.redirectTo!)
  expect(target.searchParams.get('state')).toBe('state-1')
  const code = target.searchParams.get('code')!
  const token = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  })
  expect(token.status).toBe(200)
  expect(token.body.token_type).toBe('Bearer')
  return { clientId, verifier, code, ...(token.body as Omit<Grant, 'clientId' | 'verifier' | 'code'>) }
}

it('publishes the configured public URL as issuer and audience and never a forwarded one', async () => {
  const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/bots`, {
    headers: { 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': '9.9.9.9' },
  })
  expect(await resource.json()).toMatchObject({
    resource: `${PUBLISHED}/mcp/bots`,
    authorization_servers: [PUBLISHED],
    bearer_methods_supported: ['header'],
  })
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()
  expect(metadata).toMatchObject({
    issuer: PUBLISHED,
    authorization_endpoint: `${PUBLISHED}/oauth/authorize`,
    token_endpoint: `${PUBLISHED}/oauth/token`,
    registration_endpoint: `${PUBLISHED}/oauth/register`,
    revocation_endpoint: `${PUBLISHED}/oauth/revoke`,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  })
})

it('offers the relayed bot catalog unchanged, plus what only this computer can answer', () => {
  const relayed = readFileSync(
    fileURLToPath(new URL('../../../server/src/modules/bot-conversations/mcp.ts', import.meta.url)),
    'utf8'
  )
  const expected = [...relayed.matchAll(/name: '(bot_[a-z_]+)',[\s\S]*?write: (true|false),/g)].map((match) => ({
    name: match[1],
    write: match[2] === 'true',
  }))
  expect(expected.length).toBeGreaterThan(5)
  const served = BOT_TOOLS.map((tool) => ({ name: tool.name, write: tool.write }))
  // A bot reaches the same tools here as through a relay, with the same right to mutate.
  expect(served).toEqual(expect.arrayContaining(expected))
  // The chat itself lives on this computer, so reading it back is served here and nowhere else.
  expect(served.filter((tool) => !expected.some((item) => item.name === tool.name))).toEqual([
    { name: 'bot_read_chat_history', write: false },
  ])
})

it('serves the tools only after the owner approves the request and names the connection', async () => {
  const anonymous = await rpc(listMessage)
  expect(anonymous.status).toBe(401)
  expect(anonymous.body.error).toBe('invalid_token')
  expect(anonymous.headers.get('www-authenticate')).toContain(
    `${PUBLISHED}/.well-known/oauth-protected-resource/mcp/bots`
  )
  // OAuth discovery must start at the handshake, before a client attempts tool discovery.
  const handshake = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  expect(handshake.status).toBe(401)
  expect(handshake.headers.get('www-authenticate')).toContain(
    `${PUBLISHED}/.well-known/oauth-protected-resource/mcp/bots`
  )
  expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(401)

  const granted = await grant()
  const authenticatedHandshake = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    granted.access_token
  )
  expect(authenticatedHandshake.status).toBe(200)
  expect(authenticatedHandshake.body.result.serverInfo).toMatchObject({ name: 'maestrly-bots' })
  expect(granted.scope).toBe('api:read api:write')
  const list = await rpc(listMessage, granted.access_token)
  expect(list.status).toBe(200)
  expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(BOT_TOOLS.map((t) => t.name))
  expect(list.body.result.tools[0].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })

  const call = await rpc(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bot_send_message', arguments: { conversationId: 'c1', text: 'hi', idempotencyKey: 'k1' } },
    },
    granted.access_token
  )
  expect(call.status).toBe(200)
  expect(calls).toEqual([
    {
      connectionId: 'connection-1',
      name: 'bot_send_message',
      input: { conversationId: 'c1', text: 'hi', idempotencyKey: 'k1' },
    },
  ])
  expect(call.body.result.structuredContent).toMatchObject({ connectionId: 'connection-1' })

  const unknown = await rpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bot_wat', arguments: {} } },
    granted.access_token
  )
  expect(unknown.body.error.code).toBe(-32602)

  toolFailure = 'That workspace is unavailable.'
  const failed = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bot_list_chats', arguments: {} } },
    granted.access_token
  )
  expect(failed.body.result).toMatchObject({ isError: true })
  expect(failed.body.result.content[0].text).toBe('That workspace is unavailable.')
})

it('lets the owner deny a request, and mints nothing when they do', async () => {
  const clientId = await registered()
  const { verifier, challenge } = pkce()
  const poll = await consentPoll(await authorize(clientId, challenge))
  const waiting = oauth.pending()
  expect(waiting).toEqual([{ id: expect.any(String), clientName: 'Grok bot', redirectUri: REDIRECT }])
  // Approval is never remote: the consent page can only read its own request.
  expect(
    (await fetch(`${origin}/oauth/authorize/status?poll=${encodeURIComponent(poll)}`, { method: 'POST' })).status
  ).toBe(405)
  expect((await pollStatus('someone-elses-request')).status).toBe('unknown')

  oauth.decide(waiting[0].id, false, '')
  const answered = await pollStatus(poll)
  const target = new URL(answered.redirectTo!)
  expect(answered.status).toBe('ready')
  expect(target.searchParams.get('error')).toBe('access_denied')
  expect(target.searchParams.get('state')).toBe('state-1')
  expect(target.searchParams.get('code')).toBeNull()
  expect(oauth.pending()).toEqual([])
  expect(() => oauth.decide(waiting[0].id, true, 'connection-1')).toThrow(/no longer waiting/)

  const invented = await postToken({
    grant_type: 'authorization_code',
    code: 'invented-code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  })
  expect(invented.status).toBe(400)
  expect(invented.body.error).toBe('invalid_grant')
})

it('demands PKCE S256 and refuses a verifier that does not match', async () => {
  const clientId = await registered()
  const { challenge } = pkce()
  const plain = await authorize(clientId, challenge, { code_challenge_method: 'plain' })
  expect(plain.status).toBe(302)
  expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
  const missing = await authorize(clientId, '')
  expect(new URL(missing.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
  const malformed = await authorize(clientId, 'too-short')
  expect(new URL(malformed.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')

  const poll = await consentPoll(await authorize(clientId, challenge))
  oauth.decide(oauth.pending()[0].id, true, 'connection-1')
  const code = new URL((await pollStatus(poll)).redirectTo!).searchParams.get('code')!
  const wrong = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  })
  expect(wrong.status).toBe(400)
  expect(wrong.body.error).toBe('invalid_grant')
  expect(wrong.body.error_description).not.toContain('challenge=')
})

it('burns an authorization code and drops the whole grant when it is replayed', async () => {
  const granted = await grant()
  const replay = await postToken({
    grant_type: 'authorization_code',
    code: granted.code,
    client_id: granted.clientId,
    redirect_uri: REDIRECT,
    code_verifier: granted.verifier,
  })
  expect(replay.status).toBe(400)
  expect(replay.body.error).toBe('invalid_grant')
  expect((await rpc(listMessage, granted.access_token)).status).toBe(401)
})

it('rotates refresh tokens and destroys the grant when an old one comes back', async () => {
  const granted = await grant()
  const wrongAudience = await postToken({
    grant_type: 'refresh_token',
    refresh_token: granted.refresh_token,
    client_id: granted.clientId,
    resource: 'https://other.example/mcp/bots',
  })
  expect(wrongAudience.status).toBe(400)
  expect(wrongAudience.body.error).toBe('invalid_target')
  const rotated = await postToken({
    grant_type: 'refresh_token',
    refresh_token: granted.refresh_token,
    client_id: granted.clientId,
  })
  expect(rotated.status).toBe(200)
  expect(rotated.body.access_token).not.toBe(granted.access_token)
  expect((await rpc(listMessage, rotated.body.access_token)).status).toBe(200)

  const replay = await postToken({
    grant_type: 'refresh_token',
    refresh_token: granted.refresh_token,
    client_id: granted.clientId,
  })
  expect(replay.status).toBe(400)
  expect(replay.body.error).toBe('invalid_grant')
  expect((await rpc(listMessage, rotated.body.access_token)).status).toBe(401)
})

it('forgets the tokens of a revoked connection and of a revoked token', async () => {
  const first = await grant()
  oauth.revoke('connection-1')
  expect((await rpc(listMessage, first.access_token)).status).toBe(401)

  const second = await grant({ connectionId: 'connection-2' })
  const revoked = await fetch(`${origin}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: second.refresh_token }).toString(),
  })
  expect(revoked.status).toBe(200)
  expect((await rpc(listMessage, second.access_token)).status).toBe(401)
})

it('binds tokens to the published audience and drops them when the URL changes', async () => {
  const clientId = await registered()
  const elsewhere = await authorize(clientId, pkce().challenge, { resource: 'https://elsewhere.example/mcp/bots' })
  expect(elsewhere.status).toBe(302)
  expect(new URL(elsewhere.headers.get('location')!).searchParams.get('error')).toBe('invalid_target')

  const granted = await grant()
  expect((await rpc(listMessage, granted.access_token)).status).toBe(200)
  // What the parent does when the configured public URL changes.
  oauth.invalidate()
  expect((await rpc(listMessage, granted.access_token)).status).toBe(401)
})

it('invalidates everything when the endpoint restarts on a different public URL', async () => {
  const granted = await grant()
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  await endpoint.start({ host: '127.0.0.1', port, publicUrl: 'https://moved.maestrly.test' })
  expect((await rpc(listMessage, granted.access_token)).status).toBe(401)
  expect(await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
    issuer: 'https://moved.maestrly.test',
  })
})

it('refuses an expired authorization code and an expired access token', async () => {
  const clientId = await registered()
  const { verifier, challenge } = pkce()
  const poll = await consentPoll(await authorize(clientId, challenge))
  oauth.decide(oauth.pending()[0].id, true, 'connection-1')
  const code = new URL((await pollStatus(poll)).redirectTo!).searchParams.get('code')!
  getDb()
    .prepare('UPDATE bot_oauth_requests SET expires_at=?')
    .run(Date.now() - 1_000)
  const late = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  })
  expect(late.status).toBe(400)
  expect(late.body.error).toBe('invalid_grant')

  const granted = await grant()
  getDb()
    .prepare("UPDATE bot_oauth_tokens SET expires_at=? WHERE kind='access'")
    .run(Date.now() - 1_000)
  expect((await rpc(listMessage, granted.access_token)).status).toBe(401)
})

it('registers only public clients with strict redirect URIs', async () => {
  expect((await register('Bad bot', ['javascript:alert(1)'])).status).toBe(400)
  expect((await register('Bad bot', ['http://evil.test/callback'])).status).toBe(400)
  expect((await register('Bad bot', [])).status).toBe(400)
  const confidential = await register('Bad bot', [REDIRECT], { token_endpoint_auth_method: 'client_secret_basic' })
  expect(confidential.status).toBe(400)
  expect(confidential.body.error).toBe('invalid_client_metadata')

  const clientId = await registered()
  const mismatch = await authorize(clientId, pkce().challenge, { redirect_uri: 'http://127.0.0.1:9911/other' })
  expect(mismatch.status).toBe(400)
  expect((await mismatch.json()).error).toBe('invalid_request')
  const unknownClient = await authorize('11111111-1111-4111-8111-111111111111', pkce().challenge)
  expect(unknownClient.status).toBe(400)
  expect((await unknownClient.json()).error).toBe('invalid_client')
  // A freshly registered client holds no authority at all until the owner approves it.
  expect(oauth.pending()).toEqual([])
  expect((await rpc(listMessage)).status).toBe(401)
})

it('keeps a read-only token away from the mutating tools', async () => {
  const granted = await grant({ scope: 'api:read' })
  expect(granted.scope).toBe('api:read')
  const denied = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bot_send_message', arguments: {} } },
    granted.access_token
  )
  expect(denied.status).toBe(403)
  expect(denied.body.error).toBe('insufficient_scope')
  expect(calls).toEqual([])
  const allowed = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bot_list_chats', arguments: {} } },
    granted.access_token
  )
  expect(allowed.status).toBe(200)
  expect(calls).toHaveLength(1)
})

it('answers malformed, oversized and foreign requests with short sanitized errors', async () => {
  const granted = await grant()
  const token = granted.access_token
  const broken = await fetch(`${origin}/mcp/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{',
  })
  expect(broken.status).toBe(400)
  expect((await broken.json()).error.code).toBe(-32700)
  expect((await rpc({ hello: 'world' }, token)).body.error.code).toBe(-32600)
  const batch = await rpc(
    Array.from({ length: 51 }, (_, index) => ({ jsonrpc: '2.0', id: index, method: 'ping' })),
    token
  )
  expect(batch.status).toBe(400)
  const small = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }], token)
  expect(small.body).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])

  const wrongMethod = await fetch(`${origin}/mcp/bots`, { headers: { authorization: `Bearer ${token}` } })
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('allow')).toBe('POST')
  await wrongMethod.arrayBuffer()
  expect((await fetch(`${origin}/nothing-here`)).status).toBe(404)

  const oversized = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + 'a'.repeat(300 * 1024),
  })
  expect(oversized.status).toBe(413)
  expect((await oversized.json()).error).toBe('invalid_request')

  expect(await rawGet('/.well-known/oauth-authorization-server', { host: 'attacker.test' })).toBe(403)
  const foreignOrigin = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { origin: 'https://attacker.test' },
  })
  expect(foreignOrigin.status).toBe(403)
  const opaqueOrigin = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { origin: 'null', 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  })
  expect(opaqueOrigin.status).toBe(403)
  const unsupported = await postToken({ grant_type: 'password', username: 'someone' })
  expect(unsupported.status).toBe(400)
  expect(unsupported.body).toEqual({
    error: 'unsupported_grant_type',
    error_description: 'This grant type is not supported.',
  })
})

it('bounds how fast one caller may hammer the endpoint', async () => {
  let limited = 0
  for (let attempt = 0; attempt < 140; attempt += 1) {
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`)
    await response.arrayBuffer()
    if (response.status === 429) limited += 1
  }
  expect(limited).toBeGreaterThan(0)
})
