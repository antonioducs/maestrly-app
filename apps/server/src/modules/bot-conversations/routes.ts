import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { createAuthClient } from 'better-auth/client'
import {
  BOT_ACTIONS,
  BOT_DESKTOP_ROOT,
  BOT_OWNER_ROOT,
  BOT_PROTECTED_RESOURCE_PATH,
  botConnectionCreateSchema,
  botConnectionPatchSchema,
  botDesktopCreateSchema,
  botEventUploadSchema,
  botInventorySchema,
  botMcpResource,
  botManagementStateSchema,
} from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { MaestrlyAuth } from '../auth/auth.js'
import type { HumanIdentity } from '../auth/routes.js'
import { DESKTOP_CLIENT_ID } from '../auth/desktop-client.js'
import { createBotDesktopAuthenticator } from './auth.js'
import {
  claimBotCommand,
  completeBotCommand,
  readBotControls,
  renewBotLease,
  uploadBotEventBatch,
} from './dispatch.js'
import {
  BOT_CLIENT_SCOPES,
  bindBotClientResource,
  botFail,
  createBotConnection,
  executeBotIdempotent,
  listBotConnections,
  listBotDesktops,
  listOwnerBotConversations,
  patchBotConnection,
  registerBotDesktop,
  deriveBotDesktopCredential,
  registerBotOAuthClient,
  revokeBotDesktop,
  saveBotInventory,
  setBotConversationManagement,
  type BotOAuthResources,
} from './service.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !key || key.length > 191)
    botFail('A valid Idempotency-Key header is required.', 400)
  return key
}

/**
 * Owner-facing API and desktop transport for personal bot conversations. Nothing here takes an
 * organization, a project or a runner: the signed-in person is the only tenant.
 */
