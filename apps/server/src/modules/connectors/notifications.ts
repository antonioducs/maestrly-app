/**
 * Durable notifications to an external agent routine (for example a Grok Bot routine).
 *
 * Maestrly never holds a connection open to a bot. When something a person would care about happens, a row
 * is written in the same transaction as the delegation event that caused it, and a delivery loop posts it
 * afterwards. Delivery is at-least-once and signed over the exact bytes sent; the receiver deduplicates on
 * `eventId`. An endpoint only ever hears about projects its connection was granted.
 */
import { createHmac } from 'node:crypto'
import {
  connectorNotificationEndpointSchema,
  connectorNotificationPayloadSchema,
  type ConnectorNotificationEndpoint,
  type ConnectorNotificationEndpointInput,
  type ConnectorNotificationPayload,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { delegationLinks } from '../delegations/links.js'
import { connectorFail } from './grants.js'
import { postOutboundJson, resolveOutboundTarget, type OutboundResponse } from './outbound.js'
import { SecretVault, fingerprintOfSecret, parseSecretKeys } from './secrets.js'

/**
 * Events worth waking an external agent for. Progress noise (a stage starting, a poll observing the same
 * pull request) is deliberately absent: a routine should be woken by decisions and outcomes.
 */
export const NOTIFIED_EVENT_TYPES = new Set([
  'task.completed',
  'task.needs_attention',
  'task.watching',
  'task.cancelled',
  'task.paused',
  'task.executor_unavailable',
  'task.command_unresolved',
  'review.recorded',
  'follow_up.planned',
  'delivery.settled',
  'dependency.satisfied',
])

/** One readable sentence per event; the payload keeps the structured data for anything more specific. */
export function summarizeDelegationEvent(type: string, data: Record<string, unknown>): string {
  const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : null)
  const number = (key: string) => (typeof data[key] === 'number' ? (data[key] as number) : null)
  switch (type) {
    case 'task.completed':
      return `The task reached its completion target (${text('completionTarget') ?? 'configured target'}).`
    case 'task.needs_attention': {
      const missing = Array.isArray(data.missing) ? (data.missing as Array<{ detail?: string }>) : []
      const detail = missing
        .map((item) => item.detail)
        .filter(Boolean)
        .join(' ')
      return detail ? `The task needs a decision: ${detail}`.slice(0, 2000) : 'The task needs a decision.'
    }
    case 'task.watching':
      return 'The work is done and the task is now watching its pull request.'
    case 'task.cancelled':
      return 'The task was cancelled.'
    case 'task.paused':
      return 'The task was paused.'
    case 'task.executor_unavailable':
      return 'The executor for this task is unavailable.'
    case 'task.command_unresolved':
      return `A command could not be applied: ${text('reason') ?? 'see the task for details'}.`
    case 'review.recorded':
      return `A review was recorded with verdict ${text('verdict') ?? 'unknown'}.`
    case 'follow_up.planned':
      return `A follow-up was planned after ${text('trigger') ?? 'an external event'}.`
    case 'delivery.settled': {
      const mode = text('mode') ?? 'delivery'
      const pullRequest = number('pullRequest')
      return pullRequest ? `Delivery ${mode} settled on pull request #${pullRequest}.` : `Delivery ${mode} settled.`
    }
    case 'dependency.satisfied':
      return 'A task this one depends on has completed.'
    default:
      return type
  }
}

/**
 * Queue one event for every endpoint entitled to hear it. Runs inside the caller's transaction, so a
 * notification cannot exist for an event that was rolled back, nor be lost for one that was committed.
 */
export async function enqueueConnectorNotifications(
  client: DatabaseClient,
  task: { id: string; organizationId: string; projectId: string },
  event: { id: string; sequence: number; type: string; data: Record<string, unknown> }
): Promise<number> {
  if (!NOTIFIED_EVENT_TYPES.has(event.type)) return 0
  const inserted = await client.query(
    `insert into connector_notifications(
       organization_id, project_id, endpoint_id, connection_id, task_id, event_id, sequence, type, data
     )
     select e.organization_id, $2, e.id, e.connection_id, $3, $4, $5, $6, $7::jsonb
     from connector_notification_endpoints e
     join connector_connections c on c.organization_id = e.organization_id and c.id = e.connection_id
     join connector_project_grants g
       on g.organization_id = e.organization_id and g.connection_id = e.connection_id and g.project_id = $2
     where e.organization_id = $1 and e.enabled and c.revoked_at is null and g.actions ? 'tasks:read'
     on conflict (endpoint_id, event_id) do nothing`,
    [task.organizationId, task.projectId, task.id, event.id, event.sequence, event.type, event.data]
  )
  return inserted.rowCount ?? 0
}

