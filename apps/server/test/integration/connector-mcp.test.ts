import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { connectorMcpResource } from '@maestrly/protocol'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createAuth } from '../../src/modules/auth/auth.js'
import {
  bindConnectorClientResource,
  createConnectorConnection,
  patchConnectorConnection,
} from '../../src/modules/connectors/grants.js'
import { createProject } from '../../src/modules/projects/service.js'
import { integrationAvailable, runtimePool, runtimeUrl, seedOrganization } from './helpers.js'

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 4399
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())))
  return port
}

interface JsonRpcReply {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

describe.skipIf(!integrationAvailable)('connector MCP endpoint', () => {
  it('authenticates with the MCP audience, exposes only granted projects and stops after revocation', async () => {
    const pool = runtimePool()
    const port = await freePort()
    const canonicalUrl = `http://127.0.0.1:${port}`
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: runtimeUrl!,
      // JWKS rows are shared across integration files, so every auth-backed test uses one secret.
      BETTER_AUTH_SECRET: 'device-auth-secret-0123456789abcdef',
      MAESTRLY_CANONICAL_URL: canonicalUrl,
      MAESTRLY_WEB_ORIGIN: 'http://127.0.0.1:4173',
      MAESTRLY_BOOTSTRAP_MODE: 'true',
      LOG_LEVEL: 'silent',
    })
    const auth = createAuth(config, pool)
    const app = await buildApp({ config, pool, auth })
    await app.listen({ host: '127.0.0.1', port })
    const mcpResource = connectorMcpResource(canonicalUrl)
    try {
      const email = `connector-${randomUUID()}@example.test`
      const signup = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Connector owner' }),
        })
      )
      expect(signup.status, await signup.clone().text()).toBe(200)
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; ')
      const signupBody = (await signup.json()) as { user: { id: string } }
      const userId = signupBody.user.id

      const organizationId = await seedOrganization('Connector MCP', userId)
      const granted = await createProject(pool, { organizationId, actorUserId: userId, name: 'Delegated project' })
      const hidden = await createProject(pool, { organizationId, actorUserId: userId, name: 'Hidden project' })

      // Preregistered client: created by an authorized owner and linked to the MCP resource only.
      const client = await auth.api.adminCreateOAuthClient({
        headers: new Headers({ cookie }),
        body: {
          token_endpoint_auth_method: 'none',
          application_type: 'native',
          grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          scope: 'openid profile email offline_access api:read api:write',
          client_name: 'Grok Bot test connector',
        },
      })
      await bindConnectorClientResource(pool, {
        clientId: client.client_id,
        mcpResource,
        apiResource: `${canonicalUrl}/api/v1`,
      })

      const connection = await createConnectorConnection(
        pool,
        { organizationId, userId },
        {
          clientId: client.client_id,
          name: 'Grok Bot',
          cancelOnRevoke: true,
          grants: [{ projectId: granted.project.id, actions: ['tasks:read', 'tasks:write'] }],
        }
      )

      const deviceCode = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/device/code`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: client.client_id,
            scope: 'openid profile email offline_access api:read api:write',
            resource: mcpResource,
          }),
        })
      )
      expect(deviceCode.status, await deviceCode.clone().text()).toBe(200)
      const codes = (await deviceCode.json()) as { device_code: string; user_code: string; interval: number }
      const verified = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/device?user_code=${encodeURIComponent(codes.user_code)}`, {
          headers: { cookie },
        })
      )
      expect(verified.status, await verified.clone().text()).toBe(200)
      const approved = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/device/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ userCode: codes.user_code }),
        })
      )
      expect(approved.status, await approved.clone().text()).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, codes.interval * 1_000))
      const tokenResponse = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: codes.device_code,
            client_id: client.client_id,
            resource: mcpResource,
          }),
        })
      )
      const tokens = (await tokenResponse.json()) as { access_token: string; error?: string }
      expect(tokenResponse.status, JSON.stringify(tokens)).toBe(200)
      const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString('utf8')) as {
        aud: string | string[]
      }
      expect(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).toContain(mcpResource)

      const mcp = async (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${canonicalUrl}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tokens.access_token}`,
            'x-maestrly-organization-id': organizationId,
            ...headers,
          },
          body: JSON.stringify(body),
        })

      // Discovery is public so a client can find where to authorize.
      const metadata = await fetch(`${canonicalUrl}/.well-known/oauth-protected-resource/mcp`)
      expect(metadata.status).toBe(200)
      expect((await metadata.json()) as { resource: string }).toMatchObject({ resource: mcpResource })

      // Without a token the endpoint answers 401 and points at the resource metadata.
      const anonymous = await fetch(`${canonicalUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-maestrly-organization-id': organizationId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('www-authenticate')).toContain('oauth-protected-resource')

      // The stateless endpoint has no SSE channel.
      const getMcp = await fetch(`${canonicalUrl}/mcp`, { method: 'GET' })
      expect(getMcp.status).toBe(405)
      expect(getMcp.headers.get('allow')).toBe('POST')

      const initialize = (await (
        await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      ).json()) as JsonRpcReply
      expect(initialize.result?.protocolVersion).toBe('2025-06-18')
      expect(initialize.result?.serverInfo).toMatchObject({ name: 'maestrly' })

      // Notifications produce no body and no session state.
      const notified = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(notified.status).toBe(202)

      const list = (await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as JsonRpcReply
      const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name)
      expect(names).toContain('maestrly_list_projects')

      const called = (await (
        await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'maestrly_list_projects', arguments: {} } })
      ).json()) as JsonRpcReply
      const structured = called.result?.structuredContent as { projects: Array<{ projectId: string }> }
      expect(structured.projects.map((project) => project.projectId)).toEqual([granted.project.id])
      expect(structured.projects.map((project) => project.projectId)).not.toContain(hidden.project.id)

      const unknown = (await (
        await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'maestrly_nope', arguments: {} } })
      ).json()) as JsonRpcReply
      expect(unknown.error?.code).toBe(-32602)

      const badMethod = (await (await mcp({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).json()) as JsonRpcReply
      expect(badMethod.error?.code).toBe(-32601)

      // A token minted for this instance cannot be aimed at another organization.
      const crossOrganization = await mcp(
        { jsonrpc: '2.0', id: 6, method: 'tools/list' },
        { 'x-maestrly-organization-id': randomUUID() }
      )
      expect(crossOrganization.status).toBe(403)

      // The REST audience is separate: the MCP token must not be accepted by /api/v1.
      const rest = await fetch(`${canonicalUrl}/api/v1/me`, {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'x-maestrly-protocol-version': '1.0',
        },
      })
      expect(rest.status).toBe(401)

      await patchConnectorConnection(
        pool,
        { organizationId, userId, connectionId: connection.id },
        { expectedVersion: connection.version, revoked: true }
      )
      const afterRevoke = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
      expect(afterRevoke.status).toBe(403)
    } finally {
      await app.close()
      await pool.end()
    }
  })
})
