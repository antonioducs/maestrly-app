import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { chatCreateSchema, chatDecisionSchema, chatUpdateSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { HumanIdentity } from '../auth/routes.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import {
  chatTransaction,
  chatFail,
  createSession,
  destinations,
  eligibleDestination,
  enqueueMessage,
  listSessions,
  mapMessage,
  mapTurn,
  ownedSession,
  snapshot,
  updateSession,
  type ChatScope,
} from './service.js'
import { appendChatEvent, listChatEvents } from './events.js'
import { decideInteraction } from './interactions.js'
import { finishChat } from './dispatch.js'

type Auth = (r: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>
const params = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  interactionId: z.string().uuid().optional(),
})
export function registerProjectChatRoutes(app: FastifyInstance, pool: DatabasePool, authenticate: Auth) {
  const root = '/api/v1/organizations/:organizationId/projects/:projectId/chat'
  async function scope(request: FastifyRequest, write = false) {
    const human = await authenticate(request, write ? ['api:write'] : undefined)
    if (!human) chatFail('Authentication required.', 401)
    return { ...params.parse(request.params), userId: human.userId }
  }
  async function mutate<T>(request: FastifyRequest, s: ChatScope, body: unknown, fn: () => Promise<T>) {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !key || key.length > 191)
      chatFail('A valid Idempotency-Key header is required.', 400)
    return chatTransaction(pool, s, true, async () => {
      const result = await executeIdempotent(
        pool,
        {
          organizationId: s.organizationId,
          actorId: s.userId,
          actor: { type: 'human', userId: s.userId },
          key,
          method: request.method,
          path: request.url,
          body,
        },
        async () => ({ status: 200, body: await fn() })
      )
      return result.body
    })
  }
  app.get(root + '/destinations', async (r) => destinations(pool, await scope(r)))
  app.get(root + '/sessions', async (r) =>
    listSessions(
      pool,
      await scope(r),
      z.object({ before: z.string().uuid().or(z.literal('')).default('') }).parse(r.query).before
    )
  )
  app.post(root + '/sessions', async (r) => {
    const s = await scope(r, true),
      body = chatCreateSchema.parse(r.body)
    return mutate(r, s, body, () => createSession(pool, s, body))
  })
  app.get(root + '/sessions/:sessionId', async (r) => {
    const s = await scope(r)
    return snapshot(pool, s, s.sessionId!)
  })
  app.patch(root + '/sessions/:sessionId', async (r) => {
    const s = await scope(r, true),
      body = chatUpdateSchema.parse(r.body)
    return mutate(r, s, body, () => chatTransaction(pool, s, true, (c) => updateSession(c, s, s.sessionId!, body)))
  })
  app.get(root + '/sessions/:sessionId/messages', async (r) => {
    const s = await scope(r),
      before = z.object({ before: z.string().uuid() }).parse(r.query).before
    return chatTransaction(pool, s, false, async (c) => {
      await ownedSession(c, s, s.sessionId!)
      const rows = await c.query(
        `select * from chat_messages where session_id=$1 and (created_at,id)<(select created_at,id from chat_messages where session_id=$1 and id=$2) order by created_at desc,id desc limit 101`,
        [s.sessionId, before]
      )
      return { items: rows.rows.slice(0, 100).reverse().map(mapMessage), more: rows.rows.length > 100 }
    })
  })
  app.post(root + '/sessions/:sessionId/messages', async (r) => {
    const s = await scope(r, true),
      body = z
        .object({ text: z.string().trim().min(1).max(100000), clientMessageId: z.string().uuid() })
        .strict()
        .parse(r.body)
    return chatTransaction(pool, s, true, async (c) => {
      const session = await ownedSession(c, s, s.sessionId!, true)
      await eligibleDestination(c, s, session)
      return mutate(r, s, body, () => enqueueMessage(c, session, body.text, body.clientMessageId))
    })
  })
  app.post(root + '/sessions/:sessionId/turns/:turnId/cancel', async (r) => {
    const s = await scope(r, true)
    return chatTransaction(pool, s, true, async (c) => {
      const session = await ownedSession(c, s, s.sessionId!, true)
      return mutate(r, s, {}, async () => {
        const row = (
          await c.query('select * from chat_turns where session_id=$1 and id=$2 for update', [session.id, s.turnId])
        ).rows[0]
        if (!row) chatFail('Turn not found.', 404)
        const turn = mapTurn(row)
        if (turn.state === 'queued') return finishChat(c, session, turn, 'cancelled')
        if (!['running', 'waiting_input'].includes(turn.state)) return turn
        const updated = mapTurn(
          (await c.query("update chat_turns set state='cancelling' where id=$1 returning *", [turn.id])).rows[0]
        )
        await appendChatEvent(c, session, { type: 'turn', turn: updated }, 'cancel-' + turn.id, turn.id)
        return updated
      })
    })
  })
  app.post(root + '/sessions/:sessionId/interactions/:interactionId/decisions', async (r) => {
    const s = await scope(r, true),
      body = z.object({ version: z.number().int().positive(), decision: chatDecisionSchema }).strict().parse(r.body)
    return chatTransaction(pool, s, true, async (c) => {
      const session = await ownedSession(c, s, s.sessionId!, true)
      return mutate(r, s, body, () => decideInteraction(c, session, s.interactionId!, body.version, body.decision))
    })
  })
  app.get(root + '/sessions/:sessionId/events', async (r, reply) => {
    const s = await scope(r),
      query = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) }).parse(r.query)
    let cursor = Math.max(query.cursor, Number(r.headers['last-event-id'] ?? 0) || 0)
    await chatTransaction(pool, s, false, (c) => ownedSession(c, s, s.sessionId!))
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    let closed = false,
      heartbeat = 0
    reply.raw.once('close', () => {
      closed = true
    })
    while (!closed) {
      try {
        const events = await listChatEvents(pool, s, s.sessionId!, cursor)
        for (const event of events) {
          if (closed) break
          cursor = event.sequence
          if (reply.raw.writableLength > 1024 * 1024) {
            reply.raw.end()
            closed = true
            break
          }
          reply.raw.write('id: ' + event.sequence + '\ndata: ' + JSON.stringify(event) + '\n\n')
        }
        if (Date.now() - heartbeat > 10000) {
          reply.raw.write(': keep-alive\n\n')
          heartbeat = Date.now()
        }
      } catch {
        reply.raw.end('event: access_revoked\ndata: {}\n\n')
        break
      }
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })
}
