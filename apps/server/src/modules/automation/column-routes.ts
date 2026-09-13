import { authorizeProject } from '../access/authorize.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  columnAutomationSchema,
  cardAutomationOverrideSchema,
  automationLimitsSchema,
  opaqueIdSchema,
} from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { fail, transaction } from '../kanban/service.js'
import {
  restoreColumnAutomation,
  automationCatalog,
  previewAutomation,
  executionEvents,
  defineFixedColumns,
  getColumnAutomation,
  saveColumnAutomation,
  columnAutomationHistory,
  cardAutomationContext,
  saveCardOverride,
  releaseDispatch,
  saveBoardAutomationLimits,
} from './column-service.js'
import { requestColumnAgent } from './dispatch.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
export function registerColumnAutomationRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate) {
  const root = '/api/v1/organizations/:organizationId'
  function route<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: S,
    handler: (scope: any, body: z.infer<S>) => Promise<unknown>
  ) {
    app.route({
      method,
      url: root + path,
      handler: async (request, reply) => {
        const human = await authenticate(request, method === 'GET' ? undefined : ['api:write'])
        if (!human) fail('Authentication required.', 401)
        const params = z
          .object({
            organizationId: opaqueIdSchema,
            projectId: opaqueIdSchema.optional(),
            boardId: opaqueIdSchema.optional(),
            columnId: opaqueIdSchema.optional(),
            cardId: opaqueIdSchema.optional(),
          })
          .parse(request.params)
        const scope = { ...params, userId: human.userId }
        const body = schema.parse(method === 'GET' ? request.query : request.body)
        if (method === 'GET') return handler(scope, body)
        // Recheck the current grant before idempotency can return a saved response.
        await transaction(pool, scope, async (client) => {
          let projectId = params.projectId
          if (!projectId) {
            const table = params.columnId ? 'board_columns' : params.cardId ? 'cards' : 'boards'
            const resourceId = params.columnId ?? params.cardId ?? params.boardId
            projectId = (
              await client.query(`select project_id from ${table} where organization_id=$1 and id=$2`, [
                params.organizationId,
                resourceId,
              ])
            ).rows[0]?.project_id
          }
          if (!projectId) fail('Resource not found.', 404)
          const preview = path.endsWith('/preview')
          await authorizeProject(
            client,
            params.organizationId,
            projectId,
            human.userId,
            preview ? 'project:read' : 'work:write'
          )
          if (!preview)
            await authorizeProject(
              client,
              params.organizationId,
              projectId,
              human.userId,
              params.columnId || params.boardId ? 'automation:manage' : 'execution:request'
            )
        })
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
  route('GET', '/columns/:columnId/automation', z.object({}), (s) => getColumnAutomation(pool, s))
  route(
    'PUT',
    '/columns/:columnId/automation',
    z.object({ expectedPolicyId: opaqueIdSchema.nullable(), config: columnAutomationSchema }).strict(),
    (s, b) => saveColumnAutomation(pool, { ...s, ...b })
  )
  route('GET', '/columns/:columnId/automation/history', z.object({}), (s) => columnAutomationHistory(pool, s))
  route(
    'POST',
    '/columns/:columnId/automation/restore',
    z.object({ expectedPolicyId: opaqueIdSchema.nullable(), policyId: opaqueIdSchema }).strict(),
    (s, b) => restoreColumnAutomation(pool, { ...s, ...b })
  )
  route('GET', '/projects/:projectId/automation-catalog', z.object({}), (s) => automationCatalog(pool, s))
  route(
    'POST',
    '/columns/:columnId/automation/preview',
    z.object({ cardId: opaqueIdSchema, promptTemplate: z.string().max(100000) }).strict(),
    (s, b) => previewAutomation(pool, { ...s, ...b })
  )
  route(
    'GET',
    '/cards/:cardId/execution-events',
    z.object({ runId: opaqueIdSchema, offset: z.coerce.number().int().min(0).max(100000).default(0) }),
    (s, b) => executionEvents(pool, { ...s, ...b })
  )
  route('GET', '/cards/:cardId/automation', z.object({ columnId: opaqueIdSchema.optional() }), (s, b) =>
    cardAutomationContext(pool, { ...s, ...b })
  )
  route(
    'PUT',
    '/cards/:cardId/automation/override',
    z
      .object({
        columnId: opaqueIdSchema,
        expectedVersion: z.number().int().nonnegative(),
        config: cardAutomationOverrideSchema.nullable(),
      })
      .strict(),
    (s, b) => saveCardOverride(pool, { ...s, ...b })
  )
  route(
    'POST',
    '/cards/:cardId/automation/run',
    z
      .object({
        expectedVersion: z.number().int().positive(),
        expectedPolicyId: opaqueIdSchema.nullable(),
        personalDeviceId: z.string().uuid().optional(),
        expectedOverrideVersion: z.number().int().nonnegative(),
      })
      .strict(),
    (s, b) => requestColumnAgent(pool, { ...s, ...b })
  )
  route('POST', '/cards/:cardId/automation/release', z.object({ columnId: opaqueIdSchema }).strict(), (s, b) =>
    releaseDispatch(pool, { ...s, ...b })
  )
  route(
    'PUT',
    '/boards/:boardId/automation-limits',
    z.object({ expectedVersion: z.number().int().positive(), limits: automationLimitsSchema }).strict(),
    (s, b) => saveBoardAutomationLimits(pool, { ...s, ...b })
  )
  route(
    'POST',
    '/boards/:boardId/fixed-columns',
    z
      .object({
        expectedVersion: z.number().int().positive(),
        backlogId: opaqueIdSchema.optional(),
        doneId: opaqueIdSchema.optional(),
        create: z.boolean().default(false),
      })
      .strict(),
    (s, b) => defineFixedColumns(pool, { ...s, ...b })
  )
}
