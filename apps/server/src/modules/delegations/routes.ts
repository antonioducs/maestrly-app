import {
  delegationCommandSchema,
  delegationCreateSchema,
  delegationPresetInputSchema,
  delegationPresetPatchSchema,
  delegationTaskStateSchema,
} from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { applyDelegationCommand } from './commands.js'
import { listDelegationExecutors } from './model-catalog.js'
import { createDelegationPreset, listDelegationPresets, patchDelegationPreset } from './presets.js'
import { delegationFail } from './repository.js'
import {
  createDelegation,
  getDelegation,
  listDelegationAttempts,
  listDelegationEvents,
  listDelegations,
  type DelegationScope,
} from './service.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

const params = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  presetId: z.string().uuid().optional(),
})

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !key || key.length > 191)
    delegationFail('A valid Idempotency-Key header is required.', 400)
  return key
}

export function registerDelegationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: ServerConfig,
  authenticate: Authenticate
): void {
  const root = '/api/v1/organizations/:organizationId/projects/:projectId'
  const links = { webOrigin: config.webOrigin }

  async function scope(request: FastifyRequest, write = false): Promise<DelegationScope & { taskId?: string; presetId?: string }> {
    const human = await authenticate(request, write ? ['api:write'] : undefined)
    if (!human) delegationFail('Authentication required.', 401)
    const parsed = params.parse(request.params)
    return { ...parsed, userId: human.userId, connectionId: null }
  }

  app.get(root + '/delegation-catalog', async (request) => {
    const current = await scope(request)
    return { executors: await listDelegationExecutors(pool, current) }
  })

  app.get(root + '/delegations', async (request) => {
    const current = await scope(request)
    const query = z
      .object({
        state: delegationTaskStateSchema.optional(),
        cardId: z.string().uuid().optional(),
        after: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query)
    return listDelegations(pool, current, query, links)
  })

  app.post(root + '/delegations', async (request, reply) => {
    const current = await scope(request, true)
    const body = delegationCreateSchema.parse(request.body)
    // Creation is idempotent through the shared command table on the created task; the header is still
    // required so a retried POST is explicit about its intent.
    idempotencyKey(request)
    const view = await createDelegation(pool, current, body, links)
    return reply.status(201).send(view)
  })

  app.get(root + '/delegations/:taskId', async (request) => {
    const current = await scope(request)
    return getDelegation(pool, current, current.taskId!, links)
  })

  app.post(root + '/delegations/:taskId/commands', async (request) => {
    const current = await scope(request, true)
    const command = delegationCommandSchema.parse(request.body)
    return applyDelegationCommand(pool, current, current.taskId!, command, idempotencyKey(request))
  })

  app.get(root + '/delegations/:taskId/attempts', async (request) => {
    const current = await scope(request)
    return { items: await listDelegationAttempts(pool, current, current.taskId!) }
  })

  app.get(root + '/delegations/:taskId/events', async (request, reply) => {
    const current = await scope(request)
    const query = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) }).parse(request.query)
    let cursor = Math.max(query.cursor, Number(request.headers['last-event-id'] ?? 0) || 0)
    if (request.headers.accept?.includes('application/json'))
      return { items: await listDelegationEvents(pool, current, current.taskId!, cursor) }
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    let closed = false
    request.raw.once('close', () => {
      closed = true
    })
    while (!closed) {
      let events: Awaited<ReturnType<typeof listDelegationEvents>>
      try {
        events = await listDelegationEvents(pool, current, current.taskId!, cursor)
      } catch {
        reply.raw.write('event: access_revoked\ndata: {}\n\n')
        reply.raw.end()
        break
      }
      if (!events.length) reply.raw.write(': keep-alive\n\n')
      for (const event of events) {
        cursor = event.sequence
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    return reply
  })

  app.get(root + '/delegation-presets', async (request) => {
    const current = await scope(request)
    return { items: await listDelegationPresets(pool, current) }
  })

  app.post(root + '/delegation-presets', async (request, reply) => {
    const current = await scope(request, true)
    idempotencyKey(request)
    const body = delegationPresetInputSchema.parse(request.body)
    return reply.status(201).send(await createDelegationPreset(pool, current, body))
  })

  app.patch(root + '/delegation-presets/:presetId', async (request) => {
    const current = await scope(request, true)
    idempotencyKey(request)
    const body = delegationPresetPatchSchema.parse(request.body)
    return patchDelegationPreset(pool, { ...current, presetId: current.presetId! }, body)
  })
}
