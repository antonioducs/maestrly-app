import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cardPatchSchema, moveCardRequestSchema, opaqueIdSchema, prioritySchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { createCard, getCardDetail, moveCard, requestCardPreparation, updateCard } from './service.js'
import { readAuthorizedAttachment, uploadAttachment } from '../attachments/service.js'
import { readAuthorizedArtifact } from '../artifacts/service.js'
import type { ServerConfig } from '../../config.js'
import { createComment } from '../comments/service.js'
import type { Actor } from '@maestrly/protocol'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
const unauthorized = () => Object.assign(new Error('Authentication required.'), { statusCode: 401 })
const createCardBody = z.object({
  title: z.string().min(1).max(500), description: z.string().max(100_000).optional(), columnId: opaqueIdSchema.optional(),
  parentCardId: opaqueIdSchema.nullable().optional(), acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).optional(),
  priority: prioritySchema.optional(), labels: z.array(z.string().min(1).max(80)).max(100).optional(),
  assigneeUserIds: z.array(opaqueIdSchema).max(100).optional(),
}).strict()
const commentBody = z.object({ body: z.string().min(1).max(100_000) }).strict()

function key(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || !value) throw new Error('A valid Idempotency-Key header is required.')
  return value
}

async function withWrite<T>(
  pool: DatabasePool, authenticate: Authenticate, request: FastifyRequest,
  organizationId: string, body: unknown, operation: (human: HumanIdentity) => Promise<T>,
) {
  const human = await authenticate(request, ['api:write'])
  if (!human) throw unauthorized()
  return executeIdempotent(pool, {
    organizationId, actorId: human.userId, actor: { type: 'human', userId: human.userId }, key: key(request),
    method: request.method, path: request.url, body,
  }, async () => ({ status: 200, body: await operation(human) }))
}

function actorFor(request: FastifyRequest, human: HumanIdentity): Actor {
  const kind = request.headers['x-maestrly-client-actor']
  const conversationId = request.headers['x-maestrly-conversation-id']
  return kind === 'desktop-agent' && typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 191
    ? { type: 'desktop_agent', userId: human.userId, conversationId }
    : { type: 'human', userId: human.userId }
}

export function registerCardRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate, config: ServerConfig): void {
  app.get('/api/v1/organizations/:organizationId/cards/:cardId', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    return getCardDetail(pool, { ...params, userId: human.userId })
  })
  app.post('/api/v1/organizations/:organizationId/boards/:boardId/cards', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, boardId: opaqueIdSchema }).parse(request.params)
    const body = createCardBody.parse(request.body)
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => createCard(pool, { ...params, ...body, userId: human.userId, actor: actorFor(request, human) }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.replayed ? result.status : 201).send(result.body)
  })

  app.patch('/api/v1/organizations/:organizationId/cards/:cardId', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const body = cardPatchSchema.parse(request.body)
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => updateCard(pool, { ...params, patch: body, userId: human.userId, actor: actorFor(request, human) }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.post('/api/v1/organizations/:organizationId/cards/:cardId/move', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const body = moveCardRequestSchema.parse(request.body)
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => moveCard(pool, { ...params, move: body, userId: human.userId, actor: actorFor(request, human) }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.status).send(result.body)
  })

  app.post('/api/v1/organizations/:organizationId/cards/:cardId/comments', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const body = commentBody.parse(request.body)
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => createComment(pool, { ...params, body: body.body, userId: human.userId, actor: actorFor(request, human) }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.replayed ? result.status : 201).send(result.body)
  })

  app.post('/api/v1/organizations/:organizationId/cards/:cardId/prepare', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body)
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => requestCardPreparation(pool, { ...params, ...body, userId: human.userId }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.replayed ? result.status : 202).send(result.body)
  })

  app.post('/api/v1/organizations/:organizationId/cards/:cardId/attachments', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, cardId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ filename: z.string().min(1).max(500), contentType: z.string().min(1).max(200), contentBase64: z.string().max(7_000_000) }).strict().parse(request.body)
    if (body.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body.contentBase64)) {
      throw Object.assign(new Error('Attachment content is not valid base64.'), { statusCode: 400 })
    }
    const bytes = Buffer.from(body.contentBase64, 'base64')
    const result = await withWrite(pool, authenticate, request, params.organizationId, body,
      async (human) => uploadAttachment(pool, config.storageDirectory, { ...params, userId: human.userId, filename: body.filename, contentType: body.contentType, bytes }))
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.status(result.replayed ? result.status : 201).send(result.body)
  })

  app.get('/api/v1/organizations/:organizationId/attachments/:attachmentId/download', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, attachmentId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    const attachment = await readAuthorizedAttachment(pool, config.storageDirectory, { ...params, userId: human.userId })
    const filename = attachment.filename.replace(/[\r\n"]/g, '_')
    return reply.header('content-type', attachment.contentType).header('content-disposition', `attachment; filename="${filename}"`).send(attachment.bytes)
  })

  app.get('/api/v1/organizations/:organizationId/artifacts/:artifactId/download', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, artifactId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw unauthorized()
    const artifact = await readAuthorizedArtifact(pool, config.storageDirectory, { ...params, userId: human.userId })
    const filename = artifact.filename.replace(/[\r\n"]/g, '_')
    return reply.header('content-type', artifact.contentType).header('content-disposition', `attachment; filename="${filename}"`).send(artifact.bytes)
  })
}
