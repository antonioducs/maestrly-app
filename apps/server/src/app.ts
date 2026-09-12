import { configureDesktopClientResource,DESKTOP_CLIENT_ID } from './modules/auth/desktop-client.js'
import { registerProjectChatRoutes } from './modules/project-chat/routes.js'
import { registerChatRunnerRoutes } from './modules/project-chat/runner-routes.js'
import { registerPersonalDeviceRoutes } from './modules/runners/personal-routes.js'
import { registerTeamRoutes } from './modules/access/team-routes.js'
import { registerColumnAutomationRoutes } from './modules/automation/column-routes.js'
import { registerKanbanRoutes } from './modules/kanban/routes.js'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import {
  PROTOCOL_VERSION,
  supportsProtocol,
  type ApiError,
  type InstanceMetadata,
} from '@maestrly/protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError, z } from 'zod'
import type { ServerConfig } from './config.js'
import type { DatabasePool } from './db/pool.js'
import { AuthorizationError } from './modules/access/authorize.js'
import { registerAgentToolRoutes } from './modules/agent-tools/routes.js'
import { createHumanAuthenticator, registerAuthRoutes } from './modules/auth/routes.js'
import type { MaestrlyAuth } from './modules/auth/auth.js'
import { registerAutomationRoutes } from './modules/automation/routes.js'
import { registerBoardRoutes } from './modules/boards/routes.js'
import { OptimisticConflictError } from './modules/cards/service.js'
import { registerCardRoutes } from './modules/cards/routes.js'
import { IdempotencyConflictError } from './modules/events/idempotency.js'
import { listDomainEvents } from './modules/events/store.js'
import { registerRunnerRoutes } from './modules/runners/routes.js'
import { getProject } from './modules/projects/service.js'
import { inTenantTransaction } from './db/transaction.js'
import { authorizeProject } from './modules/access/authorize.js'
import { registerAccessRoutes } from './modules/access/routes.js'

export interface AppDependencies {
  config: ServerConfig
  pool: DatabasePool
  auth: MaestrlyAuth
}

