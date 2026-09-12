import { authorizeProject } from './authorize.js'
import { teamTransaction, lockTeam } from './team.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { memberChangeSchema, projectInvitationInputSchema, teamChangeSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { ServerConfig } from '../../config.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { getTeam, changeMember, createProjectInvitation, changeInvitation, teamFail } from './team.js'
export function registerTeamRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: ServerConfig,
  authenticate: (r: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
) {
  const root = '/api/v1/organizations/:organizationId/projects/:projectId/team'
  const link = (organizationId: string, result: { token: string | null; email: string; id: string }) => ({
    id: result.id,
    url: result.token
      ? `${config.webOrigin}/invite?${new URLSearchParams({ organization: organizationId, email: result.email, token: result.token })}`
      : null,
  })
  function route(
    method: 'GET' | 'POST' | 'PUT',
    suffix: string,
    schema: z.ZodType,
    run: (scope: any, body: any) => Promise<unknown>
  ) {
    app.route({
      method,
      url: root + suffix,
      handler: async (request, reply) => {
        const human = await authenticate(request, method === 'GET' ? undefined : ['api:write'])
        if (!human) teamFail('Authentication required.', 401)
        const params = z
          .object({ organizationId: z.string().uuid(), projectId: z.string().uuid() })
          .parse(request.params)
        const scope = { ...params, userId: human.userId },
          body = schema.parse(method === 'GET' ? request.query : request.body)
        if (method === 'GET') return run(scope, body)
        const key = request.headers['idempotency-key']
        if (typeof key !== 'string' || !key || key.length > 191) teamFail('A valid Idempotency-Key header is required.')
        const result = await teamTransaction(pool,scope,async client=>{
          await lockTeam(client,scope)
          await authorizeProject(client,scope.organizationId,scope.projectId,scope.userId,'members:manage')
          return executeIdempotent(
          pool,
          {
            organizationId: scope.organizationId,
            actorId: human.userId,
            actor: { type: 'human', userId: human.userId },
            key,
            method,
            path: request.url,
            body,
          },
          async () => ({ status: 200, body: await run(scope, body) })
        )
        })
        if (result.replayed) reply.header('idempotency-replayed', 'true')
        return reply.status(result.status).send(result.body)
      },
    })
  }
  route('GET', '', z.object({}), (s) => getTeam(pool, s))
  route('PUT', '/members', memberChangeSchema, (s, b) => changeMember(pool, s, b))
  route('POST', '/invitations', projectInvitationInputSchema, async (s, b) =>
    link(s.organizationId, await createProjectInvitation(pool, s, b))
  )
  route(
    'POST',
    '/invitations/change',
    teamChangeSchema
      .extend({
        invitationId: z.string().uuid(),
        action: z.enum(['revoke', 'renew']),
        expiresInHours: z.number().int().min(1).max(168).default(24),
      })
      .strict(),
    async (s, b) => link(s.organizationId, await changeInvitation(pool, s, b))
  )
}
