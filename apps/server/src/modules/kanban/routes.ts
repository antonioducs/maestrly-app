import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { opaqueIdSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { authorizeProject } from '../access/authorize.js'
import {
  changeBoard,
  manageColumns,
  lifecycleCard,
  cardTimeline,
  descriptionHistory,
  restoreDescription,
  changeComment,
  transaction,
  fail,
} from './service.js'
import { repositories, saveRepository, repoBody } from './repositories.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
export function registerKanbanRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate) {
  const prefix = '/api/v1/organizations/:organizationId'
  const paramsSchema = z.object({
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema.optional(),
    boardId: opaqueIdSchema.optional(),
    cardId: opaqueIdSchema.optional(),
    commentId: opaqueIdSchema.optional(),
    repositoryId: opaqueIdSchema.optional(),
  })
  function endpoint<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    schema: T,
    handler: (scope: any, body: z.infer<T>) => Promise<unknown>
  ) {
    app.route({
      method,
      url: prefix + path,
      handler: async (request, reply) => {
        const human = await authenticate(request, method === 'GET' ? undefined : ['api:write'])
        if (!human) fail('Authentication required.', 401)
        const params = paramsSchema.parse(request.params)
        const body = schema.parse(method === 'GET' ? request.query : request.body)
        const scope = { ...params, userId: human.userId }
        if (method === 'GET') return handler(scope, body)
        const key = request.headers['idempotency-key']
        if (typeof key !== 'string' || !key) fail('A valid Idempotency-Key header is required.', 400)
        const result = await executeIdempotent(
          pool,
          {
            organizationId: params.organizationId,
            actorId: human.userId,
            actor: { type: 'human', userId: human.userId },
            key,
            method,
            path: request.url,
            body,
          },
          async () => ({ status: 200, body: await handler(scope, body) })
        )
        if (result.replayed) reply.header('idempotency-replayed', 'true')
        return reply.status(result.status).send(result.body)
      },
    })
  }
  const version = z.number().int().positive()
  endpoint(
    'PATCH',
    '/boards/:boardId',
    z
      .object({
        expectedVersion: version,
        name: z.string().trim().min(1).max(160).optional(),
        archived: z.boolean().optional(),
      })
      .strict(),
    (s, b) => changeBoard(pool, { ...s, ...b })
  )
  endpoint(
    'POST',
    '/boards/:boardId/columns/manage',
    z
      .object({
        expectedVersion: version,
        action: z.enum(['create', 'rename', 'reorder', 'delete']),
        columnId: opaqueIdSchema.optional(),
        name: z.string().trim().min(1).max(120).optional(),
        order: z.array(opaqueIdSchema).max(200).optional(),
        destinationId: opaqueIdSchema.optional(),
        expectedCardIds: z.array(opaqueIdSchema).max(100000).optional(),
      })
      .strict(),
    (s, b) => manageColumns(pool, { ...s, ...b })
  )
  endpoint(
    'POST',
    '/cards/:cardId/lifecycle',
    z.object({ expectedVersion: version, action: z.enum(['archive', 'restore', 'delete', 'cancel']) }).strict(),
    (s, b) => lifecycleCard(pool, { ...s, ...b })
  )
  endpoint(
    'GET',
    '/cards/:cardId/events',
    z.object({ cursor: z.coerce.number().int().nonnegative().default(0), protocolVersion: z.string().optional() }),
    (s, b) => cardTimeline(pool, { ...s, ...b })
  )
  endpoint('GET', '/cards/:cardId/history', z.object({}), (s) => descriptionHistory(pool, s))
  endpoint(
    'POST',
    '/cards/:cardId/history/restore',
    z.object({ expectedVersion: version, versionId: opaqueIdSchema }).strict(),
    (s, b) => restoreDescription(pool, { ...s, ...b })
  )
  endpoint(
    'PATCH',
    '/cards/:cardId/comments/:commentId',
    z
      .object({
        expectedVersion: version,
        body: z.string().trim().min(1).max(100000).optional(),
        deleted: z.boolean().optional(),
      })
      .strict(),
    (s, b) => changeComment(pool, { ...s, ...b })
  )
  endpoint('GET', '/projects/:projectId/repositories', z.object({}), (s) => repositories(pool, s))
  endpoint('POST', '/projects/:projectId/repositories', repoBody, safeSave)
  endpoint(
    'PATCH',
    '/projects/:projectId/repositories/:repositoryId',
    repoBody.extend({ expectedVersion: version }),
    safeSave
  )
  async function safeSave(s: any, b: any) {
    return saveRepository(pool, { ...s, ...b })
  }
  endpoint('GET', '/projects/:projectId/members', z.object({}), (s) =>
    transaction(pool, s, async (client) => {
      await authorizeProject(client, s.organizationId, s.projectId, s.userId, 'project:read')
      const result = await client.query(
        `select om.user_id as id,coalesce(u.name,om.user_id) as name,coalesce(pm.role,'maintainer') as role
      from organization_members om left join "user" u on u.id=om.user_id
      left join project_members pm on pm.organization_id=om.organization_id and pm.project_id=$2 and pm.user_id=om.user_id
      where om.organization_id=$1 and (pm.user_id is not null or om.role in ('owner','admin')) order by name`,
        [s.organizationId, s.projectId]
      )
      return result.rows
    })
  )
}
