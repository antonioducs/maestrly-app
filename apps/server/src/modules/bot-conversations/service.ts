import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  botCommandSchema,
  botConnectionSchema,
  botConversationEventSchema,
  botConversationSchema,
  botDesktopSchema,
  botGrantSchema,
  botInventorySchema,
  botMessageSchema,
  botQuestionSchema,
  parseBotCommandPayload,
  type BotAction,
  type BotCommand,
  type BotCommandKind,
  type BotConnection,
  type BotConversation,
  type BotConversationEvent,
  type BotConversationSnapshot,
  type BotDesktop,
  type BotEventPayload,
  type BotGrant,
  type BotInventory,
  type BotMessage,
  type BotQuestion,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'

/**
 * Personal bot conversations: the owner, their desktop and the bot connection are the only scopes. There
 * is no organization, project, board, card or runner here, so this module keeps its own transaction
 * context, its own idempotency ledger and its own authorization instead of borrowing the tenant ones.
 */
export class BotAuthorizationError extends Error {
  readonly statusCode: number
  constructor(message = 'The bot is not authorized for this action.', statusCode = 403) {
    super(message)
    this.name = 'BotAuthorizationError'
    this.statusCode = statusCode
  }
}

export function botFail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode })
}

export const DESKTOP_ONLINE_WINDOW_MS = 90_000
export const BOT_LEASE_SECONDS = 60
const hash = (value: string) => createHash('sha256').update(value).digest()

/**
 * `bot_desktop_auth` and `bot_connection_auth` are the narrow bootstrap contexts used to verify a device
 * credential or resolve the connection behind a token; neither can read a conversation.
 */
export type BotActor =
  | { type: 'bot_owner'; userId: string }
  | { type: 'bot_desktop'; userId: string; desktopId: string }
  | { type: 'bot_connection'; userId: string; connectionId: string; desktopId: string }
  | { type: 'bot_desktop_auth'; desktopId: string }
  | { type: 'bot_connection_auth'; userId: string }

const actorUser = (actor: BotActor) => ('userId' in actor ? actor.userId : '')

export async function setBotActor(client: DatabaseClient, actor: BotActor): Promise<void> {
  await client.query("select set_config('app.actor',$1,true),set_config('app.user_id',$2,true)", [
    JSON.stringify(actor),
    actorUser(actor),
  ])
}

export async function botTransaction<T>(
  pool: DatabasePool,
  actor: BotActor,
  operation: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    // No tenant is involved; clearing the tenant keys keeps a pooled connection from leaking one.
    await client.query("select set_config('app.organization_id','',true),set_config('app.project_id','',true)")
    await setBotActor(client, actor)
    await client.query("set local statement_timeout = '10s'")
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export class BotIdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with different content.')
    this.name = 'BotIdempotencyConflictError'
  }
}

function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify({ method, path, body }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex')
}

/**
 * Durable idempotency for a personal actor. The advisory lock serializes concurrent retries and the
 * record commits with the work it describes, so a replay can never observe a half-applied command.
 */
export async function executeBotIdempotent<T>(
  pool: DatabasePool,
  input: {
    actor: BotActor
    ownerUserId: string
    actorId: string
    key: string
    method: string
    path: string
    body: unknown
  },
  operation: (client: DatabaseClient) => Promise<{ status: number; body: T }>,
  authorize?: (client: DatabaseClient) => Promise<void>
): Promise<{ status: number; body: T; replayed: boolean }> {
  return botTransaction(pool, input.actor, async (client) => {
    await authorize?.(client)
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `bot:${input.ownerUserId}:${input.actorId}:${input.key}`,
    ])
    const digest = requestHash(input.method, input.path, input.body)
    const inserted = await client.query(
      `insert into bot_idempotency_records(owner_user_id,actor_id,idempotency_key,request_hash,response_status,response_body,expires_at)
       values($1,$2,$3,$4,0,'{}'::jsonb, now() + interval '24 hours')
       on conflict (owner_user_id,actor_id,idempotency_key) do nothing returning idempotency_key`,
      [input.ownerUserId, input.actorId, input.key, digest]
    )
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ request_hash: string; response_status: number; response_body: T }>(
        'select request_hash,response_status,response_body from bot_idempotency_records where owner_user_id=$1 and actor_id=$2 and idempotency_key=$3',
        [input.ownerUserId, input.actorId, input.key]
      )
      const row = existing.rows[0]
      if (!row || row.request_hash !== digest) throw new BotIdempotencyConflictError()
      return { status: Number(row.response_status), body: row.response_body, replayed: true }
    }
    const result = await operation(client)
    await client.query(
      'update bot_idempotency_records set response_status=$4,response_body=$5 where owner_user_id=$1 and actor_id=$2 and idempotency_key=$3',
      [input.ownerUserId, input.actorId, input.key, result.status, JSON.stringify(result.body)]
    )
    return { ...result, replayed: false }
  })
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

