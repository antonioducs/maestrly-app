import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { cardPatchSchema, moveCardRequestSchema, opaqueIdSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import {
  authenticateExecutionToken,
  commentOnAssignedCard,
  createLinkedSubtask,
  listAuthorizedCards,
  moveAssignedCard,
  updateAssignedCard,
} from './service.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import type { ExecutionScope } from './service.js'

function unauthorized(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 401 })
}

export function registerAgentToolRoutes(app: FastifyInstance, pool: DatabasePool): void {
  async function scopeFor(request: import('fastify').FastifyRequest) {
    const authorization = request.headers.authorization
    const organizationId = request.headers['x-maestrly-organization-id']
    if (!authorization?.startsWith('Bearer ') || typeof organizationId !== 'string') throw unauthorized('Execution authorization is required.')
    const scope = await authenticateExecutionToken(pool, organizationId, authorization.slice(7))
    if (!scope) throw unauthorized('Execution authorization is expired or revoked.')
    return scope
  }

  async function mutate<T>(
    request: import('fastify').FastifyRequest,
    scope: ExecutionScope,
    body: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !key) throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { statusCode: 400 })
    const result = await executeIdempotent(pool, {
      organizationId: scope.organizationId, actorId: `run:${scope.runId}`,
      actor: { type: 'execution_agent', runId: scope.runId, runnerId: scope.runnerId, requestedByUserId: scope.requestedByUserId },
      key, method: request.method, path: request.url, body,
    }, async () => ({ status: 200, body: await operation() }))
    return result.body
  }

  app.get('/api/v1/agent-tools/projects/:projectId/cards', async (request) => {
    const params = z.object({ projectId: opaqueIdSchema }).parse(request.params)
    const scope = await scopeFor(request)
    if (params.projectId !== scope.projectId) throw Object.assign(new Error('Execution cannot access another project.'), { statusCode: 403 })
    return listAuthorizedCards(pool, scope)
  })

  app.patch('/api/v1/agent-tools/cards/:cardId', async (request) => {
    const params = z.object({ cardId: opaqueIdSchema }).parse(request.params)
    const scope = await scopeFor(request)
    if (params.cardId !== scope.cardId) throw Object.assign(new Error('Execution can only edit its assigned card.'), { statusCode: 403 })
    const body = cardPatchSchema.parse(request.body)
    return mutate(request, scope, body, () => updateAssignedCard(pool, scope, body))
  })

  app.post('/api/v1/agent-tools/cards/:cardId/comments', async (request) => {
    const params = z.object({ cardId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ body: z.string().min(1).max(100_000) }).strict().parse(request.body)
    const scope = await scopeFor(request)
    if (params.cardId !== scope.cardId) throw Object.assign(new Error('Execution can only comment on its assigned card.'), { statusCode: 403 })
    return mutate(request, scope, body, () => commentOnAssignedCard(pool, scope, body.body))
  })

  app.post('/api/v1/agent-tools/cards/:cardId/move', async (request) => {
    const params = z.object({ cardId: opaqueIdSchema }).parse(request.params)
    const scope = await scopeFor(request)
    if (params.cardId !== scope.cardId) throw Object.assign(new Error('Execution can only move its assigned card.'), { statusCode: 403 })
    const body = moveCardRequestSchema.parse(request.body)
    return mutate(request, scope, body, () => moveAssignedCard(pool, scope, body))
  })

  app.post('/api/v1/agent-tools/cards/:cardId/subtasks', async (request) => {
    const params = z.object({ cardId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ title: z.string().min(1).max(500), description: z.string().max(100_000).optional() }).strict().parse(request.body)
    const scope = await scopeFor(request)
    if (params.cardId !== scope.cardId) throw Object.assign(new Error('Execution can only create subtasks for its assigned card.'), { statusCode: 403 })
    return mutate(request, scope, body, () => createLinkedSubtask(pool, scope, body))
  })
}