interface EndpointRow {
  id: string
  connection_id: string
  url: string
  enabled: boolean
  secret_fingerprint: string
  last_status: string | null
  last_delivered_at: Date | null
  failure_count: number
  created_at: Date
  updated_at: Date
}

function mapEndpoint(row: EndpointRow): ConnectorNotificationEndpoint {
  return connectorNotificationEndpointSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    url: row.url,
    enabled: row.enabled,
    secretFingerprint: row.secret_fingerprint,
    lastStatus: row.last_status,
    lastDeliveredAt: row.last_delivered_at ? row.last_delivered_at.toISOString() : null,
    failureCount: Number(row.failure_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  })
}

export interface EndpointScope {
  organizationId: string
  userId: string
  connectionId: string
}

/** The endpoint belongs to the connection, so only the person who owns that connection may change it. */
async function assertConnectionOwner(client: DatabaseClient, scope: EndpointScope) {
  const rows = await client.query(
    'select id from connector_connections where organization_id=$1 and id=$2 and owner_user_id=$3',
    [scope.organizationId, scope.connectionId, scope.userId]
  )
  if (!rows.rowCount) connectorFail('Connection not found.', 404)
}

export interface EndpointWriteOptions {
  secretKeys: string
  allowPrivateHosts: boolean
}

export async function setNotificationEndpoint(
  pool: DatabasePool,
  scope: EndpointScope,
  input: ConnectorNotificationEndpointInput,
  options: EndpointWriteOptions
): Promise<ConnectorNotificationEndpoint> {
  const vault = new SecretVault(parseSecretKeys(options.secretKeys))
  if (!vault.available) connectorFail('Configure MAESTRLY_SECRET_KEYS before storing a callback secret.', 503)
  // The URL is validated before it is stored, so an unusable endpoint is refused instead of retried forever.
  await resolveOutboundTarget(input.url, { allowPrivateHosts: options.allowPrivateHosts })
  const sealed = vault.seal(input.secret)
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await assertConnectionOwner(client, scope)
      const rows = await client.query<EndpointRow>(
        `insert into connector_notification_endpoints(
           organization_id, connection_id, url, secret_cipher, secret_nonce, secret_fingerprint, key_id,
           enabled, created_by_user_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (organization_id, connection_id) do update set
           url=excluded.url, secret_cipher=excluded.secret_cipher, secret_nonce=excluded.secret_nonce,
           secret_fingerprint=excluded.secret_fingerprint, key_id=excluded.key_id, enabled=excluded.enabled,
           failure_count=0, last_status=null, updated_at=now()
         returning *`,
        [
          scope.organizationId,
          scope.connectionId,
          input.url,
          sealed.cipher,
          sealed.nonce,
          fingerprintOfSecret(input.secret),
          sealed.keyId,
          input.enabled,
          scope.userId,
        ]
      )
      return mapEndpoint(rows.rows[0]!)
    }
  )
}

export async function getNotificationEndpoint(
  pool: DatabasePool,
  scope: EndpointScope
): Promise<ConnectorNotificationEndpoint | null> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await assertConnectionOwner(client, scope)
      const rows = await client.query<EndpointRow>(
        'select * from connector_notification_endpoints where organization_id=$1 and connection_id=$2',
        [scope.organizationId, scope.connectionId]
      )
      return rows.rows[0] ? mapEndpoint(rows.rows[0]) : null
    }
  )
}

export async function deleteNotificationEndpoint(pool: DatabasePool, scope: EndpointScope): Promise<void> {
  await inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await assertConnectionOwner(client, scope)
      await client.query(
        'delete from connector_notification_endpoints where organization_id=$1 and connection_id=$2',
        [scope.organizationId, scope.connectionId]
      )
    }
  )
}

/**
 * Signature over the exact bytes sent, bound to a timestamp so a captured delivery cannot be replayed
 * later. The receiver recomputes `HMAC-SHA256(secret, "<timestamp>.<body>")`.
 */
