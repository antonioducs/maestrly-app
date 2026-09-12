import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { opaqueIdSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { createBoard, createColumn, getBoard, listBoards, updateColumn } from './service.js'
import { createProject, getProject, listProjects, updateProject } from '../projects/service.js'
import { executeIdempotent } from '../events/http-idempotency.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

const unauthorized = () => Object.assign(new Error('Authentication required.'), { statusCode: 401 })

const projectBody = z.object({ name: z.string().min(1).max(160), description: z.string().max(20_000).optional() }).strict()

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 1 || value.length > 191) throw new Error('A valid Idempotency-Key header is required.')
  return value
}

function idempotent<T>(pool: DatabasePool, request: FastifyRequest, organizationId: string, human: HumanIdentity, body: unknown, status: number, operation: () => Promise<T>) {
  return executeIdempotent(pool, {
    organizationId, actorId: human.userId, actor: { type: 'human', userId: human.userId },
    key: idempotencyKey(request), method: request.method, path: request.url, body,
  }, async () => ({ status, body: await operation() }))
}

export function registerBoardRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate): void {
  app.get('/api/v1/organizations/:organizationId/projects', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    return listProjects(pool, params.organizationId, human.userId)
  })

  app.post('/api/v1/organizations/:organizationId/projects', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema }).parse(request.params)
    const body = projectBody.parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw unauthorized()
    const result = await executeIdempotent(pool, {
      organizationId: params.organizationId, actorId: human.userId, actor: { type: 'human', userId: human.userId },
      key: idempotencyKey(request), method: request.method, path: request.url, body,
    }, async () => ({ status: 201, body: await createProject(pool, { ...params, ...body, actorUserId: human.userId }) }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    return getProject(pool, params.organizationId, params.projectId, human.userId)
  })

  app.patch('/api/v1/organizations/:organizationId/projects/:projectId', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ name: z.string().min(1).max(160).optional(), description: z.string().max(20_000).optional(), archived: z.boolean().optional() }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw unauthorized()
    const result = await idempotent(pool, request, params.organizationId, human, body, 200,
      () => updateProject(pool, { ...params, ...body, userId: human.userId }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.get('/api/v1/organizations/:organizationId/boards/:boardId', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, boardId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    return getBoard(pool, { ...params, userId: human.userId })
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId/boards', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    return listBoards(pool, { ...params, includeArchived: z.object({includeArchived:z.enum(['true','false']).optional()}).parse(request.query).includeArchived === 'true', userId: human.userId })
  })

  app.post('/api/v1/organizations/:organizationId/projects/:projectId/boards', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ name: z.string().trim().min(1).max(160), template: z.enum(['complete','simple','blank']).default('blank'), locale:z.enum(['en','pt-BR']).default('en') }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw unauthorized()
    const result = await idempotent(pool, request, params.organizationId, human, body, 201,
      () => createBoard(pool, { ...params, ...body, userId: human.userId }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.post('/api/v1/organizations/:organizationId/boards/:boardId/columns', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, boardId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ name: z.string().min(1).max(120) }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw unauthorized()
    const result = await idempotent(pool, request, params.organizationId, human, body, 201,
      () => createColumn(pool, { ...params, ...body, userId: human.userId }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.patch('/api/v1/organizations/:organizationId/columns/:columnId', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, columnId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ name: z.string().min(1).max(120) }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw unauthorized()
    const result = await idempotent(pool, request, params.organizationId, human, body, 200,
      () => updateColumn(pool, { ...params, ...body, userId: human.userId }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })
}
