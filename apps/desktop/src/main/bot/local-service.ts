import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import { z } from 'zod'
import {
  BOT_ACTIONS,
  BOT_WAIT_MAX_SECONDS,
  botActionSchema,
  botCommandSchema,
  botConnectionSchema,
  botConversationEventSchema,
  botConversationSchema,
  botEventUploadSchema,
  botGrantSchema,
  botInventorySchema,
  botMessageSchema,
  botQuestionSchema,
  botSelectionSchema,
  parseBotCommandPayload,
  type BotAction,
  type BotClaim,
  type BotCommand,
  type BotCommandKind,
  type BotConnection,
  type BotControls,
  type BotConversation,
  type BotConversationEvent,
  type BotConversationSnapshot,
  type BotEventPayload,
  type BotEventUpload,
  type BotGrant,
  type BotInventory,
  type BotManagementState,
} from '@maestrly/protocol'
import { getAppSetting, getDb, setAppSetting, transaction } from '../store'
import { DEFAULT_BOT_PERMISSION_CEILING, type BotPermissionCeiling } from '../../shared/bot'
import { BOT_TRANSCRIPT_MAX_LIMIT, BotTranscriptError, readBotChatHistory, type BotTranscriptPage } from './transcript'

/**
 * The bot relay that lives inside this desktop.
 *
 * Nothing here reaches a server: the person, this computer and the bot connection are the only scopes,
 * and every connection, grant, chat, command, durable event and idempotency receipt is a local row. A
 * bot arrives through the embedded HTTP server and calls `callTool`; the conversation worker reaches
 * the same service in-process. Both keep the relay contract: the commands of one chat run strictly in
 * order, a claim is fenced by a lease, mutations are idempotent and events are durable before they can
 * be read back.
 */
export const BOT_LOCAL_OWNER_USER_ID = 'local-owner'
export const BOT_LOCAL_INSTANCE_ID = 'local'
/** How long a claimed command may run before a new claim fences its holder out. */
export const BOT_LOCAL_LEASE_MS = 60_000
const DESKTOP_ID_KEY = 'bot.local.desktop.v1'
const TERMINAL_STATUS = ['succeeded', 'failed', 'cancelled']
/** An unreadable saved ceiling is read as the strictest one, never as more access than was granted. */
const botPermissionCeilingSchema = z.enum(['ask', 'auto', 'full'])

export class BotLocalError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 409) {
    super(message)
    this.name = 'BotLocalError'
    this.statusCode = statusCode
  }
}

function fail(message: string, statusCode = 409): never {
  throw new BotLocalError(message, statusCode)
}

/** Identity of this computer. It is minted once and never sent anywhere. */
export function localBotDesktopId(): string {
  const saved = getAppSetting(DESKTOP_ID_KEY)
  if (saved) return saved
  const created = randomUUID()
  setAppSetting(DESKTOP_ID_KEY, created)
  return created
}

export interface BotLocalConnection {
  id: string
  name: string
  clientId: string
  desktopId: string
  ownerUserId: string
  workspaceIds: string[]
  actions: BotAction[]
  providerIds: string[]
  selections: Array<{ providerId: string; modelId: string }> | null
  /** The furthest a turn of this bot may go before it asks the person at this computer. */
  permissionCeiling: BotPermissionCeiling
  revokedAt: string | null
  version: number
}

/** What a desktop must present to write against the command it claimed. */
export interface BotLeaseHold {
  commandId: string
  leaseToken: string
  fence: number
}

interface ConnectionRow {
  id: string
  name: string
  client_id: string
  desktop_id: string
  owner_user_id: string
  provider_ids: string
  selections: string | null
  permission_ceiling: string | null
  revoked_at: number | null
  version: number
}

interface ConversationRow {
  id: string
  connection_id: string
  desktop_id: string
  owner_user_id: string
  workspace_id: string
  name: string
  base_branch: string
  selection: string
  management_state: BotManagementState
  owner_attention: string | null
  version: number
  command_sequence: number
  command_fence: number
  event_sequence: number
}

interface CommandRow {
  id: string
  conversation_id: string
  connection_id: string
  kind: BotCommandKind
  payload: string
  status: string
  lease_token: string | null
  lease_expires_at: number | null
  fence: number
  attempt: number
  error: string | null
  sequence: number
  version: number
}

interface MessageRow {
  id: string
  conversation_id: string
  command_id: string | null
  role: string
  parts: string
  created_at: number
}

interface QuestionRow {
  id: string
  conversation_id: string
  command_id: string
  questions: string
  state: string
  answers: string | null
  created_at: number
}

interface EventRow {
  conversation_id: string
  sequence: number
  event_id: string
  payload: string
}

const db = () => getDb()
const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString())
const isControl = (kind: string) => kind === 'answer' || kind === 'cancel'
const actionForKind = (kind: BotCommandKind): BotAction =>
  kind === 'answer' ? 'chats:answer' : kind === 'cancel' ? 'chats:control' : 'chats:write'

/** Runs the work inside the store transaction and hands its value back. */
function tx<T>(work: () => T): T {
  let value!: T
  transaction(() => {
    value = work()
  })
  return value
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function mapConversation(row: ConversationRow): BotConversation {
  return botConversationSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    desktopId: row.desktop_id,
    workspaceId: row.workspace_id,
    name: row.name,
    baseBranch: row.base_branch,
    selection: JSON.parse(row.selection),
    managementState: row.management_state,
    version: Number(row.version),
  })
}

