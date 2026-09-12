import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  columnAutomationSchema,
  cardAutomationOverrideSchema,
  automationLimitsSchema,
  opaqueIdSchema,
  renderAutomationPrompt,
} from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { fail, transaction, boardLock, cardScope } from '../kanban/service.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'
import {
  getColumnAutomation,
  saveColumnAutomation,
  columnAutomationHistory,
  cardAutomationContext,
  saveCardOverride,
  releaseDispatch,
  saveBoardAutomationLimits,
  projectCatalog,
  columnScope,
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
    async (s, b) => {
      const history = await columnAutomationHistory(pool, s)
      const version = history.find((p) => p.id === b.policyId)
      if (!version) fail('Configuration version not found.', 404)
      return saveColumnAutomation(pool, { ...s, expectedPolicyId: b.expectedPolicyId, config: version.config })
    }
  )
  route('GET', '/projects/:projectId/automation-catalog', z.object({}), (s) =>
    transaction(pool, s, async (client) => {
      await authorizeProject(client, s.organizationId, s.projectId, s.userId, 'project:read')
      return { runners: await projectCatalog(client, s.organizationId, s.projectId, s.userId) }
    })
  )
  route(
    'POST',
    '/columns/:columnId/automation/preview',
    z.object({ cardId: opaqueIdSchema, promptTemplate: z.string().max(100000) }).strict(),
    (s, b) =>
      transaction(pool, s, async (client) => {
        const card = await cardScope(client, s, b.cardId),
          column = await columnScope(client, s, s.columnId)
        if (card.board_id !== column.board_id) fail('Column belongs to another board.', 400)
        const prompt = renderAutomationPrompt(
          b.promptTemplate,
          { id: card.id, title: card.title, description: card.description },
          column.name
        )
        if (prompt.length > 200000) fail('Rendered prompt is too long.', 400)
        return { prompt }
      })
  )
  route(
    'GET',
    '/cards/:cardId/execution-events',
    z.object({ runId: opaqueIdSchema, offset: z.coerce.number().int().min(0).max(100000).default(0) }),
    (s, b) =>
      transaction(pool, s, async (client) => {
        await cardScope(client, s, s.cardId)
        const rows = await client.query(
          `select e.id,e.type,e.data,e.created_at as "createdAt" from execution_events e join runs r on r.id=e.run_id join jobs j on j.id=r.job_id
      where e.organization_id=$1 and j.card_id=$2 and r.id=$3 order by e.created_at,e.id limit 51 offset $4`,
          [s.organizationId, s.cardId, b.runId, b.offset]
        )
        return { items: rows.rows.slice(0, 50), more: rows.rows.length > 50 }
      })
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
        personalDeviceId:z.string().uuid().optional(),
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
    (s, b) =>
      transaction(pool, s, async (client) => {
        const board = await boardLock(client, s, s.boardId, b.expectedVersion)
        await authorizeProject(client, s.organizationId, board.project_id, s.userId, 'automation:manage')
        const configured = (await client.query('select roles_configured from boards where id=$1', [s.boardId])).rows[0]
        if (configured.roles_configured) fail('Fixed columns are already defined.')
        let backlogId = b.backlogId,
          doneId = b.doneId
        if (b.create) {
          for (const [role, name] of [
            ['backlog', 'Backlog'],
            ['done', 'Done'],
          ]) {
            const row = await client.query(
              `insert into board_columns(organization_id,project_id,board_id,name,role,position)
          values($1,$2,$3,$4,$5,(select coalesce(max(position)+1,0) from board_columns where board_id=$3)) returning id`,
              [s.organizationId, board.project_id, s.boardId, name, role]
            )
            if (role === 'backlog') backlogId = row.rows[0].id
            else doneId = row.rows[0].id
          }
        }
        if (!backlogId || !doneId || backlogId === doneId) fail('Choose two different fixed columns.', 400)
        const rows = await client.query<{ id: string }>(
          'select id from board_columns where board_id=$1 and deleted_at is null order by position',
          [s.boardId]
        )
        if (!rows.rows.some((c) => c.id === backlogId) || !rows.rows.some((c) => c.id === doneId))
          fail('Column not found.', 404)
        await client.query(
          "update board_columns set role=case when id=$2 then 'backlog' when id=$3 then 'done' else 'normal' end where board_id=$1 and deleted_at is null",
          [s.boardId, backlogId, doneId]
        )
        const all = await client.query<{ id: string }>(
          'select id from board_columns where board_id=$1 order by deleted_at nulls first,position',
          [s.boardId]
        )
        const order = [
          backlogId,
          ...rows.rows.map((r) => r.id).filter((id) => id !== backlogId && id !== doneId),
          doneId,
          ...all.rows.map((r) => r.id).filter((id) => !rows.rows.some((c) => c.id === id)),
        ]
        await client.query(
          'update board_columns set position=position+(select max(position)+1 from board_columns where board_id=$1) where board_id=$1',
          [s.boardId]
        )
        for (const [position, id] of order.entries())
          await client.query('update board_columns set position=$2 where id=$1', [id, position])
        await client.query('update boards set roles_configured=true,version=version+1 where id=$1', [s.boardId])
        await appendDomainEvent(client, {
          organizationId: s.organizationId,
          projectId: board.project_id,
          type: 'board.fixed_columns_defined',
          aggregateType: 'board',
          aggregateId: s.boardId,
          actor: { type: 'human', userId: s.userId },
          data: { backlogId, doneId },
        })
        return { ok: true }
      })
  )
}
