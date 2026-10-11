import { randomUUID } from 'node:crypto'
import {
  chatInventorySchema,
  chatUpdateSchema,
  projectChatSessionSchema,
  projectChatMessageSchema,
  projectChatTurnSchema,
  projectChatInteractionSchema,
  type ChatCreate,
  type ChatInventory,
  type ChatUpdate,
  type ProjectChatSettings,
  type ProjectChatSession,
  type ProjectChatSnapshot,
  type ProjectChatDestination,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendChatEvent, sameJson } from './events.js'

export interface ChatScope {
  organizationId: string
  projectId: string
  userId: string
}
export function chatFail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode })
}
export function camel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v instanceof Date ? v.toISOString() : v,
    ])
  )
}
// Strip storage-only fields before validating the public projection.
export const mapSession = (r: Record<string, unknown>) =>
  projectChatSessionSchema.parse(
    Object.fromEntries(Object.entries(camel(r)).filter(([k]) => k in projectChatSessionSchema.shape))
  )
export const mapMessage = (r: Record<string, unknown>) =>
  projectChatMessageSchema.parse(
    Object.fromEntries(Object.entries(camel(r)).filter(([k]) => k in projectChatMessageSchema.shape))
  )
export const mapTurn = (r: Record<string, unknown>) =>
  projectChatTurnSchema.parse(
    Object.fromEntries(Object.entries(camel(r)).filter(([k]) => k in projectChatTurnSchema.shape))
  )
export const mapInteraction = (r: Record<string, unknown>) =>
  projectChatInteractionSchema.parse(
    Object.fromEntries(Object.entries(camel(r)).filter(([k]) => k in projectChatInteractionSchema.shape))
  )
