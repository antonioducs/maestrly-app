import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import { createAuthClient } from 'better-auth/client'
import { botMcpResource, botProtectedResourceMetadataUrl } from '@maestrly/protocol'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { MaestrlyAuth } from '../auth/auth.js'
import {
  botFail,
  loadBotConnectionForToken,
  verifyBotDesktopCredential,
  type BotDesktopIdentity,
  type BotPrincipal,
} from './service.js'

export class BotUnauthenticatedError extends Error {
  readonly statusCode = 401
  readonly challenge: string
  constructor(message: string, challenge: string) {
    super(message)
    this.name = 'BotUnauthenticatedError'
    this.challenge = challenge
  }
}

export type BotAuthenticator = (request: FastifyRequest) => Promise<BotPrincipal>

/**
 * Verify a bot MCP bearer token and resolve the persisted connection.
 *
 * The audience is `/mcp/bots`, which is neither the REST audience nor the organization connector's
 * `/mcp` audience, so a token minted for one of those cannot be replayed here and this one cannot be
 * replayed there. Nothing about the caller is taken from a header: the owner comes from the verified
 * subject and the connection from the verified client id.
 */
export function createBotAuthenticator(
  auth: MaestrlyAuth,
  config: ServerConfig,
  pool: DatabasePool
): BotAuthenticator {
  const resource = botMcpResource(config.canonicalUrl)
  const challenge = `Bearer resource_metadata="${botProtectedResourceMetadataUrl(config.canonicalUrl)}"`
  const oauthClient = createAuthClient({
    baseURL: config.canonicalUrl,
    plugins: [oauthProviderResourceClient(auth)],
  })

  return async (request) => {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer '))
      throw new BotUnauthenticatedError('A bot access token is required.', challenge)
    let claims: Record<string, unknown>
    try {
      claims = (await oauthClient.verifyBearerToken(authorization.slice(7), {
        verifyOptions: { audience: resource },
        requiredScopes: ['api:read'],
      })) as unknown as Record<string, unknown>
    } catch {
      throw new BotUnauthenticatedError('The bot access token is invalid or expired.', challenge)
    }
    const userId = typeof claims.sub === 'string' ? claims.sub : ''
    const clientId =
      typeof claims.client_id === 'string'
        ? claims.client_id
        : typeof claims.azp === 'string'
          ? claims.azp
          : ''
    if (!userId || !clientId)
      throw new BotUnauthenticatedError('The bot access token is missing its subject or client.', challenge)
    const connection = await loadBotConnectionForToken(pool, { userId, clientId })
    if (!connection) botFail('This client has no active bot connection.', 403)
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
    return { ...connection, userId, clientId, scopes }
  }
}

export function assertBotWriteScope(principal: BotPrincipal): void {
  if (!principal.scopes.includes('api:write'))
    throw Object.assign(new Error('The access token does not carry the api:write scope.'), { statusCode: 403 })
}

const desktopHeaders = z
  .object({ desktopId: z.string().uuid(), credential: z.string().min(32).max(191) })
  .strict()

/**
 * The desktop transport credential. It only authorizes this device to claim its own work; it grants no
 * API authority, and the desktop keeps it in its main process secure storage.
 */
export function createBotDesktopAuthenticator(pool: DatabasePool) {
  return async (request: FastifyRequest): Promise<BotDesktopIdentity> => {
    const authorization = request.headers.authorization
    const parsed = desktopHeaders.safeParse({
      desktopId: request.headers['x-maestrly-bot-desktop-id'],
      credential: authorization?.startsWith('BotDesktop ') ? authorization.slice(11) : undefined,
    })
    if (!parsed.success) botFail('A bot desktop credential is required.', 401)
    const identity = await verifyBotDesktopCredential(pool, parsed.data)
    if (!identity) botFail('The bot desktop credential is invalid or revoked.', 401)
    return identity
  }
}