export function signNotification(input: { secret: string; timestamp: number; body: Buffer }): string {
  const digest = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.`)
    .update(input.body)
    .digest('hex')
  return `t=${input.timestamp},v1=${digest}`
}

/** Retry schedule in seconds; the last entry repeats until the attempt budget runs out. */
const BACKOFF_SECONDS = [30, 60, 120, 300, 900, 1_800, 3_600]
const MAX_ATTEMPTS = 8
const DEFAULT_TIMEOUT_MS = 10_000

function backoffSeconds(attempts: number): number {
  const base = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 3_600
  // Jitter keeps a fleet of failed deliveries from retrying in lockstep.
  return Math.max(5, Math.round(base * (0.8 + Math.random() * 0.4)))
}

interface ClaimedNotification {
  id: string
  project_id: string
  endpoint_id: string
  task_id: string
  event_id: string
  sequence: string
  type: string
  data: Record<string, unknown>
  attempts: number
  created_at: Date
}

export interface NotificationDeliveryOptions {
  webOrigin: string
  secretKeys: string
  allowPrivateHosts: boolean
  organizationId?: string
  limit?: number
  timeoutMs?: number
}

/** Deliver what is due. Returns how many notifications the receiver accepted in this pass. */
export async function deliverPendingNotifications(
  pool: DatabasePool,
  options: NotificationDeliveryOptions
): Promise<number> {
  const vault = new SecretVault(parseSecretKeys(options.secretKeys))
  if (!vault.available) return 0
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const organizations = options.organizationId
    ? [{ id: options.organizationId }]
    : (await pool.query<{ id: string }>('select id from organizations')).rows
  let delivered = 0
  for (const organization of organizations) {
    const system = { organizationId: organization.id, actor: { type: 'system' as const, service: 'connector-notifier' } }
    // A claim that outlived its lease is reclaimed: a crash mid-delivery retries instead of stranding a row.
    const claimed = await inTenantTransaction(pool, system, async (client) => {
      const rows = await client.query<ClaimedNotification>(
        `update connector_notifications set state='delivering', attempts=attempts+1,
           lease_expires_at=now() + interval '2 minutes', updated_at=now()
         where id in (
           select id from connector_notifications
           where organization_id=$1 and next_attempt_at <= now()
             and (state='pending' or (state='delivering' and lease_expires_at < now()))
           order by created_at limit $2 for update skip locked
         ) returning *`,
        [organization.id, limit]
      )
      return rows.rows
    })

    for (const notification of claimed) {
      const context = await inTenantTransaction(pool, system, async (client) => {
        const endpoint = await client.query<{
          url: string
          secret_cipher: Buffer
          secret_nonce: Buffer
          key_id: string
          enabled: boolean
        }>(
          'select url, secret_cipher, secret_nonce, key_id, enabled from connector_notification_endpoints where organization_id=$1 and id=$2',
          [organization.id, notification.endpoint_id]
        )
        const task = await client.query<{ state: string; board_id: string; card_id: string }>(
          'select state, board_id, card_id from delegation_tasks where organization_id=$1 and id=$2',
          [organization.id, notification.task_id]
        )
        return { endpoint: endpoint.rows[0] ?? null, task: task.rows[0] ?? null }
      })
      if (!context.endpoint?.enabled || !context.task) {
        await settle(pool, system, {
          notificationId: notification.id,
          endpointId: notification.endpoint_id,
          outcome: {
            kind: 'dropped',
            detail: context.endpoint ? 'The task no longer exists.' : 'The callback endpoint was removed or disabled.',
          },
        })
        continue
      }

      const payload: ConnectorNotificationPayload = connectorNotificationPayloadSchema.parse({
        version: 1,
        eventId: notification.event_id,
        organizationId: organization.id,
        projectId: notification.project_id,
        taskId: notification.task_id,
        sequence: Number(notification.sequence),
        type: notification.type,
        state: context.task.state,
        summary: summarizeDelegationEvent(notification.type, notification.data),
        url: delegationLinks(
          { webOrigin: options.webOrigin },
          {
            id: notification.task_id,
            organizationId: organization.id,
            projectId: notification.project_id,
            boardId: context.task.board_id,
            cardId: context.task.card_id,
          }
        ).task,
        createdAt: notification.created_at.toISOString(),
      })
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const timestamp = Math.floor(Date.now() / 1000)

      let response: OutboundResponse | null = null
      let failure: string | null = null
      try {
        const secret = vault.open({
          cipher: context.endpoint.secret_cipher,
          nonce: context.endpoint.secret_nonce,
          keyId: context.endpoint.key_id,
        })
        // The external call happens outside every transaction: no lock is held across a network effect.
        const target = await resolveOutboundTarget(context.endpoint.url, {
          allowPrivateHosts: options.allowPrivateHosts,
        })
        response = await postOutboundJson(target, {
          body,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Maestrly-Connector-Notifier/1',
            'x-maestrly-delivery': notification.id,
            'x-maestrly-event': notification.type,
            'x-maestrly-event-id': notification.event_id,
            'x-maestrly-organization-id': organization.id,
            'x-maestrly-signature': signNotification({ secret, timestamp, body }),
          },
        })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      const accepted = !!response && response.status >= 200 && response.status < 300
      // 410 is the standard way for a receiver to say the endpoint is gone; it is not worth retrying.
      const permanent = response?.status === 410
      await settle(pool, system, {
        notificationId: notification.id,
        endpointId: notification.endpoint_id,
        outcome: accepted
          ? { kind: 'delivered', detail: `HTTP ${response!.status}` }
          : {
              kind: permanent || notification.attempts + 1 >= MAX_ATTEMPTS ? 'exhausted' : 'retry',
              detail: (response
                ? `HTTP ${response.status}${response.detail ? `: ${response.detail}` : ''}`
                : (failure ?? 'The callback could not be reached.')
              ).slice(0, 2000),
              retryInSeconds: backoffSeconds(notification.attempts + 1),
            },
      })
      if (accepted) delivered += 1
    }
  }
  return delivered
}

type SettleOutcome =
  | { kind: 'delivered'; detail: string }
  | { kind: 'retry'; detail: string; retryInSeconds: number }
  | { kind: 'exhausted'; detail: string; retryInSeconds?: number }
  | { kind: 'dropped'; detail: string }

async function settle(
  pool: DatabasePool,
  system: { organizationId: string; actor: { type: 'system'; service: string } },
  input: { notificationId: string; endpointId: string; outcome: SettleOutcome }
): Promise<void> {
  await inTenantTransaction(pool, system, async (client) => {
    if (input.outcome.kind === 'delivered') {
      await client.query(
        "update connector_notifications set state='delivered', delivered_at=now(), lease_expires_at=null, last_error=null, updated_at=now() where id=$1",
        [input.notificationId]
      )
      await client.query(
        'update connector_notification_endpoints set failure_count=0, last_status=$2, last_delivered_at=now(), updated_at=now() where id=$1',
        [input.endpointId, input.outcome.detail.slice(0, 191)]
      )
      return
    }
    if (input.outcome.kind === 'dropped') {
      await client.query(
        "update connector_notifications set state='failed', lease_expires_at=null, last_error=$2, updated_at=now() where id=$1",
        [input.notificationId, input.outcome.detail]
      )
      return
    }
    if (input.outcome.kind === 'retry') {
      await client.query(
        `update connector_notifications set state='pending', lease_expires_at=null, last_error=$2,
           next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at=now() where id=$1`,
        [input.notificationId, input.outcome.detail, String(input.outcome.retryInSeconds)]
      )
      await client.query(
        'update connector_notification_endpoints set failure_count=failure_count+1, last_status=$2, updated_at=now() where id=$1',
        [input.endpointId, input.outcome.detail.slice(0, 191)]
      )
      return
    }
    // The attempt budget is spent: the notification stops and the endpoint is disabled with the reason, so
    // a dead receiver is reported instead of being retried forever.
    await client.query(
      "update connector_notifications set state='failed', lease_expires_at=null, last_error=$2, updated_at=now() where id=$1",
      [input.notificationId, input.outcome.detail]
    )
    await client.query(
      `update connector_notification_endpoints set enabled=false, failure_count=failure_count+1,
         last_status=$2, updated_at=now() where id=$1`,
      [input.endpointId, `Disabled after a failed delivery: ${input.outcome.detail}`.slice(0, 191)]
    )
  })
}