/** `includeLease` is true only for the claim just handed to this desktop; a bot never sees the token. */
function mapCommand(row: CommandRow, includeLease = false): BotCommand {
  return botCommandSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    status: row.status,
    ...(includeLease ? { leaseToken: row.lease_token ?? null } : {}),
    version: Number(row.version),
  })
}

function mapMessage(row: MessageRow) {
  return botMessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    commandId: row.command_id ?? null,
    role: row.role,
    parts: JSON.parse(row.parts),
    createdAt: new Date(row.created_at).toISOString(),
  })
}

function mapQuestion(row: QuestionRow) {
  return botQuestionSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    commandId: row.command_id,
    questions: JSON.parse(row.questions),
    state: row.state,
    answers: row.answers ? JSON.parse(row.answers) : null,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

function mapEvent(row: EventRow): BotConversationEvent {
  return botConversationEventSchema.parse({
    version: 1,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    eventId: row.event_id,
    payload: JSON.parse(row.payload),
  })
}

const conversationInput = z.object({ conversationId: z.string().uuid() })
const historyInput = z.object({
  conversationId: z.string().uuid(),
  cursor: z.string().max(4_096).optional(),
  limit: z.number().int().min(1).max(BOT_TRANSCRIPT_MAX_LIMIT).optional(),
})
const waitInput = z.object({
  conversationId: z.string().uuid(),
  cursor: z.number().int().nonnegative(),
  timeoutSeconds: z.number().int().min(0).max(BOT_WAIT_MAX_SECONDS).default(BOT_WAIT_MAX_SECONDS),
})
const idempotencyKey = z.string().min(1).max(191)

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })

export class LocalBotService {
  constructor(private readonly clock: () => number = Date.now) {}

  desktopId(): string {
    return localBotDesktopId()
  }

  connections(): BotLocalConnection[] {
    const rows = db()
      .prepare('SELECT * FROM bot_local_connections ORDER BY created_at')
      .all() as unknown as ConnectionRow[]
    return rows.map((row) => this.connectionOf(row))
  }

  connection(id: string): BotLocalConnection | null {
    const row = db().prepare('SELECT * FROM bot_local_connections WHERE id=?').get(id) as unknown as
      | ConnectionRow
      | undefined
    return row ? this.connectionOf(row) : null
  }

  requireConnection(id: string): BotLocalConnection {
    return this.connection(id) ?? fail('That bot connection is not known to this computer.', 404)
  }

  /** Only the person at this computer creates a connection; a bot can never create or widen one. */
  createConnection(input: {
    name: string
    clientId?: string
    workspaceIds: string[]
    actions?: BotAction[]
    providerIds: string[]
    selections?: Array<{ providerId: string; modelId: string }>
    permissionCeiling?: BotPermissionCeiling
  }): BotLocalConnection {
    const clientId = input.clientId?.trim() || `maestrly-bot-${randomUUID()}`
    if (!input.workspaceIds.length) fail('A bot connection needs at least one authorized project.', 400)
    if (db().prepare('SELECT 1 FROM bot_local_connections WHERE client_id=?').get(clientId))
      fail('That bot client is already connected on this computer.')
    const id = randomUUID()
    const actions = input.actions?.length ? input.actions : [...BOT_ACTIONS]
    const now = this.clock()
    tx(() => {
      db()
        .prepare(
          `INSERT INTO bot_local_connections
           (id,name,client_id,desktop_id,owner_user_id,provider_ids,selections,permission_ceiling,revoked_at,version,created_at)
           VALUES(?,?,?,?,?,?,?,?,NULL,1,?)`
        )
        .run(
          id,
          input.name,
          clientId,
          this.desktopId(),
          BOT_LOCAL_OWNER_USER_ID,
          JSON.stringify(input.providerIds),
          input.selections ? JSON.stringify(input.selections) : null,
          input.permissionCeiling ?? DEFAULT_BOT_PERMISSION_CEILING,
          now
        )
      this.writeGrants(id, input.workspaceIds, actions)
    })
    return this.requireConnection(id)
  }

  /** A narrowed grant applies at once: a running command is refused on its next write. */
  setGrants(connectionId: string, workspaceIds: string[], actions?: BotAction[]): BotLocalConnection {
    const connection = this.requireConnection(connectionId)
    if (connection.revokedAt) fail('This bot connection was revoked.')
    tx(() => {
      this.writeGrants(connectionId, workspaceIds, actions ?? connection.actions)
      db().prepare('UPDATE bot_local_connections SET version=version+1 WHERE id=?').run(connectionId)
    })
    return this.requireConnection(connectionId)
  }

  /**
   * Move how far this bot may go on its own. Only the person at this computer ever calls it, and the
   * new version is what a running command is checked against, so a narrowed ceiling applies at once.
   */
  setPermissionCeiling(connectionId: string, ceiling: BotPermissionCeiling): BotLocalConnection {
    const connection = this.requireConnection(connectionId)
    if (connection.revokedAt) fail('This bot connection was revoked.')
    if (connection.permissionCeiling === ceiling) return connection
    db()
      .prepare('UPDATE bot_local_connections SET permission_ceiling=?,version=version+1 WHERE id=?')
      .run(ceiling, connectionId)
    return this.requireConnection(connectionId)
  }

  revokeConnection(connectionId: string): void {
    const connection = this.connection(connectionId)
    if (!connection) return
    const now = this.clock()
    tx(() => {
      db()
        .prepare('UPDATE bot_local_connections SET revoked_at=COALESCE(revoked_at,?),version=version+1 WHERE id=?')
        .run(now, connectionId)
      for (const row of this.conversationRows(connectionId))
        if (row.management_state !== 'revoked') this.applyManagement(row.id, 'revoked')
    })
  }

