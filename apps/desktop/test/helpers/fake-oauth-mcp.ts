import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/**
 * A synthetic OAuth authorization server and protected MCP resource on one loopback port: RFC 9728 resource metadata,
 * RFC 8414 server metadata, dynamic client registration, authorization code with PKCE (S256), refresh, and a
 * Streamable HTTP MCP endpoint that answers 401 without a valid bearer token.
 */
export async function fakeOAuthServer(
  opts: { registration?: boolean; deny?: boolean; authorizationEndpoint?: string } = {}
) {
  const state = {
    registrations: 0,
    authorizations: 0,
    refreshes: 0,
    validTokens: new Set<string>(),
    challenges: new Map<string, string>(),
    lastResource: null as string | null,
    lastScope: null as string | null,
  }
  let base = ''
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }
  const body = async (req: http.IncomingMessage) => {
    let text = ''
    for await (const chunk of req) text += chunk
    return text
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: opts.authorizationEndpoint ?? `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(opts.registration === false ? {} : { registration_endpoint: `${base}/register` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    if (url.pathname === '/register' && req.method === 'POST') {
      state.registrations += 1
      const metadata = JSON.parse(await body(req))
      return json(res, 201, { ...metadata, client_id: `client-${state.registrations}` })
    }
    if (url.pathname === '/authorize') {
      state.authorizations += 1
      const redirect = new URL(url.searchParams.get('redirect_uri')!)
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
      if (opts.deny) redirect.searchParams.set('error', 'access_denied')
      else {
        const code = `code-${randomUUID()}`
        state.challenges.set(code, url.searchParams.get('code_challenge') ?? '')
        state.lastResource = url.searchParams.get('resource')
        state.lastScope = url.searchParams.get('scope')
        redirect.searchParams.set('code', code)
      }
      res.writeHead(302, { location: redirect.toString() }).end()
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req))
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = state.challenges.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (!challenge || createHash('sha256').update(verifier).digest('base64url') !== challenge)
          return json(res, 400, { error: 'invalid_grant' })
        state.challenges.delete(form.get('code')!)
        state.validTokens.add('at-1')
        return json(res, 200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1' })
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'rt-1') {
        state.refreshes += 1
        state.validTokens.add('at-2')
        return json(res, 200, { access_token: 'at-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1' })
      }
      return json(res, 400, { error: 'invalid_grant' })
    }
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!state.validTokens.has(token)) {
        res
          .writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end()
        return
      }
      const mcp = new SdkMcpServer({ name: 'oauth-fixture', version: '1.0.0' })
      mcp.registerTool('whoami', { description: 'Who is signed in' }, async () => ({
        content: [{ type: 'text', text: `token:${token}` }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    state,
    url: `${base}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Plays the browser: follows the authorization URL to the loopback callback. */
export const browser = async (url: string) => {
  const consent = await fetch(url, { redirect: 'manual' })
  const location = consent.headers.get('location')
  if (location) await fetch(location)
}
