import { randomUUID } from 'node:crypto'
import {
  botSelectionSchema,
  type BotClaim,
  type BotCommand,
  type BotControls,
  type BotEventUpload,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import {
  BOT_LEASE_SECONDS,
  appendBotEvent,
  botFail,
  botTransaction,
  mapBotCommand,
  mapBotConnection,
  mapBotConversation,
  mapBotQuestion,
  readBotGrants,
  touchBotDesktop,
  type BotDesktopIdentity,
} from './service.js'

/**
 * Desktop side of the relay. The server never calls the desktop: the desktop claims one command at a
 * time, renews a lease while it works, streams durable events and reports a terminal outcome. Commands
 * of a conversation are strictly serial, and a lease carries a fence that invalidates a stale holder.
 */
const desktopActor = (identity: BotDesktopIdentity) =>
  ({ type: 'bot_desktop', userId: identity.ownerUserId, desktopId: identity.desktopId }) as const

export async function botDesktopTransaction<T>(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  operation: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  return botTransaction(pool, desktopActor(identity), operation)
}

function conversationScope(row: Record<string, any>) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    connectionId: row.connection_id,
    desktopId: row.desktop_id,
  }
}

export async function claimBotCommand(
  pool: DatabasePool,
  identity: BotDesktopIdentity
): Promise<BotClaim | null> {
  return botDesktopTransaction(pool, identity, async (client) => {
    await touchBotDesktop(client, identity.desktopId)
    // A lease that expired is reclaimable; its previous holder is fenced out by the new fence value.
    await client.query(
      "update bot_commands set status='queued',lease_token=null,lease_expires_at=null,version=version+1 where desktop_id=$1 and status='leased' and lease_expires_at<=now()",
      [identity.desktopId]
    )
    const found = await client.query(
      `select cm.* from bot_commands cm
         join bot_conversations cv on cv.id=cm.conversation_id
         join bot_connections cn on cn.id=cm.connection_id
         join bot_desktops d on d.id=cm.desktop_id
         join bot_connection_grants g on g.connection_id=cm.connection_id and g.workspace_id=cv.workspace_id
       where cm.desktop_id=$1 and cm.status='queued' and cv.management_state='active' and cn.revoked_at is null
         and d.revoked_at is null and d.inventory->>'enabled'='true'
         and g.actions ? (case cm.kind when 'answer' then 'chats:answer' when 'cancel' then 'chats:control' else 'chats:write' end)
         and not exists(select 1 from bot_commands other where other.conversation_id=cm.conversation_id and other.status='leased'
           and (other.kind in ('answer','cancel'))=(cm.kind in ('answer','cancel')))
         and (cm.kind in ('answer','cancel') or not exists(select 1 from bot_commands earlier
           where earlier.conversation_id=cm.conversation_id and earlier.status='queued'
           and earlier.kind not in ('answer','cancel') and earlier.sequence<cm.sequence))
         and (cm.kind<>'answer' or exists(select 1 from bot_questions q join bot_commands source on source.id=q.command_id
           where q.id::text=cm.payload->>'questionId' and q.conversation_id=cm.conversation_id and q.state='pending' and source.status='leased'))
       order by (cm.kind in ('answer','cancel')) desc, cm.created_at, cm.sequence
       for update of cm skip locked limit 1`,
      [identity.desktopId]
    )
    const row = found.rows[0]
    if (!row) return null
    const conversationRow = (
      await client.query('select * from bot_conversations where id=$1 for update', [row.conversation_id])
    ).rows[0]!
    const fence = Number(
      (
        await client.query<{ command_fence: string }>(
          'update bot_conversations set command_fence=command_fence+1,updated_at=now() where id=$1 returning command_fence',
          [conversationRow.id]
        )
      ).rows[0]!.command_fence
    )
    const leaseToken = randomUUID()
    const leased = (
      await client.query(
        `update bot_commands set status='leased',lease_token=$2,lease_expires_at=now()+($3 || ' seconds')::interval,
           fence=$4,attempt=attempt+1,version=version+1 where id=$1 returning *`,
        [row.id, leaseToken, String(BOT_LEASE_SECONDS), fence]
      )
    ).rows[0]!
    const command = mapBotCommand(leased)
    await appendBotEvent(
      client,
      conversationScope(conversationRow),
      { type: 'command', command },
      'command-leased-' + command.id + '-' + leased.attempt,
      command.id
    )
    const connectionRow = (await client.query('select * from bot_connections where id=$1', [row.connection_id])).rows[0]!
    return {
      owner: { userId: identity.ownerUserId },
      connection: mapBotConnection(connectionRow, await readBotGrants(client, connectionRow.id)),
      conversation: mapBotConversation(conversationRow),
      command: mapBotCommand(leased, true),
      leaseExpiresAt: leased.lease_expires_at.toISOString(),
      fence,
    } satisfies BotClaim
  })
}

