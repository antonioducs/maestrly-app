import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { opaqueIdSchema, organizationRoleSchema } from '@maestrly/protocol'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import { randomUUID } from 'node:crypto'
import type { HumanIdentity } from '../auth/routes.js'
import { acceptInvitation, createInvitation, inspectInvitation } from './invitations.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

export function registerAccessRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: ServerConfig,
  authenticate: Authenticate,
): void {
  app.post('/api/v1/organizations/:organizationId/invitations', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema }).parse(request.params)
    const body = z.object({
      email: z.string().email(), role: organizationRoleSchema.default('member'),
      expiresInHours: z.number().int().positive().max(168).default(24),
    }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    const invitation = await createInvitation(pool, {
      organizationId: params.organizationId, email: body.email, role: body.role,
      expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000), createdByUserId: human.userId,
    })
    return reply.status(201).send({
      id: invitation.id,
      url: `${config.webOrigin}/invite?organization=${encodeURIComponent(params.organizationId)}&email=${encodeURIComponent(body.email)}&token=${encodeURIComponent(invitation.token)}`,
    })
  })

  app.post('/api/v1/invitations/inspect',async(request)=>{
    const body=z.object({organizationId:opaqueIdSchema,token:z.string().min(32),email:z.string().email()}).strict().parse(request.body)
    return inspectInvitation(pool,body)
  })

  app.post('/api/v1/invitations/accept', async (request, reply) => {
    const body = z.object({ organizationId: opaqueIdSchema, token: z.string().min(32), email: z.string().email() }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human || human.email?.toLowerCase() !== body.email.toLowerCase()) throw Object.assign(new Error('Sign in with the invited email first.'), { statusCode: 401 })
    await acceptInvitation(pool, { ...body, userId: human.userId })
    return reply.status(204).send()
  })

  app.post('/api/v1/invitations/register', async (request, reply) => {
    const body = z.object({
      organizationId: opaqueIdSchema, token: z.string().min(32), email: z.string().email(),
      name: z.string().min(1).max(160), password: z.string().min(12).max(128),
    }).strict().parse(request.body)
    if (!(await inspectInvitation(pool, body)).valid) throw Object.assign(new Error('Invitation is invalid, expired, or already used.'), { statusCode: 400 })
    const userId=randomUUID()
    await acceptInvitation(pool,{...body,userId,registration:{name:body.name,password:body.password}})
    return reply.status(201).send({user:{id:userId,email:body.email,name:body.name}})
  })
}
