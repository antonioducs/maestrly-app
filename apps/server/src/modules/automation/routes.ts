import { transaction } from '../kanban/service.js'
import { authorizeProject } from '../access/authorize.js'
import { branchSchema } from '../kanban/repositories.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { capabilitySchema, deliveryPolicySchema, opaqueIdSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { decideApproval } from '../approvals/service.js'
import { assignColumnPolicy, createExecutionPolicy, mapPolicy } from './policies.js'
import { answerInformationRequest } from '../jobs/service.js'
import { executeIdempotent } from '../events/http-idempotency.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !key)
    throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { statusCode: 400 })
  return key
}

function idempotent<T>(
  pool: DatabasePool,
  request: FastifyRequest,
  organizationId: string,
  human: HumanIdentity,
  body: unknown,
  status: number,
  operation: () => Promise<T>
) {
  return executeIdempotent(
    pool,
    {
      organizationId,
      actorId: human.userId,
      actor: { type: 'human', userId: human.userId },
      key: idempotencyKey(request),
      method: request.method,
      path: request.url,
      body,
    },
    async () => ({ status, body: await operation() })
  )
}

export function registerAutomationRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate): void {
  app.get('/api/v1/organizations/:organizationId/projects/:projectId/policies', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    return transaction(pool, { ...params, userId: human.userId }, async (client) => {
      await authorizeProject(client, params.organizationId, params.projectId, human.userId, 'project:read')
      const rows = await client.query(
        'select * from execution_policies where organization_id=$1 and project_id=$2 order by created_at desc',
        [params.organizationId, params.projectId]
      )
      return rows.rows.map(mapPolicy)
    })
  })
  app.post('/api/v1/organizations/:organizationId/projects/:projectId/policies', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const body = z
      .object({
        policyKey: opaqueIdSchema.optional(),
        name: z.string().min(1).max(160),
        taskType: z.string().min(1).max(120),
        executionProfileId: opaqueIdSchema,
        requiredCapabilities: z.array(capabilitySchema).max(100),
        repositoryBindingId: opaqueIdSchema.nullable(),
        repositoryBranch: branchSchema.optional(),
        provider: z.enum(['codex', 'claude-agent']),
        model: z.string().min(1).max(160),
        effort: z.string().max(80).optional(),
        approvalRequired: z.boolean(),
        maxDurationSeconds: z.number().int().positive().max(86_400),
        maxLogBytes: z.number().int().positive(),
        delivery: deliveryPolicySchema,
        enabled: z.boolean(),
      })
      .strict()
      .parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    const result = await idempotent(pool, request, params.organizationId, human, body, 201, () =>
      createExecutionPolicy(pool, { ...params, ...body, userId: human.userId })
    )
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.put(
    '/api/v1/organizations/:organizationId/projects/:projectId/columns/:columnId/policy',
    async (request, reply) => {
      const params = z
        .object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema, columnId: opaqueIdSchema })
        .parse(request.params)
      const body = z.object({ policyId: opaqueIdSchema.nullable() }).strict().parse(request.body)
      const human = await authenticate(request, ['api:write'])
      if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
      const result = await idempotent(pool, request, params.organizationId, human, body, 204, async () => {
        await assignColumnPolicy(pool, { ...params, ...body, userId: human.userId })
        return { ok: true }
      })
      if (result.replayed) reply.header('idempotency-replayed', 'true')
      return reply.status(204).send()
    }
  )

  app.post(
    '/api/v1/organizations/:organizationId/projects/:projectId/approvals/:approvalId',
    async (request, reply) => {
      const params = z
        .object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema, approvalId: opaqueIdSchema })
        .parse(request.params)
      const body = z
        .object({ decision: z.enum(['approved', 'rejected']) })
        .strict()
        .parse(request.body)
      const human = await authenticate(request, ['api:write'])
      if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
      const result = await idempotent(pool, request, params.organizationId, human, body, 204, async () => {
        await decideApproval(pool, { ...params, ...body, userId: human.userId })
        return { ok: true }
      })
      if (result.replayed) reply.header('idempotency-replayed', 'true')
      return reply.status(204).send()
    }
  )

  app.post(
    '/api/v1/organizations/:organizationId/projects/:projectId/information-requests/:requestId',
    async (request, reply) => {
      const params = z
        .object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema, requestId: opaqueIdSchema })
        .parse(request.params)
      const body = z
        .object({ response: z.string().min(1).max(100_000) })
        .strict()
        .parse(request.body)
      const human = await authenticate(request, ['api:write'])
      if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
      const result = await idempotent(pool, request, params.organizationId, human, body, 204, async () => {
        await answerInformationRequest(pool, { ...params, ...body, userId: human.userId })
        return { ok: true }
      })
      if (result.replayed) reply.header('idempotency-replayed', 'true')
      return reply.status(204).send()
    }
  )
}