export interface BotLeaseHold {
  command: Record<string, any>
  conversation: Record<string, any>
}

/** Every desktop write revalidates the lease token, the fence, the expiry and the live authorization. */
export async function assertBotLease(
  client: DatabaseClient,
  identity: BotDesktopIdentity,
  input: { commandId: string; leaseToken: string; fence: number },
  terminal = false
): Promise<BotLeaseHold> {
  const located = await client.query('select conversation_id from bot_commands where id=$1 and desktop_id=$2', [
    input.commandId,
    identity.desktopId,
  ])
  if (!located.rowCount) botFail('Command not found.', 404)
  // Lock order everywhere: conversation, then command.
  const conversation = (
    await client.query('select * from bot_conversations where id=$1 for update', [located.rows[0]!.conversation_id])
  ).rows[0]!
  const command = (await client.query('select * from bot_commands where id=$1 for update', [input.commandId])).rows[0]!
  const connection = (
    await client.query('select revoked_at from bot_connections where id=$1', [command.connection_id])
  ).rows[0]
  if (!connection || connection.revoked_at) botFail('The bot connection was revoked.', 403)
  if (command.lease_token !== input.leaseToken || Number(command.fence) !== input.fence)
    botFail('The command lease is no longer valid.')
  const grant = await client.query(`select 1 from bot_connection_grants g join bot_desktops d on d.id=g.desktop_id
    where g.connection_id=$1 and g.workspace_id=$2 and d.revoked_at is null
    and g.actions ? $3`, [command.connection_id, conversation.workspace_id,
      command.kind === 'answer' ? 'chats:answer' : command.kind === 'cancel' ? 'chats:control' : 'chats:write'])
  if (!grant.rowCount) botFail('The bot workspace grant was revoked.', 403)
  if (terminal && ['succeeded', 'failed', 'cancelled'].includes(command.status)) return { command, conversation }
  if (command.status !== 'leased' || command.lease_expires_at.getTime() <= Date.now())
    botFail('The command lease expired.')
  return { command, conversation }
}

async function controlsFor(client: DatabaseClient, hold: BotLeaseHold): Promise<BotControls> {
  const cancelling = await client.query(
    "select 1 from bot_commands where conversation_id=$1 and kind='cancel' and status in ('queued','leased') and id<>$2",
    [hold.conversation.id, hold.command.id]
  )
  return {
    cancellationRequested: Boolean(cancelling.rowCount) || hold.conversation.management_state === 'revoked',
    managementState: hold.conversation.management_state,
    leaseExpiresAt: hold.command.lease_expires_at.toISOString(),
  }
}

export async function renewBotLease(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  input: { commandId: string; leaseToken: string; fence: number }
): Promise<BotControls> {
  return botDesktopTransaction(pool, identity, async (client) => {
    const hold = await assertBotLease(client, identity, input)
    await touchBotDesktop(client, identity.desktopId)
    const renewed = (
      await client.query(
        "update bot_commands set lease_expires_at=now()+($2 || ' seconds')::interval where id=$1 returning *",
        [input.commandId, String(BOT_LEASE_SECONDS)]
      )
    ).rows[0]!
    return controlsFor(client, { command: renewed, conversation: hold.conversation })
  })
}