export async function chatTransaction<T>(
  pool: DatabasePool,
  scope: ChatScope,
  write: boolean,
  fn: (c: DatabaseClient) => Promise<T>
) {
  return inTenantTransaction(pool, { ...scope, actor: { type: 'human', userId: scope.userId } }, async (c) => {
    await authorizeProject(
      c,
      scope.organizationId,
      scope.projectId,
      scope.userId,
      write ? 'execution:request' : 'project:read'
    )
    return fn(c)
  })
}
export async function ownedSession(c: DatabaseClient, s: ChatScope, id: string, lock = false) {
  const r = await c.query(
    'select * from chat_sessions where organization_id=$1 and project_id=$2 and owner_user_id=$3 and id=$4 ' +
      (lock ? 'for update' : 'for share'),
    [s.organizationId, s.projectId, s.userId, id]
  )
  if (!r.rows[0]) chatFail('Conversation not found.', 404)
  return mapSession(r.rows[0])
}
function normalizedMode(mode: ProjectChatSettings['mode']) {
  return mode === 'chat' ? 'ask' : mode
}
export function validateChatSettings(inventory: ChatInventory, input: ProjectChatSettings) {
  const model = inventory.models.find((candidate) => candidate.id === input.model)
  if (!model) chatFail('The selected model is unavailable.')
  const controls = inventory.conversationSettings
  if (!controls) {
    if (
      !['chat', 'agent'].includes(input.mode) ||
      input.reasoning !== null ||
      input.fastMode ||
      input.permMode !== 'ask'
    )
      chatFail('This executor does not support configurable chat settings.')
    return model
  }
  if (!controls.modes.includes(normalizedMode(input.mode))) chatFail('The selected chat mode is unavailable.')
  if (!controls.permissionModes.includes(input.permMode)) chatFail('The selected permission mode is unavailable.')
  if (input.reasoning !== null && !model.efforts.includes(input.reasoning))
    chatFail('The selected reasoning effort is unavailable for this model.')
  if (input.fastMode && !model.fastMode) chatFail('Fast mode is unavailable for this model.')
  return model
}
export async function eligibleDestination(c: DatabaseClient, s: ChatScope, input: ChatCreate | ProjectChatSession) {
  const rows = await c.query(
    `select r.* from runners r join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
    where r.id=$1 and r.organization_id=$2 and b.project_id=$3 and r.status<>'revoked'
      and (r.owner_user_id is null or (r.owner_user_id=$4 and r.personal_enabled))`,
    [input.runnerId, s.organizationId, s.projectId, s.userId]
  )
  const parsed = chatInventorySchema.safeParse(rows.rows[0]?.chat_capabilities)
  if (!parsed.success || !parsed.data.enabled) chatFail('This executor does not support interactive chat.', 409)
  const inv = parsed.data
  validateChatSettings(inv, input)
  if (
    !inv.workspaces.some(
      (w) => w.projectId === s.projectId && w.key === input.workspaceKey && w.branches.includes(input.baseBranch)
    )
  )
    chatFail('The selected workspace, branch or model is unavailable.')
  return inv
}
export async function destinations(pool: DatabasePool, scope: ChatScope): Promise<ProjectChatDestination[]> {
  return chatTransaction(pool, scope, true, async (c) => {
    const r = await c.query(
      `select r.*, (r.status='online' and r.last_seen_at>now()-interval '45 seconds') as online from runners r
      join runner_project_bindings b on b.runner_id=r.id and b.organization_id=r.organization_id
      where r.organization_id=$1 and b.project_id=$2 and r.status<>'revoked'
        and (r.owner_user_id is null or (r.owner_user_id=$3 and r.personal_enabled)) order by r.name,r.id`,
      [scope.organizationId, scope.projectId, scope.userId]
    )
    return r.rows.flatMap((row) => {
      const inventory = chatInventorySchema.safeParse(row.chat_capabilities)
      return inventory.success && inventory.data.enabled
        ? [
            {
              runnerId: row.id,
              name: row.name,
              online: row.online,
              personal: !!row.owner_user_id,
              inventory: {
                ...inventory.data,
                workspaces: inventory.data.workspaces.filter((w) => w.projectId === scope.projectId),
              },
            },
          ]
        : []
    })
  })
}
export async function createSession(pool: DatabasePool, s: ChatScope, input: ChatCreate) {
  input = {
    ...input,
    reasoning: input.reasoning ?? null,
    fastMode: input.fastMode === true,
    permMode: input.permMode ?? 'ask',
  }
  return chatTransaction(pool, s, true, async (c) => {
    await eligibleDestination(c, s, input)
    if (
      input.boardId &&
      !(
        await c.query(
          'select id from boards where organization_id=$1 and project_id=$2 and id=$3 and archived_at is null',
          [s.organizationId, s.projectId, input.boardId]
        )
      ).rowCount
    )
      chatFail('Board not found.', 404)
    if (input.cardId) {
      const card = (
        await c.query(
          'select board_id from cards where organization_id=$1 and project_id=$2 and id=$3 and ($4::uuid is null or board_id=$4) and deleted_at is null',
          [s.organizationId, s.projectId, input.cardId, input.boardId]
        )
      ).rows[0]
      if (!card) chatFail('Card not found.', 404)
      input = { ...input, boardId: card.board_id }
    }
    const r = await c.query(
      `insert into chat_sessions(organization_id,project_id,owner_user_id,runner_id,workspace_key,title,model,mode,reasoning,fast_mode,perm_mode,base_branch,board_id,card_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [
        s.organizationId,
        s.projectId,
        s.userId,
        input.runnerId,
        input.workspaceKey,
        input.title,
        input.model,
        input.mode,
        input.reasoning,
        input.fastMode,
        input.permMode,
        input.baseBranch,
        input.boardId,
        input.cardId,
      ]
    )
    return mapSession(r.rows[0])
  })
}
export async function updateSession(c: DatabaseClient, s: ChatScope, id: string, raw: ChatUpdate) {
  const input = chatUpdateSchema.parse(raw)
  const session = await ownedSession(c, s, id, true)
  if (session.version !== input.expectedVersion) chatFail('Conversation changed. Reload before saving.')
  const settingsChanged = ['model', 'mode', 'reasoning', 'fastMode', 'permMode'].some((key) =>
    Object.hasOwn(input, key)
  )
  const active =
    settingsChanged || input.archived
      ? await c.query(
          "select id from chat_turns where session_id=$1 and state in ('queued','running','waiting_input','cancelling')",
          [session.id]
        )
      : null
  if (active?.rowCount)
    chatFail(
      input.archived ? 'Stop the active turn before archiving.' : 'Stop the active turn before changing chat settings.'
    )
  const next: ProjectChatSettings = {
    model: input.model ?? session.model,
    mode: input.mode ?? session.mode,
    reasoning: input.reasoning === undefined ? session.reasoning : input.reasoning,
    fastMode: input.fastMode ?? session.fastMode,
    permMode: input.permMode ?? session.permMode,
  }
  if (settingsChanged) {
    await eligibleDestination(c, s, { ...session, ...next })
  }
  return mapSession(
    (
      await c.query(
        `update chat_sessions set title=coalesce($2,title),
          archived_at=case when $3::boolean is null then archived_at when $3 then now() else null end,
          model=$4,mode=$5,reasoning=$6,fast_mode=$7,perm_mode=$8,version=version+1,updated_at=now()
        where id=$1 returning *`,
        [
          session.id,
          input.title ?? null,
          input.archived ?? null,
          next.model,
          next.mode,
          next.reasoning,
          next.fastMode,
          next.permMode,
        ]
      )
    ).rows[0]
  )
}
export async function listSessions(pool: DatabasePool, s: ChatScope, before = '') {
  return chatTransaction(pool, s, false, async (c) => {
    const r = await c.query(
      `select * from chat_sessions where organization_id=$1 and project_id=$2 and owner_user_id=$3 and archived_at is null
      and ($4='' or (created_at,id)<(select created_at,id from chat_sessions where id=nullif($4,'')::uuid)) order by created_at desc,id desc limit 31`,
      [s.organizationId, s.projectId, s.userId, before]
    )
    return { items: r.rows.slice(0, 30).map(mapSession), nextCursor: r.rows.length > 30 ? r.rows[29].id : null }
  })
}
export async function snapshot(pool: DatabasePool, s: ChatScope, id: string): Promise<ProjectChatSnapshot> {
  return chatTransaction(pool, s, false, async (c) => {
    const session = await ownedSession(c, s, id)
    const seq = await c.query('select event_sequence from chat_sessions where id=$1', [id])
    const messages = await c.query(
      'select * from chat_messages where session_id=$1 order by created_at desc,id desc limit 101',
      [id]
    )
    const turns = await c.query(
      'select * from chat_turns where session_id=$1 order by created_at desc,id desc limit 1',
      [id]
    )
    const interactions = await c.query(
      "select * from chat_interactions where session_id=$1 and state='pending' order by created_at",
      [id]
    )
    return {
      session,
      messages: messages.rows.slice(0, 100).reverse().map(mapMessage),
      turn: turns.rows[0] ? mapTurn(turns.rows[0]) : null,
      interactions: interactions.rows.map(mapInteraction),
      cursor: Number(seq.rows[0].event_sequence),
      more: messages.rows.length > 100,
    }
  })
}
export async function enqueueMessage(
  c: DatabaseClient,
  session: ProjectChatSession,
  content: string,
  clientMessageId: string,
  continuation?: unknown
) {
  const existing = await c.query('select * from chat_messages where session_id=$1 and client_message_id=$2', [
    session.id,
    clientMessageId,
  ])
  if (existing.rows[0]) {
    if (!sameJson(existing.rows[0].parts, [{ type: 'text', id: 'text', text: content }]))
      chatFail('Message ID was already used with different content.')
    return mapTurn((await c.query('select * from chat_turns where message_id=$1', [existing.rows[0].id])).rows[0])
  }
  if (session.archivedAt) chatFail('Restore the conversation before sending.')
  if (
    (
      await c.query(
        "select id from chat_turns where session_id=$1 and state in ('queued','running','waiting_input','cancelling')",
        [session.id]
      )
    ).rowCount
  )
    chatFail('A turn is already active.')
  if (
    !continuation &&
    (
      await c.query(
        "select id from chat_interactions where session_id=$1 and state='pending' and payload->>'type'='plan'",
        [session.id]
      )
    ).rowCount
  )
    chatFail('Decide the pending plan first.')
  const messageId = randomUUID(),
    turnId = randomUUID()
  await c.query(
    "insert into chat_messages(id,organization_id,project_id,session_id,client_message_id,role,parts) values($1,$2,$3,$4,$5,'user',$6)",
    [
      messageId,
      session.organizationId,
      session.projectId,
      session.id,
      clientMessageId,
      JSON.stringify([{ type: 'text', id: 'text', text: content }]),
    ]
  )
  const turn = mapTurn(
    (
      await c.query(
        'insert into chat_turns(id,organization_id,project_id,session_id,message_id,runner_id,continuation) values($1,$2,$3,$4,$5,$6,$7) returning *',
        [
          turnId,
          session.organizationId,
          session.projectId,
          session.id,
          messageId,
          session.runnerId,
          continuation ?? null,
        ]
      )
    ).rows[0]
  )
  await c.query('update chat_messages set turn_id=$2 where id=$1', [messageId, turnId])
  const message = mapMessage((await c.query('select * from chat_messages where id=$1', [messageId])).rows[0])
  await appendChatEvent(c, session, { type: 'message', message }, 'user-' + clientMessageId, turnId)
  await appendChatEvent(c, session, { type: 'turn', turn }, 'queued-' + turnId, turnId)
  return turn
}
