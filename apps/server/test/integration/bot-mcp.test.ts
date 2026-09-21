import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  botMcpResource,
  connectorMcpResource,
  type BotClaim,
  type BotConnectionRegistration,
  type BotDesktopRegistration,
} from '@maestrly/protocol'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createAuth } from '../../src/modules/auth/auth.js'
import { integrationAvailable, runtimePool, runtimeUrl } from './helpers.js'

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 4499
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())))
  return port
}

interface JsonRpcReply {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, any>
  error?: { code: number; message: string }
}

const workspaceId = 'ws-local-' + randomUUID()

describe.skipIf(!integrationAvailable)('personal bot MCP endpoint', () => {
  it('serves its own audience, honours scopes and grants, and stops the moment the owner revokes', async () => {
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
    const resource = botMcpResource(canonicalUrl)
    try {
      const email = `bot-owner-${randomUUID()}@example.test`
      const signup = await auth.handler(
        new Request(`${canonicalUrl}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Bot owner' }),
        })
      )
      expect(signup.status, await signup.clone().text()).toBe(200)
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; ')

      const ownerCall = (method: string, path: string, body?: unknown) =>
        fetch(`${canonicalUrl}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-maestrly-protocol-version': '1.0',
            'idempotency-key': randomUUID(),
            cookie,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })

      // The owner registers their desktop and reads back the credential exactly once.
      const desktopResponse = await ownerCall('POST', '/api/v1/bots/desktops', { name: 'Laptop' })
      expect(desktopResponse.status, await desktopResponse.clone().text()).toBe(201)
      const registration = (await desktopResponse.json()) as BotDesktopRegistration
      expect(registration.credential.length).toBeGreaterThanOrEqual(32)

      const desktopHeaders = {
        'content-type': 'application/json',
        'x-maestrly-protocol-version': '1.0',
        authorization: `BotDesktop ${registration.credential}`,
        'x-maestrly-bot-desktop-id': registration.desktop.id,
      }
      const inventory = await fetch(`${canonicalUrl}/api/v1/bot-desktops/inventory`, {
        method: 'POST',
        headers: desktopHeaders,
        body: JSON.stringify({
          capability: 'bot:conversations:v1',
          enabled: true,
          workspaces: [{ workspaceId, label: 'Product', branches: ['main'], defaultBranch: 'main' }],
          selections: [
            {
              selectionId: 'account-1/model-a',
              label: 'Model A',
              providerLabel: null,
              reasoningEfforts: ['medium'],
              fastMode: false,
              modes: ['agent', 'ask', 'plan'],
              permissionModes: ['ask', 'auto', 'full'],
            },
          ],
        }),
      })
      expect(inventory.status, await inventory.clone().text()).toBe(200)

      // A wrong credential is refused even with the right desktop id.
      const forged = await fetch(`${canonicalUrl}/api/v1/bot-desktops/claim`, {
        method: 'POST',
        headers: { ...desktopHeaders, authorization: 'BotDesktop ' + 'x'.repeat(43) },
        body: '{}',
      })
      expect(forged.status).toBe(401)

      // Creating the connection registers the bot's OAuth client and answers with its MCP configuration.
      const connectionResponse = await ownerCall('POST', '/api/v1/bots/connections', {
        name: 'Grok',
        desktopId: registration.desktop.id,
        grants: [{ workspaceId, actions: ['chats:read', 'chats:write'] }],
      })
      expect(connectionResponse.status, await connectionResponse.clone().text()).toBe(201)
      const created = (await connectionResponse.json()) as BotConnectionRegistration
      expect(created.mcp.resource).toBe(resource)
      expect(created.mcp.url).toBe(`${canonicalUrl}/mcp/bots`)
      expect(created.connection.grants[0]!.actions).toEqual(['chats:read', 'chats:write'])

      const token = async (scope: string) => {
        const deviceCode = await auth.handler(
          new Request(`${canonicalUrl}/api/auth/device/code`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: created.mcp.clientId, scope, resource }),
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
        const response = await auth.handler(
          new Request(`${canonicalUrl}/api/auth/oauth2/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: codes.device_code,
              client_id: created.mcp.clientId,
              resource,
            }),
          })
        )
        const tokens = (await response.json()) as { access_token: string }
        expect(response.status, JSON.stringify(tokens)).toBe(200)
        return tokens.access_token
      }

      const writeToken = await token('openid profile email offline_access api:read api:write')
      const claims = JSON.parse(Buffer.from(writeToken.split('.')[1]!, 'base64url').toString('utf8')) as {
        aud: string | string[]
      }
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      expect(audiences).toContain(resource)
      // The bot audience is not the REST audience and not the organization connector audience.
      expect(audiences).not.toContain(`${canonicalUrl}/api/v1`)
      expect(audiences).not.toContain(connectorMcpResource(canonicalUrl))

      const mcp = async (body: unknown, accessToken = writeToken) =>
        fetch(`${canonicalUrl}/mcp/bots`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(body),
        })

      // Discovery is public and points at this instance's authorization server.
      const metadata = await fetch(`${canonicalUrl}/.well-known/oauth-protected-resource/mcp/bots`)
      expect(metadata.status).toBe(200)
      expect((await metadata.json()) as { resource: string }).toMatchObject({ resource })

      const anonymous = await fetch(`${canonicalUrl}/mcp/bots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp/bots')

      const getMcp = await fetch(`${canonicalUrl}/mcp/bots`, { method: 'GET' })
      expect(getMcp.status).toBe(405)

      // A bot token is refused by the REST API and by the organization connector endpoint.
      const rest = await fetch(`${canonicalUrl}/api/v1/bots`, {
        headers: { authorization: `Bearer ${writeToken}`, 'x-maestrly-protocol-version': '1.0' },
      })
      expect(rest.status).toBe(401)
      const connector = await fetch(`${canonicalUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${writeToken}`,
          'x-maestrly-organization-id': randomUUID(),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(connector.status).toBe(401)

      const initialize = (await (
        await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      ).json()) as JsonRpcReply
      expect(initialize.result?.protocolVersion).toBe('2025-06-18')
      expect(initialize.result?.serverInfo).toMatchObject({ name: 'maestrly-bots' })

      const list = (await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as JsonRpcReply
      expect(list.result?.tools).toBeInstanceOf(Array)
      const names = (list.result!.tools as Array<{ name: string }>).map((tool) => tool.name)
      expect(names).toEqual(
        expect.arrayContaining(['bot_list_workspaces', 'bot_create_chat', 'bot_wait_events', 'bot_answer_question'])
      )
      // No organization, project, board, card or runner tool is reachable from a personal bot.
      expect(names.some((name) => /project|board|card|runner|organization/.test(name))).toBe(false)

      const call = async (name: string, args: Record<string, unknown>, accessToken = writeToken) =>
        (await (
          await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, accessToken)
        ).json()) as JsonRpcReply

      const workspaces = (await call('bot_list_workspaces', {})).result?.structuredContent as {
        desktop: { name: string; online: boolean }
        workspaces: Array<{ workspaceId: string; actions: string[] }>
        selections: Array<{ selectionId: string }>
      }
      expect(workspaces.desktop).toMatchObject({ name: 'Laptop', online: true })
      expect(workspaces.workspaces.map((item) => item.workspaceId)).toEqual([workspaceId])
      expect(workspaces.selections[0]!.selectionId).toBe('account-1/model-a')

      // A read-only token cannot mutate anything.
      const readToken = await token('openid profile email offline_access api:read')
      const refused = await call(
        'bot_create_chat',
        {
          workspaceId,
          name: 'Read only attempt',
          baseBranch: 'main',
          selection: { selectionId: 'account-1/model-a' },
          idempotencyKey: randomUUID(),
        },
        readToken
      )
      expect(refused.result?.isError).toBe(true)
      expect(JSON.stringify(refused.result)).toContain('api:write')

      const createKey = randomUUID()
      const chat = (await call('bot_create_chat', {
        workspaceId,
        name: 'Release notes',
        baseBranch: 'main',
        selection: { selectionId: 'account-1/model-a', mode: 'agent' },
        message: 'Summarize the release',
        idempotencyKey: createKey,
      })).result?.structuredContent as { conversation: { id: string; version: number }; command: { id: string } }
      expect(chat.conversation.id).toBeTruthy()
      // Retrying with the same key replays instead of creating a second chat.
      const replay = (await call('bot_create_chat', {
        workspaceId,
        name: 'Release notes',
        baseBranch: 'main',
        selection: { selectionId: 'account-1/model-a', mode: 'agent' },
        message: 'Summarize the release',
        idempotencyKey: createKey,
      })).result?.structuredContent as { conversation: { id: string } }
      expect(replay.conversation.id).toBe(chat.conversation.id)
      const listed = (await call('bot_list_chats', {})).result?.structuredContent as {
        conversations: Array<{ id: string }>
      }
      expect(listed.conversations.map((item) => item.id)).toEqual([chat.conversation.id])

      // A workspace outside the grant is refused even with a valid token.
      const ungranted = await call('bot_create_chat', {
        workspaceId: 'ws-not-granted',
        name: 'Nope',
        baseBranch: 'main',
        selection: { selectionId: 'account-1/model-a' },
        idempotencyKey: randomUUID(),
      })
      expect(ungranted.result?.isError).toBe(true)
      expect(JSON.stringify(ungranted.result)).toContain('not authorized')

      // The desktop claims the work over its own transport and streams one durable event.
      const claimResponse = await fetch(`${canonicalUrl}/api/v1/bot-desktops/claim`, {
        method: 'POST',
        headers: desktopHeaders,
        body: '{}',
      })
      expect(claimResponse.status).toBe(200)
      const claim = (await claimResponse.json()) as BotClaim
      expect(claim.command.id).toBe(chat.command.id)
      expect(claim.owner.userId).toBe(created.connection.ownerUserId)
      const messageId = randomUUID()
      const upload = await fetch(
        `${canonicalUrl}/api/v1/bot-desktops/commands/${claim.command.id}/events`,
        {
          method: 'POST',
          headers: desktopHeaders,
          body: JSON.stringify({
            leaseToken: claim.command.leaseToken,
            fence: claim.fence,
            events: [
              {
                eventId: 'message-' + messageId,
                payload: {
                  type: 'message',
                  message: {
                    id: messageId,
                    conversationId: chat.conversation.id,
                    commandId: claim.command.id,
                    role: 'assistant',
                    parts: [{ id: 'p1', type: 'text', text: 'Here is the summary' }],
                    createdAt: new Date().toISOString(),
                  },
                },
              },
            ],
          }),
        }
      )
      expect(upload.status, await upload.clone().text()).toBe(200)

      // The bot follows the chat from its cursor; the wait answers as soon as the event exists.
      const waited = (await call('bot_wait_events', { conversationId: chat.conversation.id, cursor: 0 })).result
        ?.structuredContent as { events: Array<{ payload: { type: string } }>; timedOut: boolean; cursor: number }
      expect(waited.timedOut).toBe(false)
      expect(waited.events.some((event) => event.payload.type === 'message')).toBe(true)
      const empty = (await call('bot_wait_events', {
        conversationId: chat.conversation.id,
        cursor: waited.cursor,
        timeoutSeconds: 1,
      })).result?.structuredContent as { timedOut: boolean }
      expect(empty.timedOut).toBe(true)

      // The owner pauses the chat: the bot can still read it but no longer act on it.
      const pause = await ownerCall('POST', `/api/v1/bots/conversations/${chat.conversation.id}/management`, {
        expectedVersion: chat.conversation.version,
        state: 'paused',
      })
      expect(pause.status, await pause.clone().text()).toBe(200)
      const blocked = await call('bot_send_message', {
        conversationId: chat.conversation.id,
        text: 'still there?',
        idempotencyKey: randomUUID(),
      })
      expect(blocked.result?.isError).toBe(true)
      expect(JSON.stringify(blocked.result)).toContain('paused')
      expect((await call('bot_read_chat', { conversationId: chat.conversation.id })).result?.structuredContent)
        .toMatchObject({ conversation: { managementState: 'paused' } })

      // Revoking the connection stops the bot immediately, before any tool runs.
      const revoke = await ownerCall('PATCH', `/api/v1/bots/connections/${created.connection.id}`, {
        expectedVersion: created.connection.version,
        revoked: true,
      })
      expect(revoke.status, await revoke.clone().text()).toBe(200)
      const afterRevoke = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
      expect(afterRevoke.status).toBe(403)
    } finally {
      await app.close()
      await pool.end()
    }
  })
})