export async function readBotControls(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  input: { commandId: string; leaseToken: string; fence: number }
): Promise<BotControls> {
  return botDesktopTransaction(pool, identity, async (client) =>
    controlsFor(client, await assertBotLease(client, identity, input))
  )
}

/**
 * Durable event upload. Event ids are idempotent per conversation: the same id with the same payload is
 * accepted and ignored, a different payload for that id is refused, and server-owned payload kinds are
 * never accepted from a desktop.
 */
export async function uploadBotEvents(
  client: DatabaseClient,
  hold: BotLeaseHold,
  events: BotEventUpload[]
): Promise<string[]> {
  const scope = conversationScope(hold.conversation)
  for (const event of events) {
    const payload = event.payload
    const existing = await client.query<{ same: boolean }>(
      'select payload = $3::jsonb as same from bot_conversation_events where conversation_id=$1 and event_id=$2',
      [scope.id, event.eventId, JSON.stringify(payload)]
    )
    if (existing.rowCount) {
      if (!existing.rows[0]!.same) botFail('Event id reused with different content.')
      continue
    }
    if (payload.type === 'command' || payload.type === 'conversation')
      botFail('Command and conversation state are controlled by the server.', 400)
    if (payload.type === 'message') {
      const message = payload.message
      if (message.conversationId !== scope.id || message.commandId !== hold.command.id || message.role !== 'assistant')
        botFail('Message scope mismatch.', 403)
      await client.query(
        `insert into bot_messages(id,owner_user_id,connection_id,desktop_id,conversation_id,command_id,role,parts,created_at)
         values($1,$2,$3,$4,$5,$6,'assistant',$7,$8) on conflict(id) do update set parts=excluded.parts`,
        [
          message.id,
          scope.ownerUserId,
          scope.connectionId,
          scope.desktopId,
          scope.id,
          hold.command.id,
          JSON.stringify(message.parts),
          message.createdAt,
        ]
      )
    } else if (payload.type === 'delta' || payload.type === 'tool') {
      const row = (
        await client.query('select parts from bot_messages where id=$1 and conversation_id=$2 and command_id=$3', [
          payload.messageId,
          scope.id,
          hold.command.id,
        ])
      ).rows[0]
      if (!row) botFail('A message must start before its parts.', 400)
      const parts = row.parts as Array<Record<string, any>>
      if (payload.type === 'tool') {
        const index = parts.findIndex((part) => part.id === payload.part.id)
        if (index >= 0) parts[index] = payload.part
        else parts.push(payload.part)
      } else {
        const index = parts.findIndex((part) => part.id === payload.partId)
        const previous = parts[index]
        if (previous && previous.type !== payload.kind) botFail('Message part type changed.', 400)
        const part = {
          id: payload.partId,
          type: payload.kind,
          text: ((previous?.text as string) ?? '') + payload.delta,
        }
        if (part.text.length > 1_000_000) botFail('Message size limit reached.', 413)
        if (index >= 0) parts[index] = part
        else parts.push(part)
      }
      if (parts.length > 1000) botFail('Message part limit reached.', 413)
      await client.query('update bot_messages set parts=$2 where id=$1', [payload.messageId, JSON.stringify(parts)])
    } else if (payload.type === 'question') {
      const question = payload.question
      if (question.conversationId !== scope.id || question.commandId !== hold.command.id)
        botFail('Question scope mismatch.', 403)
      await client.query(
        `insert into bot_questions(id,owner_user_id,connection_id,desktop_id,conversation_id,command_id,questions,state,answers,created_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict(id) do update set questions=excluded.questions,state=excluded.state,answers=excluded.answers`,
        [
          question.id,
          scope.ownerUserId,
          scope.connectionId,
          scope.desktopId,
          scope.id,
          hold.command.id,
          JSON.stringify(question.questions),
          question.state,
          question.answers ? JSON.stringify(question.answers) : null,
          question.createdAt,
        ]
      )
    }
    await appendBotEvent(client, scope, payload, event.eventId, hold.command.id)
  }
  return events.map((event) => event.eventId)
}

