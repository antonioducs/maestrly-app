import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { createAuthClient } from 'better-auth/client'
import {
  connectorMcpResource,
  connectorPrincipalSchema,
  type ConnectorPrincipal,
} from '@maestrly/protocol'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { MaestrlyAuth } from '../auth/auth.js'
import { loadConnectorGrants } from './grants.js'

export class ConnectorUnauthenticatedError extends Error {
  readonly statusCode = 401
  readonly challenge: string
  constructor(message: string, challenge: string) {
    super(message)
    this.name = 'ConnectorUnauthenticatedError'
    this.challenge = challenge
  }
}

export type ConnectorAuthenticator = (request: FastifyRequest) => Promise<ConnectorPrincipal>

function organizationHeader(request: FastifyRequest): string | null {
  const value = request.headers['x-maestrly-organization-id']
  return typeof value === 'string' && value.length > 0 ? value : null
}

function clientLabel(request: FastifyRequest): string | null {
  const value = request.headers['x-maestrly-client-actor']
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 160) : null
}

/**
 * Verify an MCP bearer token and resolve the persisted connection. The audience is the MCP resource, so a
 * token minted for the REST API cannot be replayed here and vice versa.
 */
export function createConnectorAuthenticator(
  auth: MaestrlyAuth,
  config: ServerConfig,
  pool: DatabasePool
): ConnectorAuthenticator {
  const resource = connectorMcpResource(config.canonicalUrl)
  const metadataUrl = `${config.canonicalUrl}/.well-known/oauth-protected-resource/mcp`
  const challenge = `Bearer resource_metadata="${metadataUrl}"`
  const oauthClient = createAuthClient({
    baseURL: config.canonicalUrl,
    plugins: [oauthProviderResourceClient(auth)],
  })

  return async (request) => {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer '))
      throw new ConnectorUnauthenticatedError('An MCP access token is required.', challenge)
    let claims: Record<string, unknown>
    try {
      claims = (await oauthClient.verifyBearerToken(authorization.slice(7), {
        verifyOptions: { audience: resource },
        requiredScopes: ['api:read'],
      })) as unknown as Record<string, unknown>
    } catch {
      throw new ConnectorUnauthenticatedError('The MCP access token is invalid or expired.', challenge)
    }
    const userId = typeof claims.sub === 'string' ? claims.sub : ''
    const clientId =
      typeof claims.client_id === 'string' ? claims.client_id : typeof claims.azp === 'string' ? claims.azp : ''
    if (!userId || !clientId)
      throw new ConnectorUnauthenticatedError('The MCP access token is missing its subject or client.', challenge)
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
    const organizationId = organizationHeader(request)
    if (!organizationId)
      throw Object.assign(new Error('X-Maestrly-Organization-Id is required for connector requests.'), {
        statusCode: 400,
      })
    const connection = await loadConnectorGrants(pool, { organizationId, userId, clientId })
    if (!connection)
      throw Object.assign(new Error('This client has no active connection for the requested organization.'), {
        statusCode: 403,
      })
    const forwarded = request.headers['user-agent']
    return connectorPrincipalSchema.parse({
      organizationId,
      connectionId: connection.connectionId,
      clientId,
      userId,
      scopes,
      grants: connection.grants,
      cancelOnRevoke: connection.cancelOnRevoke,
      origin: {
        address: request.ip ?? null,
        userAgent: typeof forwarded === 'string' ? forwarded.slice(0, 500) : null,
      },
      clientLabel: clientLabel(request),
    })
  }
}

export function assertConnectorWriteScope(principal: ConnectorPrincipal): void {
  if (!principal.scopes.includes('api:write'))
    throw Object.assign(new Error('The access token does not carry the api:write scope.'), { statusCode: 403 })
}