  grants(connectionId: string): BotGrant[] {
    const rows = db()
      .prepare(
        'SELECT workspace_id AS workspaceId,actions FROM bot_local_grants WHERE connection_id=? ORDER BY workspace_id'
      )
      .all(connectionId) as unknown as Array<{ workspaceId: string; actions: string }>
    return rows.map((row) => botGrantSchema.parse({ workspaceId: row.workspaceId, actions: JSON.parse(row.actions) }))
  }

  inventory(connectionId: string): BotInventory | null {
    const row = db().prepare('SELECT payload FROM bot_local_inventory WHERE connection_id=?').get(connectionId) as
      | { payload: string }
      | undefined
    if (!row) return null
    const parsed = botInventorySchema.safeParse(JSON.parse(row.payload))
    return parsed.success ? parsed.data : null
  }

  /** What this computer currently offers a bot. Published by the host, never by the bot. */
  saveInventory(connectionId: string, inventory: BotInventory): void {
    this.requireConnection(connectionId)
    db()
      .prepare(
        `INSERT INTO bot_local_inventory(connection_id,payload,updated_at) VALUES(?,?,?)
         ON CONFLICT(connection_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`
      )
      .run(connectionId, JSON.stringify(botInventorySchema.parse(inventory)), this.clock())
  }

  /** One command per lane of a chat, fenced so an interrupted holder can never finish its work. */
  claim(connectionId?: string): BotClaim | null {
    return tx(() => {
      const now = this.clock()
      db()
        .prepare(
          `UPDATE bot_local_commands SET status='queued',lease_token=NULL,lease_expires_at=NULL,version=version+1
           WHERE status='leased' AND lease_expires_at<=?`
        )
        .run(now)
      const queued = db()
        .prepare(
          `SELECT c.* FROM bot_local_commands c
             JOIN bot_local_conversations v ON v.id=c.conversation_id
             JOIN bot_local_connections n ON n.id=c.connection_id
           WHERE c.status='queued' AND v.management_state='active' AND n.revoked_at IS NULL
             AND (?1 IS NULL OR c.connection_id=?1)
           ORDER BY (c.kind IN ('answer','cancel')) DESC,c.created_at,c.sequence`
        )
        .all(connectionId ?? null) as unknown as CommandRow[]
      for (const command of queued) {
        const claim = this.lease(command, now)
        if (claim) return claim
      }
      return null
    })
  }

  private lease(command: CommandRow, now: number): BotClaim | null {
    const conversation = this.conversationRow(command.conversation_id)
    if (!conversation) return null
    if (!this.allows(command.connection_id, conversation.workspace_id, actionForKind(command.kind))) return null
    if (!this.inventory(command.connection_id)?.enabled) return null
    const control = isControl(command.kind)
    const busy = db()
      .prepare(
        `SELECT 1 FROM bot_local_commands WHERE conversation_id=? AND status='leased'
           AND (kind IN ('answer','cancel'))=?`
      )
      .get(command.conversation_id, control ? 1 : 0)
    if (busy) return null
    if (!control) {
      const earlier = db()
        .prepare(
          `SELECT 1 FROM bot_local_commands WHERE conversation_id=? AND status='queued'
             AND kind NOT IN ('answer','cancel') AND sequence<?`
        )
        .get(command.conversation_id, command.sequence)
      if (earlier) return null
    }
    // An answer only runs while the turn that asked its question is still holding a lease.
    if (command.kind === 'answer' && !this.answerable(command)) return null
    const fence = Number(conversation.command_fence) + 1
    const leaseToken = randomUUID()
    const expiresAt = now + BOT_LOCAL_LEASE_MS
    db()
      .prepare('UPDATE bot_local_conversations SET command_fence=?,updated_at=? WHERE id=?')
      .run(fence, now, conversation.id)
    db()
      .prepare(
        `UPDATE bot_local_commands SET status='leased',lease_token=?,lease_expires_at=?,fence=?,
           attempt=attempt+1,version=version+1 WHERE id=?`
      )
      .run(leaseToken, expiresAt, fence, command.id)
    const leased = this.commandRow(command.id)
    if (!leased) fail('Command not found.', 404)
    this.appendEvent(
      conversation.id,
      { type: 'command', command: mapCommand(leased) },
      `command-leased-${leased.id}-${leased.attempt}`,
      leased.id
    )
    return {
      owner: { userId: BOT_LOCAL_OWNER_USER_ID },
      connection: this.connectionProtocol(command.connection_id),
      conversation: mapConversation(conversation),
      command: mapCommand(leased, true),
      leaseExpiresAt: new Date(expiresAt).toISOString(),
      fence,
    }
  }

  renewLease(hold: BotLeaseHold): BotControls {
    return tx(() => {
      const held = this.assertLease(hold)
      const expiresAt = this.clock() + BOT_LOCAL_LEASE_MS
      db().prepare('UPDATE bot_local_commands SET lease_expires_at=? WHERE id=?').run(expiresAt, held.command.id)
      return this.controlsFor({ ...held, command: { ...held.command, lease_expires_at: expiresAt } })
    })
  }

  controls(hold: BotLeaseHold): BotControls {
    return tx(() => this.controlsFor(this.assertLease(hold)))
  }