export async function completeBotCommand(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  input: {
    commandId: string
    leaseToken: string
    fence: number
    status: 'succeeded' | 'failed' | 'cancelled'
    error: string | null
  }
): Promise<BotCommand> {
  return botDesktopTransaction(pool, identity, async (client) => {
    const hold = await assertBotLease(client, identity, input, true)
    const scope = conversationScope(hold.conversation)
    if (['succeeded', 'failed', 'cancelled'].includes(hold.command.status)) {
      // Retrying the same completion replays it; a different outcome is a conflict.
      if (hold.command.status !== input.status || hold.command.error !== input.error) botFail('Completion conflicts with the recorded outcome.')
      return mapBotCommand(hold.command)
    }
    const finished = (
      await client.query(
        'update bot_commands set status=$2,error=$3,completed_at=now(),version=version+1 where id=$1 returning *',
        [input.commandId, input.status, input.error]
      )
    ).rows[0]!
    if (input.status === 'succeeded' && hold.command.kind === 'answer') {
      const questionId = (hold.command.payload as { questionId: string }).questionId
      const answers = (hold.command.payload as { answers: unknown }).answers
      const answered = (
        await client.query(
          "update bot_questions set state='answered',answers=$2 where id=$1 and conversation_id=$3 returning *",
          [questionId, JSON.stringify(answers), scope.id]
        )
      ).rows[0]
      if (answered)
        await appendBotEvent(
          client,
          scope,
          { type: 'question', question: mapBotQuestion(answered) },
          'question-answered-' + questionId,
          finished.id
        )
    }
    if (input.status === 'succeeded' && hold.command.kind === 'configure') {
      const payload = hold.command.payload as { selection?: Record<string, unknown>; name?: string }
      const selection = payload.selection
        ? botSelectionSchema.parse({ ...(hold.conversation.selection as object), ...payload.selection })
        : null
      const updated = (
        await client.query(
          'update bot_conversations set selection=coalesce($2,selection),name=coalesce($3,name),version=version+1,updated_at=now() where id=$1 returning *',
          [scope.id, selection ? JSON.stringify(selection) : null, payload.name ?? null]
        )
      ).rows[0]!
      await appendBotEvent(
        client,
        scope,
        { type: 'conversation', conversation: mapBotConversation(updated) },
        'configured-' + finished.id,
        finished.id
      )
    }
    // A failed first model turn may already have a durable native conversation/worktree. Preserve its
    // identity: the owner can inspect it and the bot can issue a new instruction in that same chat.
    if (input.status !== 'succeeded') {
      const expired = await client.query(
        "update bot_questions set state='expired' where command_id=$1 and state='pending' returning *",
        [finished.id]
      )
      for (const row of expired.rows)
        await appendBotEvent(
          client,
          scope,
          { type: 'question', question: mapBotQuestion(row) },
          'question-expired-' + row.id,
          finished.id
        )
    }
    const command = mapBotCommand(finished)
    await appendBotEvent(
      client,
      scope,
      { type: 'command', command },
      'command-finished-' + finished.id + '-' + finished.attempt,
      finished.id
    )
    return command
  })
}

export async function uploadBotEventBatch(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  input: { commandId: string; leaseToken: string; fence: number; events: BotEventUpload[] }
): Promise<{ accepted: string[] }> {
  return botDesktopTransaction(pool, identity, async (client) => {
    const hold = await assertBotLease(client, identity, input)
    await touchBotDesktop(client, identity.desktopId)
    return { accepted: await uploadBotEvents(client, hold, input.events) }
  })
}
