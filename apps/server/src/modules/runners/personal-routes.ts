import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import type { HumanIdentity } from '../auth/routes.js'
import { authorizeProject } from '../access/authorize.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { fail } from '../kanban/service.js'
import {
  registerPersonalDevice,
  listPersonalDevices,
  disablePersonalDevice,
  personalDevicePresence,
} from './personal-devices.js'

export function registerPersonalDeviceRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  authenticate: (r: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
) {
  app.get('/api/v1/me', async (request) => {
    const human = await authenticate(request)
    if (!human) fail('Authentication required.', 401)
    const user=await pool.query<{email:string}>('select email from "user" where id=$1',[human.userId])
    return { userId: human.userId, email: user.rows[0]?.email??human.email }
  })
  app.post('/api/v1/personal-devices', async (request, reply) => {
    const input = z
      .object({
        organizationId: z.string().uuid(),
        projectIds: z.array(z.string().uuid()).min(1).max(100),
        name: z.string().trim().min(1).max(160),
        deviceId: z.string().uuid().optional(),
      })
      .strict()
      .parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) fail('Authentication required.', 401)
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !key || key.length > 191) fail('A valid Idempotency-Key header is required.', 400)
    const actor = { type: 'human' as const, userId: human.userId }
    // Check current permission before a replay can reveal an enrollment credential.
    const result = await inTenantTransaction(pool, { organizationId: input.organizationId, actor }, async (client) => {
      for (const id of input.projectIds)
        await authorizeProject(client, input.organizationId, id, human.userId, 'execution:request')
      return executeIdempotent(
        pool,
        {
          organizationId: input.organizationId,
          actorId: human.userId,
          actor,
          key,
          method: request.method,
          path: request.url,
          body: input,
        },
        async () => ({ status: 200, body: await registerPersonalDevice(pool, { ...input, userId: human.userId }) })
      )
    })
    if (result.replayed) reply.header('idempotency-replayed', 'true')
    return reply.send(result.body)
  })
  app.get('/api/v1/organizations/:organizationId/projects/:projectId/personal-devices', async (request) => {
    const input = z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() }).parse(request.params)
    const human = await authenticate(request)
    if (!human) fail('Authentication required.', 401)
    return listPersonalDevices(pool, { ...input, userId: human.userId })
  })
  app.post('/api/v1/organizations/:organizationId/personal-devices/:deviceId/revoke', async (request) => {
    const input = z.object({ organizationId: z.string().uuid(), deviceId: z.string().uuid() }).parse(request.params)
    const human = await authenticate(request, ['api:write'])
    if (!human) fail('Authentication required.', 401)
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !key || key.length > 191) fail('A valid Idempotency-Key header is required.', 400)
    const result = await executeIdempotent(
      pool,
      {
        organizationId: input.organizationId,
        actorId: human.userId,
        actor: { type: 'human', userId: human.userId },
        key,
        method: request.method,
        path: request.url,
        body: {},
      },
      async () => ({ status: 200, body: await disablePersonalDevice(pool, { ...input, userId: human.userId }) })
    )
    return result.body
  })
  app.post('/api/v1/personal-devices/presence', async (request) => {
    const body = z.object({ online: z.boolean() }).strict().parse(request.body)
    const identity = z
      .object({ organizationId: z.string().uuid(), runnerId: z.string().uuid(), credential: z.string().min(32) })
      .parse({
        organizationId: request.headers['x-maestrly-organization-id'],
        runnerId: request.headers['x-maestrly-runner-id'],
        credential: request.headers.authorization?.startsWith('Runner ')
          ? request.headers.authorization.slice(7)
          : undefined,
      })
    return personalDevicePresence(pool, { ...identity, ...body })
  })
}