  /**
   * Durable event upload. An event id is idempotent within its chat: the same id with the same content
   * is accepted and ignored, a different content is refused, and the state this computer owns is never
   * taken from an uploaded payload.
   */
  uploadEvents(hold: BotLeaseHold, events: BotEventUpload[]): string[] {
    return tx(() => {
      const held = this.assertLease(hold)
      for (const raw of events) {
        const event = botEventUploadSchema.parse(raw)
        const encoded = JSON.stringify(event.payload)
        const existing = db()
          .prepare('SELECT payload FROM bot_local_events WHERE conversation_id=? AND event_id=?')
          .get(held.conversation.id, event.eventId) as { payload: string } | undefined
        if (existing) {
          if (existing.payload !== encoded) fail('Event id reused with different content.')
          continue
        }
        this.materialize(held, event.payload)
        this.appendEvent(held.conversation.id, event.payload, event.eventId, held.command.id)
      }
      return events.map((event) => event.eventId)
    })
  }

  complete(hold: BotLeaseHold & { status: 'succeeded' | 'failed' | 'cancelled'; error: string | null }): BotCommand {
    return tx(() => {
      const held = this.assertLease(hold, true)
      const now = this.clock()
      if (TERMINAL_STATUS.includes(held.command.status)) {
        // Retrying the same completion replays it; a different outcome is a conflict.
        if (held.command.status !== hold.status || (held.command.error ?? null) !== hold.error)
          fail('Completion conflicts with the recorded outcome.')
        return mapCommand(held.command)
      }
      db()
        .prepare('UPDATE bot_local_commands SET status=?,error=?,completed_at=?,version=version+1 WHERE id=?')
        .run(hold.status, hold.error, now, held.command.id)
      const finished = this.commandRow(held.command.id)
      if (!finished) fail('Command not found.', 404)
      const payload = JSON.parse(finished.payload) as Record<string, unknown>
      if (hold.status === 'succeeded' && finished.kind === 'answer') this.recordAnswer(held, finished, payload)
      if (hold.status === 'succeeded' && finished.kind === 'configure') this.applyConfigure(held, finished, payload)
      // A failed turn keeps its native chat: the person can inspect it and instruct it again later.
      if (hold.status !== 'succeeded') this.expireQuestions(held, finished)
      const command = mapCommand(finished)
      this.appendEvent(
        held.conversation.id,
        { type: 'command', command },
        `command-finished-${finished.id}-${finished.attempt}`,
        finished.id
      )
      return command
    })
  }

  private recordAnswer(
    held: { command: CommandRow; conversation: ConversationRow },
    finished: CommandRow,
    payload: Record<string, unknown>
  ): void {
    const questionId = typeof payload.questionId === 'string' ? payload.questionId : ''
    const answered = db()
      .prepare(
        `UPDATE bot_local_questions SET state='answered',answers=? WHERE id=? AND conversation_id=? AND state='pending'`
      )
      .run(JSON.stringify(payload.answers ?? []), questionId, held.conversation.id)
    const question = this.questionOf(questionId)
    if (answered.changes && question)
      this.appendEvent(
        held.conversation.id,
        { type: 'question', question },
        `question-answered-${questionId}`,
        finished.id
      )
  }

  private applyConfigure(
    held: { command: CommandRow; conversation: ConversationRow },
    finished: CommandRow,
    payload: Record<string, unknown>
  ): void {
    const selection = payload.selection
      ? botSelectionSchema.parse({
          ...(JSON.parse(held.conversation.selection) as Record<string, unknown>),
          ...(payload.selection as Record<string, unknown>),
        })
      : null
    db()
      .prepare(
        `UPDATE bot_local_conversations SET selection=COALESCE(?,selection),name=COALESCE(?,name),
           version=version+1,updated_at=? WHERE id=?`
      )
      .run(
        selection ? JSON.stringify(selection) : null,
        typeof payload.name === 'string' ? payload.name : null,
        this.clock(),
        held.conversation.id
      )
    const row = this.conversationRow(held.conversation.id)
    if (!row) return
    this.appendEvent(
      row.id,
      { type: 'conversation', conversation: mapConversation(row) },
      `configured-${finished.id}`,
      finished.id
    )
  }

  private expireQuestions(held: { conversation: ConversationRow }, finished: CommandRow): void {
    const pending = db()
      .prepare(`SELECT id FROM bot_local_questions WHERE command_id=? AND state='pending'`)
      .all(finished.id) as unknown as Array<{ id: string }>
    for (const row of pending) {
      db().prepare(`UPDATE bot_local_questions SET state='expired' WHERE id=?`).run(row.id)
      const question = this.questionOf(row.id)
      if (question)
        this.appendEvent(
          held.conversation.id,
          { type: 'question', question },
          `question-expired-${row.id}`,
          finished.id
        )
    }
  }

  /** Owner-only lifecycle. A bot can never move a chat out of `paused`. */
  setManagement(conversationId: string, state: BotManagementState): BotConversation | null {
    const row = this.conversationRow(conversationId)
    if (!row) return null
    if (row.management_state === 'revoked' && state !== 'revoked') fail('A revoked chat cannot be reactivated.')
    if (row.management_state === state) return mapConversation(row)
    return tx(() => this.applyManagement(conversationId, state))
  }

  private applyManagement(conversationId: string, state: BotManagementState): BotConversation {
    const now = this.clock()
    db()
      .prepare(
        `UPDATE bot_local_conversations SET management_state=?,owner_attention=NULL,version=version+1,updated_at=?
         WHERE id=?`
      )
      .run(state, now, conversationId)
    if (state === 'revoked')
      db()
        .prepare(
          `UPDATE bot_local_commands SET status='cancelled',lease_token=NULL,completed_at=?,version=version+1
           WHERE conversation_id=? AND status IN ('queued','leased')`
        )
        .run(now, conversationId)
    const row = this.conversationRow(conversationId)
    if (!row) fail('Conversation not found.', 404)
    const conversation = mapConversation(row)
    this.appendEvent(
      conversationId,
      { type: 'owner-attention', attention: null },
      `owner-attention-reset-${conversation.version}-${conversationId}`,
      null
    )
    this.appendEvent(
      conversationId,
      { type: 'conversation', conversation },
      `management-${conversation.version}-${conversationId}`,
      null
    )
    return conversation
  }