export function mapBotDesktop(row: Record<string, any>): BotDesktop {
  const parsed = row.inventory ? botInventorySchema.safeParse(row.inventory) : null
  const seen = row.last_seen_at instanceof Date ? row.last_seen_at.getTime() : 0
  return botDesktopSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    online: !row.revoked_at && Date.now() - seen < DESKTOP_ONLINE_WINDOW_MS,
    lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at),
    inventory: parsed?.success ? parsed.data : null,
    createdAt: row.created_at.toISOString(),
  })
}

export function mapBotConnection(row: Record<string, any>, grants: BotGrant[]): BotConnection {
  return botConnectionSchema.parse({
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    desktopId: row.desktop_id,
    clientId: row.client_id,
    grants,
    revokedAt: iso(row.revoked_at),
    version: Number(row.version),
  })
}

export function mapBotConversation(row: Record<string, any>): BotConversation {
  return botConversationSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    desktopId: row.desktop_id,
    workspaceId: row.workspace_id,
    name: row.name,
    baseBranch: row.base_branch,
    selection: row.selection,
    managementState: row.management_state,
    version: Number(row.version),
  })
}

/** `includeLease` is true only for the desktop that just claimed the command; a bot never sees the token. */
export function mapBotCommand(row: Record<string, any>, includeLease = false): BotCommand {
  return botCommandSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    ...(includeLease ? { leaseToken: row.lease_token ?? null } : {}),
    version: Number(row.version),
  })
}

export function mapBotMessage(row: Record<string, any>): BotMessage {
  return botMessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    commandId: row.command_id ?? null,
    role: row.role,
    parts: row.parts,
    createdAt: row.created_at.toISOString(),
  })
}

export function mapBotQuestion(row: Record<string, any>): BotQuestion {
  return botQuestionSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    commandId: row.command_id,
    questions: row.questions,
    state: row.state,
    answers: row.answers ?? null,
    createdAt: row.created_at.toISOString(),
  })
}

export function mapBotEvent(row: Record<string, any>): BotConversationEvent {
  return botConversationEventSchema.parse({
    version: 1,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    eventId: row.event_id,
    payload: row.payload,
  })
}

export async function readBotGrants(client: DatabaseClient, connectionId: string): Promise<BotGrant[]> {
  const rows = await client.query<{ workspace_id: string; actions: unknown }>(
    'select workspace_id,actions from bot_connection_grants where connection_id=$1 order by workspace_id',
    [connectionId]
  )
  return rows.rows.map((row) => botGrantSchema.parse({ workspaceId: row.workspace_id, actions: row.actions }))
}

