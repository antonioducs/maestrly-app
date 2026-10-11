import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { chatInventorySchema, chatUploadSchema } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { assertChatLease, claimChat, finishChat, runnerTransaction, uploadChatEvents } from './dispatch.js'
import { chatFail, mapInteraction } from './service.js'
import { registerChatToolRoutes } from './tools.js'

export function chatRunnerIdentity(r: FastifyRequest) {
  return z
    .object({ organizationId: z.string().uuid(), runnerId: z.string().uuid(), credential: z.string().min(32) })
    .parse({
      organizationId: r.headers['x-maestrly-organization-id'],
      runnerId: r.headers['x-maestrly-runner-id'],
      credential: r.headers.authorization?.startsWith('Runner ') ? r.headers.authorization.slice(7) : undefined,
    })
}
export function registerChatRunnerRoutes(app: FastifyInstance, pool: DatabasePool) {
  registerChatToolRoutes(app, pool)
  const root = '/api/v1/runners/chat'
  // Authenticated machine event batches run more frequently than human API requests.
  const config = { rateLimit: { max: 1800, timeWindow: '1 minute' } }
  app.post(root + '/inventory', { config }, async (r) => {
    const identity = chatRunnerIdentity(r),
      inventory = chatInventorySchema.parse(r.body)
    return runnerTransaction(pool, identity, async (c) => {
      for (const w of inventory.workspaces)
        if (
          !(
            await c.query('select 1 from runner_project_bindings where runner_id=$1 and project_id=$2', [
              identity.runnerId,
              w.projectId,
            ])
          ).rowCount
        )
          chatFail('Workspace is outside this runner project scope.', 403)
      await c.query('update runners set chat_capabilities=$2,chat_seen_at=now(),last_seen_at=now() where id=$1', [
        identity.runnerId,
        inventory,
      ])
      return { ok: true }
    })
  })
  app.post(root + '/claim', { config }, async (r) => claimChat(pool, chatRunnerIdentity(r)))
  const location = (r: FastifyRequest) => z.object({ turnId: z.string().uuid() }).parse(r.params)
  app.post(root + '/turns/:turnId/lease', { config }, async (r) => {
    const identity = chatRunnerIdentity(r),
      { turnId } = location(r),
      { leaseId } = z.object({ leaseId: z.string().uuid() }).strict().parse(r.body)
    return runnerTransaction(pool, identity, async (c) => {
      const { turn } = await assertChatLease(c, identity, turnId, leaseId)
      const row = (
        await c.query(
          "update chat_turns set lease_expires_at=now()+interval '60 seconds' where id=$1 returning lease_expires_at",
          [turnId]
        )
      ).rows[0]
      await c.query('update chat_turn_tokens set expires_at=$2 where turn_id=$1 and revoked_at is null', [
        turnId,
        row.lease_expires_at,
      ])
      return { leaseExpiresAt: row.lease_expires_at.toISOString(), cancellationRequested: turn.state === 'cancelling' }
    })
  })
  app.get(root + '/turns/:turnId/controls', { config }, async (r) => {
    const identity = chatRunnerIdentity(r),
      { turnId } = location(r),
      { leaseId } = z.object({ leaseId: z.string().uuid() }).parse(r.query)
    return runnerTransaction(pool, identity, async (c) => {
      const { turn } = await assertChatLease(c, identity, turnId, leaseId)
      const rows = await c.query(
        "select * from chat_interactions where turn_id=$1 and state='decided' order by created_at",
        [turnId]
      )
      return { cancellationRequested: turn.state === 'cancelling', interactions: rows.rows.map(mapInteraction) }
    })
  })
  app.post(root + '/turns/:turnId/events', { config }, async (r) => {
    const identity = chatRunnerIdentity(r),
      { turnId } = location(r),
      body = z
        .object({ leaseId: z.string().uuid(), events: z.array(chatUploadSchema).min(1).max(100) })
        .strict()
        .parse(r.body)
    return runnerTransaction(pool, identity, async (c) => {
      const { session, turn } = await assertChatLease(c, identity, turnId, body.leaseId)
      await uploadChatEvents(c, session, turn, body.events)
      return { accepted: body.events.map((e) => e.eventId) }
    })
  })
  app.post(root + '/turns/:turnId/complete', { config }, async (r) => {
    const identity = chatRunnerIdentity(r),
      { turnId } = location(r),
      body = z
        .object({
          leaseId: z.string().uuid(),
          state: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']),
          error: z.string().max(8000).nullable().default(null),
        })
        .strict()
        .parse(r.body)
    return runnerTransaction(pool, identity, async (c) => {
      const { session, turn } = await assertChatLease(c, identity, turnId, body.leaseId, true)
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.state)) {
        if (turn.state !== body.state) chatFail('Completion conflicts with the recorded outcome.')
        return turn
      }
      return finishChat(c, session, turn, turn.state === 'cancelling' ? 'cancelled' : body.state, body.error)
    })
  })
}
