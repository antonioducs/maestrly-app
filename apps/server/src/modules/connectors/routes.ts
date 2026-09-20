import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { createAuthClient } from 'better-auth/client'
import {
  CONNECTOR_ACTIONS,
  connectorConnectionCreateSchema,
  connectorConnectionPatchSchema,
  connectorMcpResource,
} from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { MaestrlyAuth } from '../auth/auth.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import {
  bindConnectorClientResource,
  createConnectorConnection,
  listConnectorConnections,
  patchConnectorConnection,
  connectorFail,
} from './grants.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !key || key.length > 191)
    connectorFail('A valid Idempotency-Key header is required.', 400)
  return key
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  auth: MaestrlyAuth,
  config: ServerConfig,
  authenticate: Authenticate
): void {
  const resource = connectorMcpResource(config.canonicalUrl)
  const resourceClient = createAuthClient({
    baseURL: config.canonicalUrl,
    plugins: [oauthProviderResourceClient(auth)],
  })

  const metadata = async () =>
    resourceClient.getProtectedResourceMetadata({
      resource,
      authorization_servers: [`${config.canonicalUrl}/api/auth`],
      scopes_supported: ['api:read', 'api:write'],
      bearer_methods_supported: ['header'],
      resource_name: `${config.instanceName} MCP`,
    })

  // Discovery is public by design: a client must learn where to authorize before it holds any token.
  for (const url of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])
    app.get(url, async (_request, reply) => reply.status(200).send(await metadata()))

  const root = '/api/v1/organizations/:organizationId/connectors'
  const params = z.object({ organizationId: z.string().uuid(), connectionId: z.string().uuid().optional() })

  app.get(root, async (request) => {
    const human = await authenticate(request)
    if (!human) connectorFail('Authentication required.', 401)
    const scope = params.parse(request.params)
    return {
      mcpUrl: resource,
      protectedResourceMetadataUrl: `${config.canonicalUrl}/.well-known/oauth-protected-resource/mcp`,
      authorizationServer: `${config.canonicalUrl}/api/auth`,
      actions: CONNECTOR_ACTIONS,
      dynamicRegistration: config.connectorOpenRegistration,
      connections: await listConnectorConnections(pool, {
        organizationId: scope.organizationId,
        userId: human.userId,
      }),
    }
  })

  app.post(root, async (request, reply) => {
    const human = await authenticate(request, ['api:write'])
    if (!human) connectorFail('Authentication required.', 401)
    const scope = params.parse(request.params)
    const body = connectorConnectionCreateSchema.parse(request.body)
    const result = await executeIdempotent(
      pool,
      {
        organizationId: scope.organizationId,
        actorId: human.userId,
        actor: { type: 'human', userId: human.userId },
        key: idempotencyKey(request),
        method: request.method,
        path: request.url,
        body,
      },
      async () => {
        await bindConnectorClientResource(pool, {
          clientId: body.clientId,
          mcpResource: resource,
          apiResource: `${config.canonicalUrl}/api/v1`,
        })
        return {
          status: 201,
          body: await createConnectorConnection(
            pool,
            { organizationId: scope.organizationId, userId: human.userId },
            body
          ),
        }
      }
    )
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.patch(`${root}/:connectionId`, async (request, reply) => {
    const human = await authenticate(request, ['api:write'])
    if (!human) connectorFail('Authentication required.', 401)
    const scope = params.parse(request.params)
    const body = connectorConnectionPatchSchema.parse(request.body)
    const result = await executeIdempotent(
      pool,
      {
        organizationId: scope.organizationId,
        actorId: human.userId,
        actor: { type: 'human', userId: human.userId },
        key: idempotencyKey(request),
        method: request.method,
        path: request.url,
        body,
      },
      async () => ({
        status: 200,
        body: await patchConnectorConnection(
          pool,
          { organizationId: scope.organizationId, userId: human.userId, connectionId: scope.connectionId! },
          body
        ),
      })
    )
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })
}