/** Appends one durable event and returns its sequence. Callers must already hold the conversation row. */
export async function appendBotEvent(
  client: DatabaseClient,
  conversation: { id: string; ownerUserId: string; connectionId: string; desktopId: string },
  payload: BotEventPayload,
  eventId: string,
  commandId: string | null
): Promise<number> {
  const bumped = await client.query<{ event_sequence: string }>(
    'update bot_conversations set event_sequence=event_sequence+1,updated_at=now() where id=$1 returning event_sequence',
    [conversation.id]
  )
  const sequence = Number(bumped.rows[0]!.event_sequence)
  await client.query(
    `insert into bot_conversation_events(conversation_id,owner_user_id,connection_id,desktop_id,command_id,sequence,event_id,payload)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      conversation.id,
      conversation.ownerUserId,
      conversation.connectionId,
      conversation.desktopId,
      commandId,
      sequence,
      eventId,
      JSON.stringify(payload),
    ]
  )
  return sequence
}

export interface BotDesktopIdentity {
  desktopId: string
  ownerUserId: string
}

/** The credential is returned once here and must only ever be stored by the desktop main process. */
export async function registerBotDesktop(
  client: DatabaseClient,
  input: { userId: string; name: string; credentialSecret?: string }
): Promise<{ desktop: BotDesktop; credential: string }> {
  const id = randomUUID()
  const credential = input.credentialSecret ? deriveBotDesktopCredential(input.credentialSecret, input.userId, id) : randomBytes(32).toString('base64url')
  const created = await client.query(
    'insert into bot_desktops(id,owner_user_id,name,credential_hash) values($1,$2,$3,$4) returning *',
    [id, input.userId, input.name, hash(credential)]
  )
  return { desktop: mapBotDesktop(created.rows[0]!), credential }
}

/** Recreate an authorized registration response without storing the device secret in the SQL ledger. */
export function deriveBotDesktopCredential(secret: string, ownerUserId: string, desktopId: string): string {
  return createHmac('sha256', secret).update(`maestrly-bot-desktop-v1\0${ownerUserId}\0${desktopId}`).digest('base64url')
}

export async function listBotDesktops(pool: DatabasePool, userId: string): Promise<BotDesktop[]> {
  return botTransaction(pool, { type: 'bot_owner', userId }, async (client) => {
    const rows = await client.query('select * from bot_desktops where owner_user_id=$1 order by created_at desc', [
      userId,
    ])
    return rows.rows.map(mapBotDesktop)
  })
}

/** Revoking a desktop stops its claims and every connection that targets it, immediately. */
export async function revokeBotDesktop(client: DatabaseClient, scope: { userId: string; desktopId: string }) {
  const found = await client.query('select * from bot_desktops where id=$1 and owner_user_id=$2 for update', [
    scope.desktopId,
    scope.userId,
  ])
  if (!found.rowCount) botFail('Desktop not found.', 404)
  const updated = await client.query(
    'update bot_desktops set revoked_at=coalesce(revoked_at,now()),updated_at=now() where id=$1 returning *',
    [scope.desktopId]
  )
  await client.query(
    "update bot_connections set revoked_at=coalesce(revoked_at,now()),version=version+1,updated_at=now() where desktop_id=$1 and revoked_at is null",
    [scope.desktopId]
  )
  await client.query(
    "update bot_conversations set management_state='revoked',version=version+1,updated_at=now() where desktop_id=$1 and management_state<>'revoked'",
    [scope.desktopId]
  )
  await client.query(
    "update bot_commands set status='cancelled',lease_token=null,completed_at=now(),version=version+1 where desktop_id=$1 and status in ('queued','leased')",
    [scope.desktopId]
  )
  return mapBotDesktop(updated.rows[0]!)
}

/** Resolves a device credential to its owner. Runs in the narrow bootstrap context, which reads no chat. */
export async function verifyBotDesktopCredential(
  pool: DatabasePool,
  input: { desktopId: string; credential: string }
): Promise<BotDesktopIdentity | null> {
  return botTransaction(pool, { type: 'bot_desktop_auth', desktopId: input.desktopId }, async (client) => {
    const rows = await client.query<{ owner_user_id: string }>(
      'select owner_user_id from bot_desktops where id=$1 and credential_hash=$2 and revoked_at is null',
      [input.desktopId, hash(input.credential)]
    )
    const row = rows.rows[0]
    return row ? { desktopId: input.desktopId, ownerUserId: row.owner_user_id } : null
  })
}

export async function saveBotInventory(
  pool: DatabasePool,
  identity: BotDesktopIdentity,
  inventory: BotInventory
): Promise<void> {
  await botTransaction(
    pool,
    { type: 'bot_desktop', userId: identity.ownerUserId, desktopId: identity.desktopId },
    async (client) => {
      const updated = await client.query(
        'update bot_desktops set inventory=$2,last_seen_at=now(),updated_at=now() where id=$1 and revoked_at is null returning id',
        [identity.desktopId, JSON.stringify(inventory)]
      )
      if (!updated.rowCount) botFail('This desktop is revoked.', 403)
    }
  )
}

export async function touchBotDesktop(client: DatabaseClient, desktopId: string): Promise<void> {
  await client.query('update bot_desktops set last_seen_at=now() where id=$1', [desktopId])
}

export interface BotOAuthResources {
  mcpResource: string
  apiResource: string
  instanceName: string
}

/**
 * Narrow a bot OAuth client to the bot MCP resource. It keeps no link to the REST audience, so its tokens
 * can never act on `/api/v1` with the owner's full authority, and it is a different audience from the
 * organization connector endpoint, so neither token is accepted by the other.
 */
export async function bindBotClientResource(
  pool: DatabasePool,
  input: { clientId: string; userId: string; resources: BotOAuthResources }
): Promise<void> {
  const registered = await pool.query('select "userId",disabled from "oauthClient" where "clientId"=$1', [input.clientId])
  if (!registered.rowCount || registered.rows[0].userId !== input.userId || registered.rows[0].disabled)
    botFail('Use an enabled OAuth client registered by your account.', 403)
  const otherResources = await pool.query('select 1 from "oauthClientResource" where "clientId"=$1 and "resourceId"<>$2', [input.clientId, input.resources.mcpResource])
  if (otherResources.rowCount) botFail('Register a dedicated bot OAuth client; an existing desktop or application client cannot be rebound.', 400)
  await pool.query(
    'insert into "oauthResource"(id,identifier,name,"createdAt",disabled) values($1,$2,$3,now(),false) on conflict(identifier) do nothing',
    [randomUUID(), input.resources.mcpResource, `${input.resources.instanceName} bots`]
  )
  await pool.query(
    'insert into "oauthClientResource"(id,"clientId","resourceId","createdAt") select $1,$2,$3,now() where not exists(select 1 from "oauthClientResource" where "clientId"=$2 and "resourceId"=$3)',
    [randomUUID(), input.clientId, input.resources.mcpResource]
  )
}

export const BOT_CLIENT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api:read', 'api:write'] as const

/** Registers the public native client a personal bot authorizes with, already narrowed to /mcp/bots. */
export async function registerBotOAuthClient(
  pool: DatabasePool,
  input: { name: string; userId: string; resources: BotOAuthResources }
): Promise<string> {
  const clientId = 'maestrly-bot-' + randomUUID()
  await pool.query(
    `insert into "oauthClient"(id,"clientId",name,"applicationType","tokenEndpointAuthMethod","grantTypes","redirectUris",scopes,disabled,"skipConsent","createdAt","updatedAt","userId")
     values($1,$1,$2,'native','none',$3::jsonb,'[]'::jsonb,$4::jsonb,false,false,now(),now(),$5)`,
    [
      clientId,
      input.name.slice(0, 160),
      JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']),
      JSON.stringify(BOT_CLIENT_SCOPES),
      input.userId,
    ]
  )
  await bindBotClientResource(pool, { clientId, userId: input.userId, resources: input.resources })
  return clientId
}

function assertGrantedWorkspaces(desktop: BotDesktop, grants: BotGrant[]): void {
  if (!desktop.inventory) return
  const known = new Set(desktop.inventory.workspaces.map((workspace) => workspace.workspaceId))
  for (const grant of grants)
    if (!known.has(grant.workspaceId)) botFail(`This desktop does not expose workspace ${grant.workspaceId}.`, 400)
}

export async function createBotConnection(
  client: DatabaseClient,
  scope: { userId: string },
  input: { name: string; desktopId: string; grants: BotGrant[]; clientId: string }
): Promise<BotConnection> {
  const desktopRow = await client.query('select * from bot_desktops where id=$1 and owner_user_id=$2', [
    input.desktopId,
    scope.userId,
  ])
  if (!desktopRow.rowCount) botFail('Desktop not found.', 404)
  const desktop = mapBotDesktop(desktopRow.rows[0]!)
  if (desktop.revokedAt) botFail('This desktop is revoked.', 409)
  assertGrantedWorkspaces(desktop, input.grants)
  const existing = await client.query('select id from bot_connections where owner_user_id=$1 and client_id=$2', [
    scope.userId,
    input.clientId,
  ])
  if (existing.rowCount) botFail('This client is already connected for your account.')
  const created = await client.query(
    'insert into bot_connections(owner_user_id,desktop_id,client_id,name) values($1,$2,$3,$4) returning *',
    [scope.userId, input.desktopId, input.clientId, input.name]
  )
  const row = created.rows[0]!
  for (const grant of input.grants)
    await client.query(
      'insert into bot_connection_grants(connection_id,owner_user_id,desktop_id,workspace_id,actions) values($1,$2,$3,$4,$5)',
      [row.id, scope.userId, input.desktopId, grant.workspaceId, JSON.stringify(grant.actions)]
    )
  return mapBotConnection(row, await readBotGrants(client, row.id))
}

export async function listBotConnections(pool: DatabasePool, userId: string): Promise<BotConnection[]> {
  return botTransaction(pool, { type: 'bot_owner', userId }, async (client) => {
    const rows = await client.query('select * from bot_connections where owner_user_id=$1 order by created_at desc', [
      userId,
    ])
    const connections: BotConnection[] = []
    for (const row of rows.rows) connections.push(mapBotConnection(row, await readBotGrants(client, row.id)))
    return connections
  })
}

export async function patchBotConnection(
  client: DatabaseClient,
  scope: { userId: string; connectionId: string },
  input: { expectedVersion: number; name?: string; grants?: BotGrant[]; revoked?: boolean }
): Promise<BotConnection> {
  const found = await client.query(
    'select * from bot_connections where id=$1 and owner_user_id=$2 for update',
    [scope.connectionId, scope.userId]
  )
  const current = found.rows[0]
  if (!current) botFail('Connection not found.', 404)
  if (Number(current.version) !== input.expectedVersion) botFail('The connection changed after it was loaded.')
  if (input.grants) {
    const desktopRow = await client.query('select * from bot_desktops where id=$1', [current.desktop_id])
    assertGrantedWorkspaces(mapBotDesktop(desktopRow.rows[0]!), input.grants)
  }
  const revokedAt = input.revoked === undefined ? undefined : input.revoked ? new Date() : null
  const updated = await client.query(
    `update bot_connections set name=coalesce($3,name),
       revoked_at=case when $4::boolean then $5::timestamptz else revoked_at end,
       version=version+1,updated_at=now()
     where id=$1 and owner_user_id=$2 returning *`,
    [scope.connectionId, scope.userId, input.name ?? null, revokedAt !== undefined, revokedAt ?? null]
  )
  if (input.grants) {
    await client.query('delete from bot_connection_grants where connection_id=$1', [scope.connectionId])
    for (const grant of input.grants)
      await client.query(
        'insert into bot_connection_grants(connection_id,owner_user_id,desktop_id,workspace_id,actions) values($1,$2,$3,$4,$5)',
        [scope.connectionId, scope.userId, current.desktop_id, grant.workspaceId, JSON.stringify(grant.actions)]
      )
  }
  // Revocation cuts every claim and replay of this connection in the same transaction.
  if (revokedAt) {
    await client.query(
      "update bot_conversations set management_state='revoked',version=version+1,updated_at=now() where connection_id=$1 and management_state<>'revoked'",
      [scope.connectionId]
    )
    await client.query(
      "update bot_commands set status='cancelled',lease_token=null,completed_at=now(),version=version+1 where connection_id=$1 and status in ('queued','leased')",
      [scope.connectionId]
    )
  }
  return mapBotConnection(updated.rows[0]!, await readBotGrants(client, scope.connectionId))
}

export interface BotPrincipal {
  userId: string
  connectionId: string
  desktopId: string
  clientId: string
  connectionName: string
  scopes: string[]
  grants: BotGrant[]
}

export function botActorOf(principal: BotPrincipal): BotActor {
  return {
    type: 'bot_connection',
    userId: principal.userId,
    connectionId: principal.connectionId,
    desktopId: principal.desktopId,
  }
}

/**
 * Resolve the live connection behind a verified token. Returns null when it is missing or revoked so the
 * caller answers 401/403 without revealing whether a client id exists.
 */
export async function loadBotConnectionForToken(
  pool: DatabasePool,
  input: { userId: string; clientId: string }
): Promise<Omit<BotPrincipal, 'scopes' | 'clientId' | 'userId'> | null> {
  return botTransaction(pool, { type: 'bot_connection_auth', userId: input.userId }, async (client) => {
    const rows = await client.query(
      `select c.* from bot_connections c join bot_desktops d on d.id=c.desktop_id
       where c.owner_user_id=$1 and c.client_id=$2 and c.revoked_at is null and d.revoked_at is null`,
      [input.userId, input.clientId]
    )
    const row = rows.rows[0]
    if (!row) return null
    await client.query('update bot_connections set last_used_at=now() where id=$1', [row.id])
    await setBotActor(client, {
      type: 'bot_connection',
      userId: input.userId,
      connectionId: row.id,
      desktopId: row.desktop_id,
    })
    return {
      connectionId: row.id,
      desktopId: row.desktop_id,
      connectionName: row.name,
      grants: await readBotGrants(client, row.id),
    }
  })
}

export const actionForKind: Record<BotCommandKind, BotAction> = {
  create: 'chats:write',
  send: 'chats:write',
  configure: 'chats:write',
  cancel: 'chats:control',
  answer: 'chats:answer',
}

/** Rechecks the persisted grant, the connection and the desktop on every call, replays included. */
export async function assertBotGrant(
  client: DatabaseClient,
  principal: BotPrincipal,
  workspaceId: string,
  action: BotAction
): Promise<void> {
  const local = principal.grants.find((grant) => grant.workspaceId === workspaceId)
  if (!local?.actions.includes(action))
    throw new BotAuthorizationError(`The connection is not authorized for ${action} on this workspace.`)
  const live = await client.query<{ actions: unknown }>(
    `select g.actions from bot_connection_grants g
     join bot_connections c on c.id=g.connection_id
     join bot_desktops d on d.id=c.desktop_id
     where g.connection_id=$1 and g.workspace_id=$2 and c.revoked_at is null and d.revoked_at is null`,
    [principal.connectionId, workspaceId]
  )
  const actions = live.rows[0]
    ? botGrantSchema.parse({ workspaceId, actions: live.rows[0].actions }).actions
    : ([] as BotAction[])
  if (!actions.includes(action)) throw new BotAuthorizationError('The connection grant was changed or revoked.')
}

export async function authorizeBotAction(
  pool: DatabasePool,
  principal: BotPrincipal,
  workspaceId: string,
  action: BotAction
): Promise<void> {
  await botTransaction(pool, botActorOf(principal), (client) => assertBotGrant(client, principal, workspaceId, action))
}

export async function authorizeBotConversationAction(
  client: DatabaseClient, principal: BotPrincipal, conversationId: string, action: BotAction
): Promise<void> {
  const row = await client.query('select workspace_id from bot_conversations where id=$1 and connection_id=$2', [conversationId, principal.connectionId])
  if (!row.rowCount) botFail('Conversation not found.', 404)
  await assertBotGrant(client, principal, row.rows[0].workspace_id, action)
}

/** The desktop and the workspaces this connection can currently reach, with its live actions. */
export async function botDesktopView(pool: DatabasePool, principal: BotPrincipal) {
  return botTransaction(pool, botActorOf(principal), async (client) => {
    const rows = await client.query('select * from bot_desktops where id=$1', [principal.desktopId])
    if (!rows.rowCount) botFail('The desktop for this connection is gone.', 409)
    const desktop = mapBotDesktop(rows.rows[0]!)
    const grants = await readBotGrants(client, principal.connectionId)
    const inventory = desktop.inventory
    const workspaces = grants
      .map((grant) => {
        const workspace = inventory?.workspaces.find((item) => item.workspaceId === grant.workspaceId)
        return workspace ? { ...workspace, actions: grant.actions } : null
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    return {
      desktop: { id: desktop.id, name: desktop.name, online: desktop.online },
      workspaces,
      selections: inventory?.selections ?? [],
    }
  })
}

async function lockBotConversation(client: DatabaseClient, principal: BotPrincipal, conversationId: string) {
  const rows = await client.query('select * from bot_conversations where id=$1 and connection_id=$2 for update', [
    conversationId,
    principal.connectionId,
  ])
  const row = rows.rows[0]
  // A conversation of another bot, or of the person's own desktop, is simply not found here.
  if (!row) botFail('Conversation not found.', 404)
  if (row.management_state === 'paused')
    botFail('This conversation is paused by its owner; only the owner can resume it.', 409)
  if (row.management_state === 'revoked') botFail('This conversation was revoked.', 409)
  return row
}

async function insertBotCommand(
  client: DatabaseClient,
  conversation: Record<string, any>,
  kind: BotCommandKind,
  payload: Record<string, unknown>
): Promise<BotCommand> {
  const bumped = await client.query<{ command_sequence: string }>(
    'update bot_conversations set command_sequence=command_sequence+1,updated_at=now() where id=$1 returning command_sequence',
    [conversation.id]
  )
  const created = await client.query(
    `insert into bot_commands(owner_user_id,connection_id,desktop_id,conversation_id,kind,payload,sequence)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      conversation.owner_user_id,
      conversation.connection_id,
      conversation.desktop_id,
      conversation.id,
      kind,
      JSON.stringify(payload),
      Number(bumped.rows[0]!.command_sequence),
    ]
  )
  const command = mapBotCommand(created.rows[0]!)
  await appendBotEvent(
    client,
    {
      id: conversation.id,
      ownerUserId: conversation.owner_user_id,
      connectionId: conversation.connection_id,
      desktopId: conversation.desktop_id,
    },
    { type: 'command', command },
    'command-queued-' + command.id,
    command.id
  )
  return command
}