function safeError(requestId: string, code: ApiError['code'], message: string, details?: Record<string, unknown>): ApiError {
  return { code, message, requestId, ...(details ? { details } : {}) }
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, pool, auth } = dependencies
  await configureDesktopClientResource(pool,config.canonicalUrl)
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 16 * 1024 * 1024,
  })

  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'last-event-id', 'x-maestrly-protocol-version', 'x-maestrly-organization-id', 'x-maestrly-runner-id', 'x-maestrly-client-actor', 'x-maestrly-conversation-id'],
  })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))))
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.url === '/api/v1/meta' || request.url.startsWith('/api/v1/health/')) return
    const url = new URL(request.url, 'http://local')
    const eventStreamVersion = request.method === 'GET' && (url.pathname.endsWith('/events') || url.pathname.endsWith('/download'))
      ? url.searchParams.get('protocolVersion') ?? undefined
      : undefined
    const version = request.headers['x-maestrly-protocol-version'] ?? eventStreamVersion
    if (typeof version !== 'string' || !supportsProtocol(version)) {
      return reply.status(426).send(safeError(request.id, 'PROTOCOL_INCOMPATIBLE', 'A supported Maestrly protocol version is required.', {
        supported: [PROTOCOL_VERSION], requested: version ?? null,
      }))
    }
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('cache-control', 'no-store')
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send(safeError(request.id, 'BAD_REQUEST', 'Request validation failed.', {
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      }))
    }
    if (error instanceof OptimisticConflictError) {
      return reply.status(409).send(safeError(request.id, 'CONFLICT', error.message, { current: error.current }))
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.status(409).send(safeError(request.id, 'IDEMPOTENCY_CONFLICT', error.message))
    }
    if (error instanceof AuthorizationError) {
      return reply.status(403).send(safeError(request.id, 'FORBIDDEN', error.message))
    }
    if(error instanceof Error && error.message==='Rendered prompt is too long.')return reply.status(400).send(safeError(request.id,'BAD_REQUEST',error.message))
    const candidateStatus = (error as { statusCode?: unknown }).statusCode
    const status = typeof candidateStatus === 'number' ? candidateStatus : 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    const code: ApiError['code'] = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL'
    const message = status >= 500 ? 'The server could not complete the request.' : error instanceof Error ? error.message : 'Request failed.'
    return reply.status(status).send(safeError(request.id, code, message))
  })
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(safeError(request.id, 'NOT_FOUND', 'Route not found.'))
  })

  app.get('/api/v1/meta', async (): Promise<InstanceMetadata> => ({
    instanceId: config.instanceId,
    name: config.instanceName,
    canonicalUrl: config.canonicalUrl,
    apiVersion: 'v1',
    protocolVersions: [PROTOCOL_VERSION],
    authentication: { localAccounts: true, publicSignup: config.publicSignup, deviceAuthorization: true, desktopClientId: DESKTOP_CLIENT_ID },
  }))
  app.get('/api/v1/health/live', async () => ({ status: 'alive' }))
  app.get('/api/v1/health/ready', async (_request, reply) => {
    try {
      const result = await pool.query<{ count: string }>(`
        select count(*)::text as count from schema_migrations where name in ('000_better_auth.sql', '001_platform.sql', '002_actor_context.sql', '003_kanban_workflows.sql', '004_column_automation.sql', '005_project_team.sql', '006_personal_devices.sql', '007_desktop_executor.sql','008_project_chat.sql')
      `)
      if (Number(result.rows[0]?.count) !== 9) return reply.status(503).send({ status: 'not_ready', reason: 'schema_incompatible' })
      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'not_ready', reason: 'database_unavailable' })
    }
  })

  registerAuthRoutes(app, auth, config)
  const authenticate = createHumanAuthenticator(auth, config)
  registerProjectChatRoutes(app,pool,authenticate)
  registerChatRunnerRoutes(app,pool)
  registerBoardRoutes(app, pool, authenticate)
  registerCardRoutes(app, pool, authenticate, config)
  registerKanbanRoutes(app, pool, authenticate)
  registerAutomationRoutes(app, pool, authenticate)
  registerColumnAutomationRoutes(app,pool,authenticate)
  registerRunnerRoutes(app, pool, authenticate, config)
  registerPersonalDeviceRoutes(app,pool,authenticate)
  registerAgentToolRoutes(app, pool)
  registerAccessRoutes(app, pool, config, authenticate)
  registerTeamRoutes(app,pool,config,authenticate)

  app.get('/api/v1/organizations', async (request) => {
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('app.user_id', $1, true)", [human.userId])
      const result = await client.query(`
        select o.id, o.name, om.role from organizations o join organization_members om on om.organization_id = o.id
        where om.user_id = $1 order by o.name
      `, [human.userId])
      await client.query('commit')
      return result.rows
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId/events', async (request, reply) => {
    const params = z.object({ organizationId: z.string(), projectId: z.string() }).parse(request.params)
    const query = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) }).parse(request.query)
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    await getProject(pool, params.organizationId, params.projectId, human.userId)
    let cursor = Math.max(query.cursor, Number(request.headers['last-event-id'] ?? 0) || 0)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    request.raw.once('close', () => { closed = true })
    while (!closed) {
      let events: Awaited<ReturnType<typeof listDomainEvents>>
      try { events = await listDomainEvents(pool, { ...params, cursor, actor: { type: 'human', userId: human.userId } }) }
      catch(error) {
        if(error instanceof AuthorizationError)reply.raw.write('event: access_revoked\ndata: {}\n\n')
        reply.raw.end();break
      }

      if (events.length === 0) {
        reply.raw.write(': keep-alive\n\n')
      } else {
        for (const event of events) {
          cursor = event.sequence
          reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId/reports/summary', async (request) => {
    const params = z.object({ organizationId: z.string(), projectId: z.string() }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    await getProject(pool, params.organizationId, params.projectId, human.userId)
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('app.organization_id', $1, true)", [params.organizationId])
      await client.query("select set_config('app.user_id', $1, true)", [human.userId])
      const [cards, jobs, runs] = await Promise.all([
        client.query('select column_id, count(*)::int as count, max(extract(epoch from now() - created_at))::bigint as oldest_seconds from cards where organization_id = $1 and project_id = $2 and archived_at is null group by column_id', [params.organizationId, params.projectId]),
        client.query('select state, count(*)::int as count, avg(extract(epoch from now() - created_at))::bigint as average_wait_seconds from jobs where organization_id = $1 and project_id = $2 group by state', [params.organizationId, params.projectId]),
        client.query('select state, count(*)::int as count, avg(extract(epoch from finished_at - started_at))::bigint as average_duration_seconds from runs where organization_id = $1 and project_id = $2 group by state', [params.organizationId, params.projectId]),
      ])
      await client.query('commit')
      return { cards: cards.rows, jobs: jobs.rows, runs: runs.rows, cost: { status: 'unavailable' } }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/api/v1/organizations/:organizationId/projects/:projectId/executions', async (request) => {
    const params = z.object({ organizationId: z.string(), projectId: z.string() }).parse(request.params)
    const human = await authenticate(request)
    if (!human) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
    return inTenantTransaction(pool, { ...params, actor: { type: 'human', userId: human.userId } }, async (client) => {
      await authorizeProject(client, params.organizationId, params.projectId, human.userId, 'project:read')
      const result = await client.query(`
        select j.id, j.card_id as "cardId", c.title as "cardTitle", j.state as "jobState", r.state as "runState",
          a.id as "approvalId", a.status as "approvalStatus", i.id as "informationRequestId",
          i.question as "informationQuestion", j.created_at as "createdAt"
        from jobs j join cards c on c.id = j.card_id
        left join lateral (select state from runs where job_id = j.id order by attempt desc limit 1) r on true
        left join lateral (select id, status from approvals where job_id = j.id order by created_at desc limit 1) a on true
        left join lateral (select id, question from information_requests where job_id = j.id and response is null order by requested_at desc limit 1) i on true
        where j.organization_id = $1 and j.project_id = $2 order by j.created_at desc limit 200
      `, [params.organizationId, params.projectId])
      return result.rows
    })
  })

  return app
}