export function registerBotRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  auth: MaestrlyAuth,
  config: ServerConfig,
  authenticate: Authenticate
): void {
  const resource = botMcpResource(config.canonicalUrl)
  const resources: BotOAuthResources = {
    mcpResource: resource,
    apiResource: `${config.canonicalUrl}/api/v1`,
    instanceName: config.instanceName,
  }
  const resourceClient = createAuthClient({
    baseURL: config.canonicalUrl,
    plugins: [oauthProviderResourceClient(auth)],
  })

  // Discovery is public by design: a bot must learn where to authorize before it holds any token. It is
  // a separate document from the organization connector's, so neither client rebinds the other.
  app.get(BOT_PROTECTED_RESOURCE_PATH, async (_request, reply) =>
    reply.status(200).send(
      await resourceClient.getProtectedResourceMetadata({
        resource,
        authorization_servers: [`${config.canonicalUrl}/api/auth`],
        scopes_supported: ['api:read', 'api:write'],
        bearer_methods_supported: ['header'],
        resource_name: `${config.instanceName} personal bots`,
      })
    )
  )

  const owner = async (request: FastifyRequest, write: boolean) => {
    const human = await authenticate(request, write ? ['api:write'] : undefined)
    if (!human) botFail('Authentication required.', 401)
    return human.userId
  }

  app.get(BOT_OWNER_ROOT, async (request) => {
    const userId = await owner(request, false)
    return {
      mcp: {
        url: resource,
        resource,
        authorizationServer: `${config.canonicalUrl}/api/auth`,
        protectedResourceMetadataUrl: `${config.canonicalUrl}${BOT_PROTECTED_RESOURCE_PATH}`,
        scopes: [...BOT_CLIENT_SCOPES],
      },
      actions: BOT_ACTIONS,
      desktops: await listBotDesktops(pool, userId),
      connections: await listBotConnections(pool, userId),
    }
  })

  const idempotent = async <T>(
    request: FastifyRequest,
    userId: string,
    operation: Parameters<typeof executeBotIdempotent<T>>[2]
  ) =>
    executeBotIdempotent<T>(
      pool,
      {
        actor: { type: 'bot_owner', userId },
        ownerUserId: userId,
        actorId: userId,
        key: idempotencyKey(request),
        method: request.method,
        path: request.url,
        body: request.body ?? null,
      },
      operation
    )

  app.post(`${BOT_OWNER_ROOT}/desktops`, async (request, reply) => {
    const userId = await owner(request, true)
    const body = botDesktopCreateSchema.parse(request.body)
    const result = await idempotent(request, userId, async (client) => {
      const registered = await registerBotDesktop(client, { userId, name: body.name, credentialSecret: config.authSecret })
      return { status: 201, body: { desktop: registered.desktop } }
    })
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send({ ...result.body, credential: deriveBotDesktopCredential(config.authSecret, userId, result.body.desktop.id) })
  })

  app.post(`${BOT_OWNER_ROOT}/desktops/:desktopId/revoke`, async (request, reply) => {
    const userId = await owner(request, true)
    const { desktopId } = z.object({ desktopId: z.string().uuid() }).parse(request.params)
    const result = await idempotent(request, userId, async (client) => ({
      status: 200,
      body: await revokeBotDesktop(client, { userId, desktopId }),
    }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.get(`${BOT_OWNER_ROOT}/connections`, async (request) => listBotConnections(pool, await owner(request, false)))

  app.post(`${BOT_OWNER_ROOT}/connections`, async (request, reply) => {
    const userId = await owner(request, true)
    const body = botConnectionCreateSchema.parse(request.body)
    if (body.clientId === DESKTOP_CLIENT_ID)
      botFail('The Maestrly desktop client cannot be reused as a bot connection.', 400)
    const result = await idempotent(request, userId, async (client) => {
      // An existing client is validated and narrowed; otherwise a public native client is registered.
      let clientId = body.clientId
      if (clientId) await bindBotClientResource(pool, { clientId, userId, resources })
      else clientId = await registerBotOAuthClient(pool, { name: body.name, userId, resources })
      const connection = await createBotConnection(client, { userId }, { ...body, clientId })
      return {
        status: 201,
        body: {
          connection,
          mcp: {
            url: resource,
            resource,
            authorizationServer: `${config.canonicalUrl}/api/auth`,
            protectedResourceMetadataUrl: `${config.canonicalUrl}${BOT_PROTECTED_RESOURCE_PATH}`,
            clientId,
            scopes: [...BOT_CLIENT_SCOPES],
          },
        },
      }
    })
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.patch(`${BOT_OWNER_ROOT}/connections/:connectionId`, async (request, reply) => {
    const userId = await owner(request, true)
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(request.params)
    const body = botConnectionPatchSchema.parse(request.body)
    const result = await idempotent(request, userId, async (client) => ({
      status: 200,
      body: await patchBotConnection(client, { userId, connectionId }, body),
    }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.get(`${BOT_OWNER_ROOT}/conversations`, async (request) =>
    listOwnerBotConversations(pool, await owner(request, false))
  )

  app.post(`${BOT_OWNER_ROOT}/conversations/:conversationId/management`, async (request, reply) => {
    const userId = await owner(request, true)
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(request.params)
    const body = z
      .object({ expectedVersion: z.number().int().positive(), state: botManagementStateSchema })
      .strict()
      .parse(request.body)
    const result = await idempotent(request, userId, async (client) => ({
      status: 200,
      body: await setBotConversationManagement(client, { userId, conversationId }, body),
    }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  // Desktop transport. Machine traffic is more frequent than human API requests.
  const desktop = createBotDesktopAuthenticator(pool)
  const machine = { config: { rateLimit: { max: 1800, timeWindow: '1 minute' } } }
  const commandParams = (request: FastifyRequest) =>
    z.object({ commandId: z.string().uuid() }).parse(request.params).commandId
  const lease = z.object({ leaseToken: z.string().uuid(), fence: z.coerce.number().int().positive() })

  app.post(`${BOT_DESKTOP_ROOT}/inventory`, machine, async (request) => {
    const identity = await desktop(request)
    await saveBotInventory(pool, identity, botInventorySchema.parse(request.body))
    return { ok: true }
  })

  app.post(`${BOT_DESKTOP_ROOT}/claim`, machine, async (request) => claimBotCommand(pool, await desktop(request)))

  app.post(`${BOT_DESKTOP_ROOT}/commands/:commandId/lease`, machine, async (request) => {
    const identity = await desktop(request)
    const body = lease.strict().parse(request.body)
    return renewBotLease(pool, identity, { commandId: commandParams(request), ...body })
  })

  app.get(`${BOT_DESKTOP_ROOT}/commands/:commandId/controls`, machine, async (request) => {
    const identity = await desktop(request)
    const query = lease.parse(request.query)
    return readBotControls(pool, identity, { commandId: commandParams(request), ...query })
  })

  app.post(`${BOT_DESKTOP_ROOT}/commands/:commandId/events`, machine, async (request) => {
    const identity = await desktop(request)
    const body = lease
      .extend({ events: z.array(botEventUploadSchema).min(1).max(100) })
      .strict()
      .parse(request.body)
    return uploadBotEventBatch(pool, identity, { commandId: commandParams(request), ...body })
  })

  app.post(`${BOT_DESKTOP_ROOT}/commands/:commandId/complete`, machine, async (request) => {
    const identity = await desktop(request)
    const body = lease
      .extend({
        status: z.enum(['succeeded', 'failed', 'cancelled']),
        error: z.string().max(8000).nullable().default(null),
      })
      .strict()
      .parse(request.body)
    return completeBotCommand(pool, identity, { commandId: commandParams(request), ...body })
  })
}