  /**
   * The relay tools, unchanged from the protocol a bot already speaks. The HTTP layer owns their
   * descriptors and the authorization of the caller; the rules of each call live here.
   */
  async callTool(
    connectionId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const connection = this.requireConnection(connectionId)
    if (connection.revokedAt) fail('This bot connection was revoked at the computer it reaches.', 403)
    switch (name) {
      case 'bot_list_workspaces':
        return this.desktopView(connection)
      case 'bot_list_selections':
        return { selections: this.desktopView(connection).selections }
      case 'bot_list_chats':
        return { conversations: this.listChats(connection) }
      case 'bot_read_chat':
        return this.readChat(connection, conversationInput.parse(input).conversationId)
      case 'bot_read_chat_history':
        return this.readChatHistory(connection, historyInput.parse(input))
      case 'bot_wait_events':
        return this.waitEvents(connection, waitInput.parse(input), signal)
      case 'bot_create_chat':
        return this.idempotent(connection, name, input, () => this.createChat(connection, input))
      case 'bot_send_message':
        return this.idempotent(connection, name, input, () =>
          this.enqueue(connection, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'send',
            payload: { text: input.text },
          })
        )
      case 'bot_configure_chat':
        return this.idempotent(connection, name, input, () =>
          this.enqueue(connection, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'configure',
            payload: {
              ...(input.selection === undefined ? {} : { selection: input.selection }),
              ...(input.name === undefined ? {} : { name: input.name }),
            },
          })
        )
      case 'bot_cancel_turn':
        return this.idempotent(connection, name, input, () =>
          this.enqueue(connection, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'cancel',
            payload: {},
          })
        )
      case 'bot_answer_question':
        return this.idempotent(connection, name, input, () =>
          this.enqueue(connection, {
            conversationId: conversationInput.parse(input).conversationId,
            kind: 'answer',
            payload: { questionId: input.questionId, answers: input.answers },
          })
        )
      default:
        return fail('Unknown tool.', 400)
    }
  }

  private desktopView(connection: BotLocalConnection) {
    const inventory = this.inventory(connection.id)
    const workspaces = this.grants(connection.id)
      .map((grant) => {
        const workspace = inventory?.workspaces.find((item) => item.workspaceId === grant.workspaceId)
        return workspace ? { ...workspace, actions: grant.actions } : null
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    return {
      desktop: { id: connection.desktopId, name: os.hostname(), online: Boolean(inventory?.enabled) },
      workspaces,
      selections: inventory?.selections ?? [],
    }
  }

  private listChats(connection: BotLocalConnection): BotConversation[] {
    return this.conversationRows(connection.id)
      .filter((row) => this.allows(connection.id, row.workspace_id, 'chats:read'))
      .map(mapConversation)
  }

  private readChat(connection: BotLocalConnection, conversationId: string): BotConversationSnapshot {
    const row = this.ownedConversation(connection, conversationId)
    this.assertGrant(connection.id, row.workspace_id, 'chats:read')
    const messages = db()
      .prepare('SELECT * FROM bot_local_messages WHERE conversation_id=? ORDER BY created_at,id LIMIT 500')
      .all(conversationId) as unknown as MessageRow[]
    const questions = db()
      .prepare('SELECT * FROM bot_local_questions WHERE conversation_id=? ORDER BY created_at LIMIT 100')
      .all(conversationId) as unknown as QuestionRow[]
    const pending = db()
      .prepare(
        `SELECT * FROM bot_local_commands WHERE conversation_id=? AND status IN ('queued','leased')
         ORDER BY sequence LIMIT 1`
      )
      .get(conversationId) as unknown as CommandRow | undefined
    return {
      conversation: mapConversation(row),
      messages: messages.map(mapMessage),
      questions: questions.map(mapQuestion),
      pendingCommand: pending ? mapCommand(pending) : null,
      cursor: Number(row.event_sequence),
      ownerAttention: row.owner_attention
        ? (JSON.parse(row.owner_attention) as BotConversationSnapshot['ownerAttention'])
        : null,
    }
  }

  /**
   * The chat as the person sees it, page by page.
   *
   * The relay's own messages stop at what a bot command produced, so this reads the conversation on
   * this computer instead. It is the same connection, chat and grant as every other read: a chat of
   * another bot, or one the person started themselves, is simply not found.
   */
  private readChatHistory(connection: BotLocalConnection, input: z.infer<typeof historyInput>): BotTranscriptPage {
    const row = this.ownedConversation(connection, input.conversationId)
    this.assertGrant(connection.id, row.workspace_id, 'chats:read')
    try {
      return readBotChatHistory({
        identity: {
          instanceId: BOT_LOCAL_INSTANCE_ID,
          ownerUserId: connection.ownerUserId,
          desktopId: connection.desktopId,
          connectionId: connection.id,
          botName: connection.name,
        },
        conversationId: input.conversationId,
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
    } catch (error) {
      fail(
        error instanceof Error ? error.message : String(error),
        error instanceof BotTranscriptError ? error.statusCode : 409
      )
    }
  }

  /** Bounded long poll, so a relayed bot turn never hangs on an open call. */
  private async waitEvents(
    connection: BotLocalConnection,
    input: z.infer<typeof waitInput>,
    signal: AbortSignal
  ): Promise<{ conversationId: string; cursor: number; events: BotConversationEvent[]; timedOut: boolean }> {
    const deadline = Date.now() + input.timeoutSeconds * 1_000
    for (;;) {
      const events = this.readEvents(connection, input.conversationId, input.cursor)
      if (events.length)
        return {
          conversationId: input.conversationId,
          cursor: events[events.length - 1]!.sequence,
          events,
          timedOut: false,
        }
      if (Date.now() >= deadline || signal.aborted)
        return { conversationId: input.conversationId, cursor: input.cursor, events: [], timedOut: true }
      await sleep(250, signal)
    }
  }

  private readEvents(connection: BotLocalConnection, conversationId: string, cursor: number): BotConversationEvent[] {
    const row = this.ownedConversation(connection, conversationId)
    this.assertGrant(connection.id, row.workspace_id, 'chats:read')
    const rows = db()
      .prepare('SELECT * FROM bot_local_events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 200')
      .all(conversationId, cursor) as unknown as EventRow[]
    return rows.map(mapEvent)
  }

  private createChat(connection: BotLocalConnection, input: Record<string, unknown>) {
    const payload = parseBotCommandPayload('create', {
      workspaceId: input.workspaceId,
      name: input.name,
      baseBranch: input.baseBranch,
      selection: input.selection,
      message: input.message ?? null,
    }) as {
      workspaceId: string
      name: string
      baseBranch: string
      selection: Record<string, unknown>
      message: string | null
    }
    this.assertGrant(connection.id, payload.workspaceId, 'chats:write')
    const id = randomUUID()
    const now = this.clock()
    db()
      .prepare(
        `INSERT INTO bot_local_conversations
         (id,connection_id,desktop_id,owner_user_id,workspace_id,name,base_branch,selection,management_state,
          owner_attention,version,command_sequence,command_fence,event_sequence,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'active',NULL,1,0,0,0,?,?)`
      )
      .run(
        id,
        connection.id,
        connection.desktopId,
        connection.ownerUserId,
        payload.workspaceId,
        payload.name,
        payload.baseBranch,
        JSON.stringify(payload.selection),
        now,
        now
      )
    const row = this.conversationRow(id)
    if (!row) fail('Conversation not found.', 404)
    const conversation = mapConversation(row)
    this.appendEvent(id, { type: 'conversation', conversation }, `conversation-created-${id}`, null)
    return {
      conversation,
      command: this.insertCommand(connection.id, id, 'create', payload as unknown as Record<string, unknown>),
    }
  }

  private enqueue(
    connection: BotLocalConnection,
    input: { conversationId: string; kind: Exclude<BotCommandKind, 'create'>; payload: unknown }
  ) {
    const payload = parseBotCommandPayload(input.kind, input.payload)
    const row = this.ownedConversation(connection, input.conversationId)
    if (row.management_state === 'paused')
      fail('This chat is paused by the person at that computer; only they can resume it.')
    if (row.management_state === 'revoked') fail('This chat was revoked.')
    this.assertGrant(connection.id, row.workspace_id, actionForKind(input.kind))
    if (input.kind === 'answer') {
      const question = db()
        .prepare('SELECT state FROM bot_local_questions WHERE id=? AND conversation_id=?')
        .get(String(payload.questionId), row.id) as { state: string } | undefined
      if (!question) fail('Question not found.', 404)
      if (question.state !== 'pending') fail('This question was already answered or expired.')
    }
    if (input.kind === 'cancel') {
      const queued = db()
        .prepare(
          `SELECT * FROM bot_local_commands WHERE conversation_id=? AND kind='cancel' AND status='queued' LIMIT 1`
        )
        .get(row.id) as unknown as CommandRow | undefined
      if (queued) return { conversation: mapConversation(row), command: mapCommand(queued) }
    }
    return {
      conversation: mapConversation(row),
      command: this.insertCommand(connection.id, row.id, input.kind, payload),
    }
  }

  private insertCommand(
    connectionId: string,
    conversationId: string,
    kind: BotCommandKind,
    payload: Record<string, unknown>
  ): BotCommand {
    const row = this.conversationRow(conversationId)
    if (!row) fail('Conversation not found.', 404)
    const sequence = Number(row.command_sequence) + 1
    const id = randomUUID()
    const now = this.clock()
    db()
      .prepare('UPDATE bot_local_conversations SET command_sequence=?,updated_at=? WHERE id=?')
      .run(sequence, now, conversationId)
    db()
      .prepare(
        `INSERT INTO bot_local_commands
         (id,conversation_id,connection_id,desktop_id,kind,payload,status,lease_token,lease_expires_at,fence,
          attempt,error,sequence,version,created_at,completed_at)
         VALUES(?,?,?,?,?,?,'queued',NULL,NULL,0,0,NULL,?,1,?,NULL)`
      )
      .run(id, conversationId, connectionId, row.desktop_id, kind, JSON.stringify(payload), sequence, now)
    const created = this.commandRow(id)
    if (!created) fail('Command not found.', 404)
    const command = mapCommand(created)
    this.appendEvent(conversationId, { type: 'command', command }, `command-queued-${id}`, id)
    return command
  }

  /** Durable idempotency per connection: a retried call replays its first result, never repeats it. */
  private idempotent<T>(
    connection: BotLocalConnection,
    tool: string,
    input: Record<string, unknown>,
    work: () => T
  ): T {
    const key = idempotencyKey.parse(input.idempotencyKey)
    const digest = createHash('sha256')
      .update(canonical({ tool, input: { ...input, idempotencyKey: undefined } }))
      .digest('hex')
    return tx(() => {
      if (tool === 'bot_create_chat') {
        this.assertGrant(connection.id, z.string().parse(input.workspaceId), 'chats:write')
      } else {
        const row = this.ownedConversation(connection, conversationInput.parse(input).conversationId)
        this.assertGrant(
          connection.id,
          row.workspace_id,
          tool === 'bot_answer_question' ? 'chats:answer' : tool === 'bot_cancel_turn' ? 'chats:control' : 'chats:write'
        )
        if (row.management_state !== 'active') fail('This chat is paused or revoked by its owner.')
      }
      const existing = db()
        .prepare(
          'SELECT request_hash AS hash,body FROM bot_local_idempotency WHERE connection_id=? AND idempotency_key=?'
        )
        .get(connection.id, key) as { hash: string; body: string } | undefined
      if (existing) {
        if (existing.hash !== digest) fail('The idempotency key was already used with different content.')
        return JSON.parse(existing.body) as T
      }
      const body = work()
      db()
        .prepare(
          `INSERT INTO bot_local_idempotency(connection_id,idempotency_key,request_hash,body,created_at)
           VALUES(?,?,?,?,?)`
        )
        .run(connection.id, key, digest, JSON.stringify(body), this.clock())
      return body
    })
  }

  private writeGrants(connectionId: string, workspaceIds: string[], actions: BotAction[]): void {
    db().prepare('DELETE FROM bot_local_grants WHERE connection_id=?').run(connectionId)
    const insert = db().prepare('INSERT INTO bot_local_grants(connection_id,workspace_id,actions) VALUES(?,?,?)')
    for (const workspaceId of [...new Set(workspaceIds)]) insert.run(connectionId, workspaceId, JSON.stringify(actions))
  }

  private allows(connectionId: string, workspaceId: string, action: BotAction): boolean {
    const connection = this.connection(connectionId)
    if (!connection || connection.revokedAt) return false
    const row = db()
      .prepare('SELECT actions FROM bot_local_grants WHERE connection_id=? AND workspace_id=?')
      .get(connectionId, workspaceId) as { actions: string } | undefined
    return !!row && z.array(botActionSchema).parse(JSON.parse(row.actions)).includes(action)
  }

  private assertGrant(connectionId: string, workspaceId: string, action: BotAction): void {
    if (!this.allows(connectionId, workspaceId, action)) fail('The connection grant was changed or revoked.', 403)
  }

  private connectionProtocol(connectionId: string): BotConnection {
    const connection = this.requireConnection(connectionId)
    return botConnectionSchema.parse({
      id: connection.id,
      name: connection.name,
      ownerUserId: connection.ownerUserId,
      desktopId: connection.desktopId,
      clientId: connection.clientId,
      grants: this.grants(connection.id),
      revokedAt: connection.revokedAt,
      version: connection.version,
    })
  }

  private connectionOf(row: ConnectionRow): BotLocalConnection {
    const grants = this.grants(row.id)
    return {
      id: row.id,
      name: row.name,
      clientId: row.client_id,
      desktopId: row.desktop_id,
      ownerUserId: row.owner_user_id,
      workspaceIds: grants.map((grant) => grant.workspaceId),
      actions: [...new Set(grants.flatMap((grant) => grant.actions))],
      providerIds: z.array(z.string()).parse(JSON.parse(row.provider_ids)),
      selections: row.selections
        ? (JSON.parse(row.selections) as Array<{ providerId: string; modelId: string }>)
        : null,
      permissionCeiling: botPermissionCeilingSchema.catch(DEFAULT_BOT_PERMISSION_CEILING).parse(row.permission_ceiling),
      revokedAt: iso(row.revoked_at),
      version: Number(row.version),
    }
  }

  private conversationRow(id: string): ConversationRow | undefined {
    return db().prepare('SELECT * FROM bot_local_conversations WHERE id=?').get(id) as unknown as
      | ConversationRow
      | undefined
  }

  private conversationRows(connectionId: string): ConversationRow[] {
    return db()
      .prepare('SELECT * FROM bot_local_conversations WHERE connection_id=? ORDER BY updated_at DESC LIMIT 200')
      .all(connectionId) as unknown as ConversationRow[]
  }

  private ownedConversation(connection: BotLocalConnection, conversationId: string): ConversationRow {
    const row = this.conversationRow(conversationId)
    // A chat of another bot, or one the person started themselves, is simply not found here.
    if (!row || row.connection_id !== connection.id) fail('Conversation not found.', 404)
    return row
  }

  private commandRow(id: string): CommandRow | undefined {
    return db().prepare('SELECT * FROM bot_local_commands WHERE id=?').get(id) as unknown as CommandRow | undefined
  }

  private questionOf(id: string) {
    const row = db().prepare('SELECT * FROM bot_local_questions WHERE id=?').get(id) as unknown as
      | QuestionRow
      | undefined
    return row ? mapQuestion(row) : null
  }

  private answerable(command: CommandRow): boolean {
    const questionId = (JSON.parse(command.payload) as { questionId?: unknown }).questionId
    if (typeof questionId !== 'string') return false
    const row = db()
      .prepare(
        `SELECT q.state AS state,c.status AS status FROM bot_local_questions q
           JOIN bot_local_commands c ON c.id=q.command_id
         WHERE q.id=? AND q.conversation_id=?`
      )
      .get(questionId, command.conversation_id) as { state: string; status: string } | undefined
    return row?.state === 'pending' && row.status === 'leased'
  }

  /** Every desktop write revalidates the token, the fence, the expiry and the live authorization. */
  private assertLease(hold: BotLeaseHold, terminal = false): { command: CommandRow; conversation: ConversationRow } {
    const command = this.commandRow(hold.commandId)
    if (!command) fail('Command not found.', 404)
    const conversation = this.conversationRow(command.conversation_id)
    if (!conversation) fail('Conversation not found.', 404)
    const connection = this.connection(command.connection_id)
    if (!connection || connection.revokedAt) fail('The bot connection was revoked.', 403)
    if (command.lease_token !== hold.leaseToken || Number(command.fence) !== hold.fence)
      fail('The command lease is no longer valid.')
    if (!this.allows(command.connection_id, conversation.workspace_id, actionForKind(command.kind)))
      fail('The bot workspace grant was revoked.', 403)
    if (terminal && TERMINAL_STATUS.includes(command.status)) return { command, conversation }
    if (command.status !== 'leased' || (command.lease_expires_at ?? 0) <= this.clock())
      fail('The command lease expired.')
    return { command, conversation }
  }

  private controlsFor(held: { command: CommandRow; conversation: ConversationRow }): BotControls {
    const cancelling = db()
      .prepare(
        `SELECT 1 FROM bot_local_commands WHERE conversation_id=? AND kind='cancel'
           AND status IN ('queued','leased') AND id<>?`
      )
      .get(held.conversation.id, held.command.id)
    const current = this.conversationRow(held.conversation.id) ?? held.conversation
    return {
      cancellationRequested: Boolean(cancelling) || current.management_state === 'revoked',
      managementState: current.management_state,
      leaseExpiresAt: new Date(held.command.lease_expires_at ?? this.clock()).toISOString(),
    }
  }

  private materialize(held: { command: CommandRow; conversation: ConversationRow }, payload: BotEventPayload): void {
    const conversationId = held.conversation.id
    if (payload.type === 'command' || payload.type === 'conversation')
      fail('Command and chat state belong to this computer, not to an uploaded event.', 400)
    if (payload.type === 'owner-attention') {
      db()
        .prepare('UPDATE bot_local_conversations SET owner_attention=? WHERE id=?')
        .run(payload.attention ? JSON.stringify(payload.attention) : null, conversationId)
      return
    }
    if (payload.type === 'message') {
      const message = payload.message
      if (
        message.conversationId !== conversationId ||
        message.commandId !== held.command.id ||
        message.role !== 'assistant'
      )
        fail('Message scope mismatch.', 403)
      db()
        .prepare(
          `INSERT INTO bot_local_messages(id,conversation_id,command_id,role,parts,created_at)
           VALUES(?,?,?,'assistant',?,?) ON CONFLICT(id) DO UPDATE SET parts=excluded.parts`
        )
        .run(message.id, conversationId, held.command.id, JSON.stringify(message.parts), Date.parse(message.createdAt))
      return
    }
    if (payload.type === 'question') {
      const question = payload.question
      if (question.conversationId !== conversationId || question.commandId !== held.command.id)
        fail('Question scope mismatch.', 403)
      db()
        .prepare(
          `INSERT INTO bot_local_questions(id,conversation_id,command_id,questions,state,answers,created_at)
           VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
             questions=excluded.questions,state=excluded.state,answers=excluded.answers`
        )
        .run(
          question.id,
          conversationId,
          held.command.id,
          JSON.stringify(question.questions),
          question.state,
          question.answers ? JSON.stringify(question.answers) : null,
          Date.parse(question.createdAt)
        )
      return
    }
    const row = db()
      .prepare('SELECT parts FROM bot_local_messages WHERE id=? AND conversation_id=? AND command_id=?')
      .get(payload.messageId, conversationId, held.command.id) as { parts: string } | undefined
    if (!row) fail('A message must start before its parts.', 400)
    const parts = JSON.parse(row.parts) as Array<Record<string, unknown>>
    if (payload.type === 'tool') {
      const index = parts.findIndex((part) => part.id === payload.part.id)
      if (index >= 0) parts[index] = { ...payload.part }
      else parts.push({ ...payload.part })
    } else {
      const index = parts.findIndex((part) => part.id === payload.partId)
      const previous = parts[index]
      if (previous && previous.type !== payload.kind) fail('Message part type changed.', 400)
      const text = ((previous?.text as string) ?? '') + payload.delta
      if (text.length > 1_000_000) fail('Message size limit reached.', 413)
      const part = { id: payload.partId, type: payload.kind, text }
      if (index >= 0) parts[index] = part
      else parts.push(part)
    }
    if (parts.length > 1000) fail('Message part limit reached.', 413)
    db().prepare('UPDATE bot_local_messages SET parts=? WHERE id=?').run(JSON.stringify(parts), payload.messageId)
  }

  /** Appends one durable event and returns its sequence. */
  private appendEvent(
    conversationId: string,
    payload: BotEventPayload,
    eventId: string,
    commandId: string | null
  ): number {
    const row = this.conversationRow(conversationId)
    if (!row) fail('Conversation not found.', 404)
    const sequence = Number(row.event_sequence) + 1
    const now = this.clock()
    db()
      .prepare('UPDATE bot_local_conversations SET event_sequence=?,updated_at=? WHERE id=?')
      .run(sequence, now, conversationId)
    db()
      .prepare(
        `INSERT INTO bot_local_events(conversation_id,sequence,event_id,command_id,payload,created_at)
         VALUES(?,?,?,?,?,?)`
      )
      .run(conversationId, sequence, eventId, commandId, JSON.stringify(payload), now)
    return sequence
  }
}

export const localBotService = new LocalBotService()
