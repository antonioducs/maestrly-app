import { executeIdempotent } from '../events/http-idempotency.js'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { capabilitySchema, opaqueIdSchema, runnerAutomationCapabilitiesSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { claimJob } from '../jobs/claim.js'
import { appendExecutionEvent, renewLease } from '../jobs/service.js'
import { completeRun } from '../runs/service.js'
import { createRunnerEnrollment, enrollRunner, listProjectRunners, revokeRunner, selfRevokeRunner, verifyRunnerCredential } from './service.js'
import { inTenantTransaction } from '../../db/transaction.js'
import type { ServerConfig } from '../../config.js'
import { uploadRunArtifact } from '../artifacts/service.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
const runnerHeaders = z.object({
  organizationId: opaqueIdSchema,
  runnerId: opaqueIdSchema,
  credential: z.string().min(32),
  protocolVersion: z.string().min(1),
})

function runnerIdentity(request: FastifyRequest) {
  return runnerHeaders.parse({
    organizationId: request.headers['x-maestrly-organization-id'],
    runnerId: request.headers['x-maestrly-runner-id'],
    credential: request.headers.authorization?.startsWith('Runner ') ? request.headers.authorization.slice(7) : undefined,
    protocolVersion: request.headers['x-maestrly-protocol-version'],
  })
}

export function registerRunnerRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Authenticate, config: ServerConfig): void {
  app.post('/api/v1/runner-enrollments', async (request) => {
    const body = z.object({
      organizationId: opaqueIdSchema, projectIds: z.array(opaqueIdSchema).min(1), expiresInMinutes: z.number().int().positive().max(60).optional(),
    }).strict().parse(request.body)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    const key=request.headers['idempotency-key']
    if(typeof key!=='string'||!key) throw Object.assign(new Error('A valid Idempotency-Key header is required.'),{statusCode:400})
    const result=await executeIdempotent(pool,{organizationId:body.organizationId,actorId:human.userId,actor:{type:'human',userId:human.userId},key,method:request.method,path:request.url,body},async()=>({status:200,body:await createRunnerEnrollment(pool,{...body,userId:human.userId})}))
    return result.body
  })

  app.post('/api/v1/runners/enroll', async (request, reply) => {
    const body = z.object({
      organizationId: opaqueIdSchema, token: z.string().min(32), name: z.string().min(1).max(160),
      protocolVersion: z.string().min(1), capabilities: z.array(capabilitySchema).max(100),
      maxConcurrency: z.number().int().positive().max(128).default(1),
    }).strict().parse(request.body)
    return reply.status(201).send(await enrollRunner(pool, body))
  })

  app.post('/api/v1/runners/presence',async request=>{
    const identity=runnerIdentity(request),body=z.object({online:z.boolean()}).strict().parse(request.body)
    if(!await verifyRunnerCredential(pool,identity))throw Object.assign(new Error('Runner credential is invalid or revoked.'),{statusCode:401})
    return inTenantTransaction(pool,{organizationId:identity.organizationId,actor:{type:'runner',runnerId:identity.runnerId}},async client=>{
      const updated=await client.query("update runners set status=case when $2 then 'online' else 'offline' end,last_seen_at=case when $2 then now() else null end where id=$1 and owner_user_id is null and status<>'revoked'",[identity.runnerId,body.online])
      return {enabled:updated.rowCount===1}
    })
  })

  app.post('/api/v1/runners/claim', async (request) => {
    const identity = runnerIdentity(request)
    const body=z.object({automationCapabilities:runnerAutomationCapabilitiesSchema.optional(),repositories:z.array(z.object({bindingId:opaqueIdSchema,available:z.boolean(),branches:z.array(z.string().min(1).max(250)).max(500),error:z.string().max(500).optional()}).strict()).max(100).default([])}).strict().parse(request.body ?? {})
    return claimJob(pool, {...identity,repositories:body.repositories,automationCapabilities:body.automationCapabilities})
  })

  app.post('/api/v1/runners/runs/:runId/lease', async (request) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    const params = z.object({ runId: opaqueIdSchema }).parse(request.params)
    const body = z.object({ leaseId: opaqueIdSchema }).strict().parse(request.body)
    return renewLease(pool, { ...identity, ...params, ...body })
  })

  app.post('/api/v1/runners/runs/:runId/events', async (request, reply) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    const params = z.object({ runId: opaqueIdSchema }).parse(request.params)
    const body = z.object({
      leaseId: opaqueIdSchema, eventId: z.string().min(1).max(191), type: z.string().min(1).max(160),
      data: z.record(z.string(), z.unknown()).default({}),
    }).strict().parse(request.body)
    await appendExecutionEvent(pool, { ...identity, ...params, ...body })
    return reply.status(204).send()
  })

  app.post('/api/v1/runners/runs/:runId/complete', async (request) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    const params = z.object({ runId: opaqueIdSchema }).parse(request.params)
    const body = z.object({
      leaseId: opaqueIdSchema,
      completion: z.object({
        state: z.enum(['succeeded', 'failed', 'cancelled', 'needs_input']),
        estimatedCostUsd:z.number().nonnegative().optional(),
        summary: z.string().max(100_000).optional(), failure: z.string().max(100_000).optional(), question: z.string().max(100_000).optional(),
        artifacts: z.array(z.object({
          kind: z.enum(['summary', 'patch', 'commit', 'log', 'verification', 'attachment', 'orphaned_evidence']),
          name: z.string().min(1).max(500), contentType: z.string().min(1).max(200), sizeBytes: z.number().int().nonnegative(),
          digest: z.string().min(1).max(200), storageKey: z.string().min(1).max(1_000),
        })).max(100).optional(),
      }).strict(),
    }).strict().parse(request.body)
    return completeRun(pool, { ...identity, ...params, ...body })
  })

  app.post('/api/v1/runners/runs/:runId/artifacts', async (request, reply) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    const params = z.object({ runId: opaqueIdSchema }).parse(request.params)
    const body = z.object({
      leaseId: opaqueIdSchema, kind: z.enum(['summary', 'patch', 'commit', 'log', 'verification', 'attachment']),
      name: z.string().min(1).max(500), contentType: z.string().min(1).max(200), contentBase64: z.string().max(14_000_000),
    }).strict().parse(request.body)
    if (body.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body.contentBase64)) throw Object.assign(new Error('Artifact content is not valid base64.'), { statusCode: 400 })
    const artifact = await uploadRunArtifact(pool, config.storageDirectory, {
      ...identity, ...params, leaseId: body.leaseId, kind: body.kind, name: body.name,
      contentType: body.contentType, bytes: Buffer.from(body.contentBase64, 'base64'),
    })
    return reply.status(201).send(artifact)
  })

  app.post('/api/v1/organizations/:organizationId/projects/:projectId/runners/:runnerId/revoke', async (request, reply) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema, runnerId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request, ['api:write'])
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    await revokeRunner(pool, { ...params, userId: human.userId })
    return reply.status(204).send()
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId/runners', async (request) => {
    const params = z.object({ organizationId: opaqueIdSchema, projectId: opaqueIdSchema }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    return listProjectRunners(pool, { ...params, userId: human.userId })
  })

  app.get('/api/v1/runners/runs/:runId/status', async (request) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    const params = z.object({ runId: opaqueIdSchema }).parse(request.params)
    const query = z.object({ leaseId: opaqueIdSchema }).parse(request.query)
    return inTenantTransaction(pool, { organizationId: identity.organizationId, actor: { type: 'runner', runnerId: identity.runnerId } }, async (client) => {
      const result = await client.query<{ state: string }>(`
        select state from runs where organization_id = $1 and runner_id = $2 and id = $3 and lease_id = $4
      `, [identity.organizationId, identity.runnerId, params.runId, query.leaseId])
      if (!result.rows[0]) throw Object.assign(new Error('Run not found.'), { statusCode: 404 })
      return result.rows[0]
    })
  })

  app.get('/api/v1/runners/status', async (request) => {
    const identity = runnerIdentity(request)
    if (!await verifyRunnerCredential(pool, identity)) throw Object.assign(new Error('Runner credential is invalid or revoked.'), { statusCode: 401 })
    return inTenantTransaction(pool, { organizationId: identity.organizationId, actor: { type: 'runner', runnerId: identity.runnerId } }, async (client) => {
      const result = await client.query<{ status: string; active_runs: number }>(`
        select r.status, count(run.id)::int as active_runs from runners r
        left join runs run on run.runner_id = r.id and run.state in ('claimed', 'running', 'cancelling')
        where r.organization_id = $1 and r.id = $2 group by r.id
      `, [identity.organizationId, identity.runnerId])
      const row = result.rows[0]
      if (!row) throw Object.assign(new Error('Runner not found.'), { statusCode: 404 })
      return { status: row.status, activeRuns: row.active_runs }
    })
  })

  app.post('/api/v1/runners/self/revoke', async (request, reply) => {
    const identity = runnerIdentity(request)
    await selfRevokeRunner(pool, identity)
    return reply.status(204).send()
  })
}