export async function createBotConversation(
  client: DatabaseClient,
  principal: BotPrincipal,
  payload: Record<string, unknown>
): Promise<{ conversation: BotConversation; command: BotCommand }> {
  const input = parseBotCommandPayload('create', payload) as {
    workspaceId: string
    name: string
    baseBranch: string
    selection: Record<string, unknown>
    message: string | null
  }
  await assertBotGrant(client, principal, input.workspaceId, 'chats:write')
  const created = await client.query(
    `insert into bot_conversations(owner_user_id,connection_id,desktop_id,workspace_id,name,base_branch,selection)
     values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      principal.userId,
      principal.connectionId,
      principal.desktopId,
      input.workspaceId,
      input.name,
      input.baseBranch,
      JSON.stringify(input.selection),
    ]
  )
  const row = created.rows[0]!
  const conversation = mapBotConversation(row)
  await appendBotEvent(
    client,
    {
      id: row.id,
      ownerUserId: row.owner_user_id,
      connectionId: row.connection_id,
      desktopId: row.desktop_id,
    },
    { type: 'conversation', conversation },
    'conversation-created-' + row.id,
    null
  )
  const command = await insertBotCommand(client, row, 'create', input as unknown as Record<string, unknown>)
  return { conversation, command }
}

export async function enqueueBotCommand(
  client: DatabaseClient,
  principal: BotPrincipal,
  input: { conversationId: string; kind: Exclude<BotCommandKind, 'create'>; payload: unknown }
): Promise<{ conversation: BotConversation; command: BotCommand }> {
  const payload = parseBotCommandPayload(input.kind, input.payload)
  const row = await lockBotConversation(client, principal, input.conversationId)
  await assertBotGrant(client, principal, row.workspace_id, actionForKind[input.kind])
  if (input.kind === 'answer') {
    const question = await client.query(
      'select state from bot_questions where id=$1 and conversation_id=$2',
      [payload.questionId as string, row.id]
    )
    if (!question.rowCount) botFail('Question not found.', 404)
    if (question.rows[0]!.state !== 'pending') botFail('This question was already answered or expired.')
  }
  if (input.kind === 'cancel') {
    const queued = await client.query(
      "select id from bot_commands where conversation_id=$1 and kind='cancel' and status='queued'",
      [row.id]
    )
    if (queued.rowCount)
      return { conversation: mapBotConversation(row), command: mapBotCommand((await client.query('select * from bot_commands where id=$1', [queued.rows[0]!.id])).rows[0]!) }
  }
  return { conversation: mapBotConversation(row), command: await insertBotCommand(client, row, input.kind, payload) }
}

export async function listBotConversations(pool: DatabasePool, principal: BotPrincipal): Promise<BotConversation[]> {
  return botTransaction(pool, botActorOf(principal), async (client) => {
    const rows = await client.query(
      `select cv.* from bot_conversations cv join bot_connection_grants g on g.connection_id=cv.connection_id and g.workspace_id=cv.workspace_id
       join bot_connections c on c.id=cv.connection_id join bot_desktops d on d.id=cv.desktop_id
       where cv.connection_id=$1 and g.actions ? 'chats:read' and c.revoked_at is null and d.revoked_at is null
       order by cv.updated_at desc limit 200`,
      [principal.connectionId]
    )
    return rows.rows.map(mapBotConversation)
  })
}

export async function readBotConversation(
  pool: DatabasePool,
  principal: BotPrincipal,
  conversationId: string
): Promise<BotConversationSnapshot> {
  return botTransaction(pool, botActorOf(principal), async (client) => {
    const rows = await client.query('select * from bot_conversations where id=$1 and connection_id=$2', [
      conversationId,
      principal.connectionId,
    ])
    const row = rows.rows[0]
    if (!row) botFail('Conversation not found.', 404)
    await assertBotGrant(client, principal, row.workspace_id, 'chats:read')
    const messages = await client.query(
      'select * from bot_messages where conversation_id=$1 order by created_at,id limit 500',
      [conversationId]
    )
    const questions = await client.query(
      'select * from bot_questions where conversation_id=$1 order by created_at limit 100',
      [conversationId]
    )
    const pending = await client.query(
      "select * from bot_commands where conversation_id=$1 and status in ('queued','leased') order by sequence limit 1",
      [conversationId]
    )
    const attention = await client.query("select payload->'attention' as attention from bot_conversation_events where conversation_id=$1 and payload->>'type'='owner-attention' order by sequence desc limit 1", [conversationId])
    return {
      conversation: mapBotConversation(row),
      messages: messages.rows.map(mapBotMessage),
      questions: questions.rows.map(mapBotQuestion),
      pendingCommand: pending.rows[0] ? mapBotCommand(pending.rows[0]) : null,
      cursor: Number(row.event_sequence),
      ownerAttention: attention.rows[0]?.attention ?? null,
    }
  })
}

export async function readBotEvents(
  pool: DatabasePool,
  principal: BotPrincipal,
  input: { conversationId: string; cursor: number; limit?: number }
): Promise<BotConversationEvent[]> {
  return botTransaction(pool, botActorOf(principal), async (client) => {
    await authorizeBotConversationAction(client, principal, input.conversationId, 'chats:read')
    const owned = await client.query('select 1 from bot_conversations where id=$1 and connection_id=$2', [
      input.conversationId,
      principal.connectionId,
    ])
    if (!owned.rowCount) botFail('Conversation not found.', 404)
    const rows = await client.query(
      'select * from bot_conversation_events where conversation_id=$1 and sequence>$2 order by sequence limit $3',
      [input.conversationId, input.cursor, Math.min(Math.max(input.limit ?? 200, 1), 500)]
    )
    return rows.rows.map(mapBotEvent)
  })
}

/** Long-poll bounded by BOT_WAIT_MAX_SECONDS so a relayed bot turn never hangs on an open request. */
export async function waitBotEvents(
  pool: DatabasePool,
  principal: BotPrincipal,
  input: { conversationId: string; cursor: number; timeoutSeconds: number; signal?: AbortSignal }
) {
  const deadline = Date.now() + Math.min(Math.max(input.timeoutSeconds, 0), 20) * 1000
  for (;;) {
    const events = await readBotEvents(pool, principal, { conversationId: input.conversationId, cursor: input.cursor })
    if (events.length)
      return {
        conversationId: input.conversationId,
        cursor: events[events.length - 1]!.sequence,
        events,
        timedOut: false,
      }
    if (Date.now() >= deadline || input.signal?.aborted)
      return { conversationId: input.conversationId, cursor: input.cursor, events: [], timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

/** Owner-only lifecycle. A bot can never move a conversation out of `paused`. */
export async function setBotConversationManagement(
  client: DatabaseClient,
  scope: { userId: string; conversationId: string },
  input: { expectedVersion: number; state: 'active' | 'paused' | 'revoked' }
): Promise<BotConversation> {
  const actor = await client.query<{ type: string | null }>(
    "select nullif(current_setting('app.actor',true),'')::jsonb->>'type' as type"
  )
  if (actor.rows[0]?.type !== 'bot_owner')
    throw new BotAuthorizationError('Only the owner can pause, resume or revoke a conversation.')
  const found = await client.query('select * from bot_conversations where id=$1 and owner_user_id=$2 for update', [
    scope.conversationId,
    scope.userId,
  ])
  const current = found.rows[0]
  if (!current) botFail('Conversation not found.', 404)
  if (Number(current.version) !== input.expectedVersion) botFail('The conversation changed after it was loaded.')
  if (current.management_state === 'revoked' && input.state !== 'revoked')
    botFail('A revoked conversation cannot be reactivated.')
  const updated = await client.query(
    'update bot_conversations set management_state=$2,version=version+1,updated_at=now() where id=$1 returning *',
    [scope.conversationId, input.state]
  )
  if (input.state === 'revoked')
    await client.query(
      "update bot_commands set status='cancelled',lease_token=null,completed_at=now(),version=version+1 where conversation_id=$1 and status in ('queued','leased')",
      [scope.conversationId]
    )
  const conversation = mapBotConversation(updated.rows[0]!)
  await appendBotEvent(client, { id: current.id, ownerUserId: current.owner_user_id, connectionId: current.connection_id, desktopId: current.desktop_id },
    { type: 'owner-attention', attention: null }, 'owner-attention-reset-' + conversation.version + '-' + conversation.id, null)
  await appendBotEvent(
    client,
    {
      id: current.id,
      ownerUserId: current.owner_user_id,
      connectionId: current.connection_id,
      desktopId: current.desktop_id,
    },
    { type: 'conversation', conversation },
    'management-' + conversation.version + '-' + conversation.id,
    null
  )
  return conversation
}

export async function listOwnerBotConversations(pool: DatabasePool, userId: string): Promise<BotConversation[]> {
  return botTransaction(pool, { type: 'bot_owner', userId }, async (client) => {
    const rows = await client.query(
      'select * from bot_conversations where owner_user_id=$1 order by updated_at desc limit 500',
      [userId]
    )
    return rows.rows.map(mapBotConversation)
  })
}
