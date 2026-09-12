import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chatInventorySchema,
  chatPartSchema,
  type ChatUpload,
  type ProjectChatClaim,
  type ProjectChatSession,
  type ProjectChatTurn,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { verifyRunnerCredential } from '../runners/service.js'
import { authorizeProject } from '../access/authorize.js'
import { chatFail, eligibleDestination, mapInteraction, mapMessage, mapSession, mapTurn } from './service.js'
import { appendChatEvent, sameJson } from './events.js'

export interface ChatRunnerIdentity {
  organizationId: string
  runnerId: string
  credential: string
}
export const tokenHash = (t: string) => createHash('sha256').update(t).digest()
export async function runnerTransaction<T>(
  pool: DatabasePool,
  identity: ChatRunnerIdentity,
  fn: (c: DatabaseClient) => Promise<T>
) {
  if (!(await verifyRunnerCredential(pool, identity))) chatFail('Runner credential is invalid or revoked.', 401)
  return inTenantTransaction(
    pool,
    { organizationId: identity.organizationId, actor: { type: 'runner', runnerId: identity.runnerId } },
    fn
  )
}
export async function assertChatLease(
  c: DatabaseClient,
  identity: ChatRunnerIdentity,
  turnId: string,
  leaseId: string,
  terminal = false
) {
  // Lock order everywhere: runner (claims only), session, turn, interaction.
  const found = (
    await c.query('select session_id from chat_turns where id=$1 and runner_id=$2', [turnId, identity.runnerId])
  ).rows[0]
  if (!found) chatFail('Chat turn not found.', 404)
  const s = mapSession(
    (await c.query('select * from chat_sessions where id=$1 for update', [found.session_id])).rows[0]
  )
  const row = (await c.query('select * from chat_turns where id=$1 for update', [turnId])).rows[0],
    t = mapTurn(row)
  if (t.leaseId !== leaseId) chatFail('The chat lease is no longer valid.')
  if (terminal && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.state))
    return { session: s, turn: t, row }
  if (
    !['running', 'waiting_input', 'cancelling'].includes(t.state) ||
    !t.leaseExpiresAt ||
    Date.parse(t.leaseExpiresAt) <= Date.now()
  )
    chatFail('The chat lease expired.')
  await authorizeProject(c, s.organizationId, s.projectId, s.ownerUserId, 'execution:request')
  await eligibleDestination(c, { organizationId: s.organizationId, projectId: s.projectId, userId: s.ownerUserId }, s)
  return { session: s, turn: t, row }
}
export async function claimChat(pool: DatabasePool, identity: ChatRunnerIdentity): Promise<ProjectChatClaim | null> {
  return runnerTransaction(pool, identity, async (c) => {
    const runner = (
      await c.query("select * from runners where id=$1 and status<>'revoked' for update", [identity.runnerId])
    ).rows[0]
    if (!runner || (runner.owner_user_id && !runner.personal_enabled)) return null
    const inv = chatInventorySchema.safeParse(runner.chat_capabilities)
    if (!inv.success || !inv.data.enabled) return null
    const active = (
      await c.query(
        `select (select count(*) from runs where runner_id=$1 and state in ('claimed','running','cancelling'))+
      (select count(*) from chat_turns where runner_id=$1 and state in ('running','waiting_input','cancelling')) as count`,
        [identity.runnerId]
      )
    ).rows[0]
    if (Number(active.count) >= Number(runner.max_concurrency)) return null
    const srow = (
      await c.query(
        `select s.* from chat_sessions s where s.runner_id=$1 and s.archived_at is null
      and exists(select 1 from chat_turns t where t.session_id=s.id and t.state='queued')
      order by s.updated_at,s.id for update skip locked limit 1`,
        [identity.runnerId]
      )
    ).rows[0]
    if (!srow) return null
    const session = mapSession(srow)
    const row = (
      await c.query("select * from chat_turns where session_id=$1 and state='queued' for update", [session.id])
    ).rows[0]
    if (!row) return null
    try {
      await authorizeProject(c, session.organizationId, session.projectId, session.ownerUserId, 'execution:request')
      await eligibleDestination(
        c,
        { organizationId: session.organizationId, projectId: session.projectId, userId: session.ownerUserId },
        session
      )
    } catch {
      await finishChat(c, session, mapTurn(row), 'failed', 'Executor or project access is no longer available.')
      return null
    }
    const leaseId = randomUUID(),
      token = randomBytes(32).toString('base64url')
    const turn = mapTurn(
      (
        await c.query(
          "update chat_turns set state='running',lease_id=$2,lease_expires_at=now()+interval '60 seconds',attempt=attempt+1 where id=$1 returning *",
          [row.id, leaseId]
        )
      ).rows[0]
    )
    await c.query(
      "insert into chat_turn_tokens(organization_id,project_id,session_id,turn_id,token_hash,lease_id,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '60 seconds')",
      [session.organizationId, session.projectId, session.id, turn.id, tokenHash(token), leaseId]
    )
    await appendChatEvent(c, session, { type: 'turn', turn }, 'claimed-' + turn.id, turn.id)
    const message = mapMessage((await c.query('select * from chat_messages where id=$1', [turn.messageId])).rows[0])
    return { session, turn, message, token, ...(row.continuation ? { decision: row.continuation } : {}) }
  })
}
export async function finishChat(
  c: DatabaseClient,
  s: ProjectChatSession,
  t: ProjectChatTurn,
  state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
  error: string | null = null
) {
  const turn = mapTurn(
    (
      await c.query('update chat_turns set state=$2,error=$3,completed_at=now() where id=$1 returning *', [
        t.id,
        state,
        error,
      ])
    ).rows[0]
  )
  await c.query('update chat_turn_tokens set revoked_at=now() where turn_id=$1', [t.id])
  const pending = await c.query(
    "update chat_interactions set state='expired' where turn_id=$1 and state='pending' and ($2<>'succeeded' or payload->>'type'<>'plan') returning *",
    [t.id, state]
  )
  for (const row of pending.rows)
    await appendChatEvent(c, s, { type: 'interaction', interaction: mapInteraction(row) }, 'expired-' + row.id, t.id)
  await appendChatEvent(c, s, { type: 'turn', turn }, 'finished-' + t.id, t.id)
  return turn
}
export async function uploadChatEvents(
  c: DatabaseClient,
  s: ProjectChatSession,
  t: ProjectChatTurn,
  events: ChatUpload[]
) {
  for (const event of events) {
    const p = event.payload
    const old = (
      await c.query('select payload from chat_events where session_id=$1 and event_id=$2', [s.id, event.eventId])
    ).rows[0]
    if (old) {
      if (!sameJson(old.payload, p)) chatFail('Event ID reused with different content.')
      continue
    }
    if (p.type === 'turn') chatFail('Turn state is controlled by the server.', 400)
    if (p.type === 'message') {
      if (p.message.sessionId !== s.id || p.message.turnId !== t.id || p.message.role !== 'assistant')
        chatFail('Message scope mismatch.', 403)
      const existing = (await c.query('select turn_id from chat_messages where id=$1', [p.message.id])).rows[0]
      if (existing && existing.turn_id !== t.id) chatFail('Message belongs to another turn.', 403)
      await c.query(
        `insert into chat_messages(id,organization_id,project_id,session_id,turn_id,role,parts,created_at) values($1,$2,$3,$4,$5,'assistant',$6,$7)
        on conflict(id) do update set parts=excluded.parts`,
        [p.message.id, s.organizationId, s.projectId, s.id, t.id, JSON.stringify(p.message.parts), p.message.createdAt]
      )
    } else if (p.type === 'delta' || p.type === 'tool') {
      const row = (
        await c.query(
          "select parts from chat_messages where id=$1 and session_id=$2 and turn_id=$3 and role='assistant'",
          [p.messageId, s.id, t.id]
        )
      ).rows[0]
      if (!row) chatFail('Message must start before its parts.', 400)
      const parts = chatPartSchema.array().parse(row.parts)
      if (p.type === 'tool') {
        const index = parts.findIndex((x) => x.id === p.part.id)
        if (index >= 0) parts[index] = p.part
        else parts.push(p.part)
      } else {
        const index = parts.findIndex((x) => x.id === p.partId),
          oldPart = parts[index]
        if (oldPart && oldPart.type !== p.kind) chatFail('Message part type changed.', 400)
        const part = { id: p.partId, type: p.kind, text: (oldPart?.text ?? '') + p.delta }
        if (part.text.length > 1_000_000) chatFail('Chat message limit reached.', 413)
        if (index >= 0) parts[index] = part
        else parts.push(part)
      }
      if (parts.length > 1000) chatFail('Chat message part limit reached.', 413)
      await c.query('update chat_messages set parts=$2 where id=$1', [p.messageId, JSON.stringify(parts)])
    } else if (p.type === 'interaction') {
      const i = p.interaction
      if (i.sessionId !== s.id || i.turnId !== t.id || i.state !== 'pending' || i.decision !== null)
        chatFail('Interaction scope mismatch.', 403)
      const oldInteraction = (await c.query('select * from chat_interactions where id=$1', [i.id])).rows[0]
      if (oldInteraction) {
        if (
          oldInteraction.turn_id !== t.id ||
          oldInteraction.state !== 'pending' ||
          oldInteraction.version >= i.version
        )
          chatFail('Interaction version conflict.')
      }
      await c.query(
        `insert into chat_interactions(id,organization_id,project_id,session_id,turn_id,version,payload) values($1,$2,$3,$4,$5,$6,$7)
        on conflict(id) do update set version=excluded.version,payload=excluded.payload`,
        [i.id, s.organizationId, s.projectId, s.id, t.id, i.version, i.payload]
      )
    }
    await appendChatEvent(c, s, p, event.eventId, t.id)
  }
  const pending = await c.query(
    "select id from chat_interactions where turn_id=$1 and state='pending' and payload->>'type'<>'plan'",
    [t.id]
  )
  const state = pending.rowCount ? 'waiting_input' : 'running'
  if (t.state !== 'cancelling' && state !== t.state) {
    const turn = mapTurn(
      (await c.query('update chat_turns set state=$2 where id=$1 returning *', [t.id, state])).rows[0]
    )
    await appendChatEvent(c, s, { type: 'turn', turn }, randomUUID(), t.id)
  }
}
export async function reconcileChat(pool: DatabasePool) {
  for (const org of (await pool.query('select id from organizations')).rows)
    await inTenantTransaction(
      pool,
      { organizationId: org.id, actor: { type: 'system', service: 'chat-reconcile' } },
      async (c) => {
        const sessions =
          await c.query(`select s.* from chat_sessions s where exists(select 1 from chat_turns t join runners r on r.id=t.runner_id where t.session_id=s.id
      and ((t.state in ('running','waiting_input','cancelling') and t.lease_expires_at<=now()) or (t.state in ('queued','running','waiting_input','cancelling') and (r.status='revoked' or (r.owner_user_id is not null and not r.personal_enabled))))) for update skip locked`)
        for (const row of sessions.rows) {
          const s = mapSession(row)
          for (const t of (
            await c.query(
              "select * from chat_turns where session_id=$1 and state in ('queued','running','waiting_input','cancelling') for update",
              [s.id]
            )
          ).rows)
            await finishChat(c, s, mapTurn(t), 'interrupted', 'Executor disconnected or its lease expired.')
        }
      }
    )
}
