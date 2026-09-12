import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createAuthClient } from 'better-auth/client'
import { fromNodeHeaders } from 'better-auth/node'
import type { ServerConfig } from '../../config.js'
import type { MaestrlyAuth } from './auth.js'

export interface HumanIdentity {
  userId: string
  email?: string
  scopes: string[]
}

function bodyFor(request: FastifyRequest): BodyInit | undefined {
  if (request.body === undefined || request.body === null) return undefined
  if (typeof request.body === 'string') return request.body
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(request.body as Record<string, string>).toString()
  }
  return JSON.stringify(request.body)
}

export function registerAuthRoutes(app: FastifyInstance, auth: MaestrlyAuth, config: ServerConfig): void {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    async handler(request, reply) {
      const url = new URL(request.raw.url ?? request.url, config.canonicalUrl)
      const response = await auth.handler(new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        body: bodyFor(request),
      }))
      reply.status(response.status)
      response.headers.forEach((value, key) => reply.header(key, value))
      return reply.send(response.body ? await response.text() : null)
    },
  })
}

export function createHumanAuthenticator(auth: MaestrlyAuth, config: ServerConfig) {
  const resource = `${config.canonicalUrl}/api/v1`
  const oauthClient = createAuthClient({
    baseURL: config.canonicalUrl,
    plugins: [oauthProviderResourceClient(auth)],
  })

  return async (request: FastifyRequest, requiredScopes: readonly string[] = ['api:read']): Promise<HumanIdentity | null> => {
    if (config.allowTestAuth) {
      const testUser = request.headers['x-maestrly-test-user']
      if (typeof testUser === 'string' && testUser.length > 0) {
        return { userId: testUser, scopes: ['api:read', 'api:write'] }
      }
    }

    const authorization = request.headers.authorization
    if (authorization?.startsWith('Bearer ')) {
      try {
        const claims = await oauthClient.verifyBearerToken(authorization.slice(7), {
          verifyOptions: { audience: resource },
          requiredScopes,
        })
        const subject = claims.sub
        if (!subject) return null
        const scope = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
        return { userId: subject, scopes: scope }
      } catch {
        return null
      }
    }

    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
    if (!session?.user) return null
    return { userId: session.user.id, email: session.user.email, scopes: ['api:read', 'api:write'] }
  }
}
