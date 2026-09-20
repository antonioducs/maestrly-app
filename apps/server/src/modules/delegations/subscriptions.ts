/**
 * Follow-up subscriptions. A task keeps being watched after its pull request exists: CI, reviews, timers and
 * task dependencies can wake it, each with the stage profile chosen in advance.
 */
import {
  delegationSubscriptionInputSchema,
  delegationSubscriptionSchema,
  nextTimerOccurrence,
  type DelegationSubscription,
  type DelegationSubscriptionInput,
  type DelegationSubscriptionRule,
  type DelegationTask,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { appendDelegationEvent, delegationFail, loadTaskRow } from './repository.js'
import { delegationTransaction, type DelegationScope } from './service.js'

function mapSubscription(row: Record<string, unknown>): DelegationSubscription {
  return delegationSubscriptionSchema.parse({
    id: row.id,
    taskId: row.task_id,
    source: row.source,
    rule: row.rule,
    enabled: row.enabled,
    timezone: row.timezone,
    nextFireAt: row.next_fire_at ? (row.next_fire_at as Date).toISOString() : null,
    lastFiredAt: row.last_fired_at ? (row.last_fired_at as Date).toISOString() : null,
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    firedCount: Number(row.fired_count),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  })
}

/** Timezone names are validated against the runtime so a rule cannot persist an unusable schedule. */
function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    delegationFail(`"${timezone}" is not a time zone this server understands.`, 400)
  }
}

function initialFireAt(rule: DelegationSubscriptionRule, timezone: string): Date | null {
  if (rule.action === 'create_task_from_preset') return nextTimerOccurrence(rule, timezone, new Date())
  if (rule.action === 'refresh_pull_request') return new Date(Date.now() + rule.intervalSeconds * 1000)
  return null
}

export async function subscribeTask(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; rule: DelegationSubscriptionInput }
): Promise<DelegationSubscription> {
  const parsed = delegationSubscriptionInputSchema.parse(input.rule)
  assertTimezone(parsed.timezone)
  if (parsed.source === 'timer' && parsed.rule.action !== 'create_task_from_preset')
    delegationFail('A timer subscription must carry a schedule rule.', 400)
  if (parsed.source === 'github' && parsed.rule.action === 'create_task_from_preset')
    delegationFail('A schedule rule belongs to a timer subscription.', 400)
  return delegationTransaction(pool, scope, true, async (client) => {
    const task = await loadTaskRow(client, scope, input.taskId)
    const expiresAt = parsed.expiresInSeconds ? new Date(Date.now() + parsed.expiresInSeconds * 1000) : null
    const rows = await client.query(
      `insert into delegation_subscriptions(
         organization_id, project_id, task_id, source, rule, timezone, next_fire_at, expires_at,
         created_by_user_id, connection_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        scope.organizationId,
        scope.projectId,
        task.id,
        parsed.source,
        parsed.rule,
        parsed.timezone,
        initialFireAt(parsed.rule, parsed.timezone),
        expiresAt,
        scope.userId,
        scope.connectionId ?? null,
      ]
    )
    const subscription = mapSubscription(rows.rows[0]!)
    await appendDelegationEvent(client, task, 'subscription.created', {
      subscriptionId: subscription.id,
      source: subscription.source,
      action: parsed.rule.action,
      expiresAt: subscription.expiresAt,
    })
    return subscription
  })
}

export async function listSubscriptions(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string
): Promise<DelegationSubscription[]> {
  return delegationTransaction(pool, scope, false, async (client) => {
    await loadTaskRow(client, scope, taskId)
    const rows = await client.query(
      'select * from delegation_subscriptions where organization_id=$1 and task_id=$2 order by created_at',
      [scope.organizationId, taskId]
    )
    return rows.rows.map(mapSubscription)
  })
}

export async function setSubscriptionEnabled(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; subscriptionId: string; enabled: boolean }
): Promise<DelegationSubscription> {
  return delegationTransaction(pool, scope, true, async (client) => {
    const task = await loadTaskRow(client, scope, input.taskId)
    const rows = await client.query(
      'update delegation_subscriptions set enabled=$4, updated_at=now() where organization_id=$1 and task_id=$2 and id=$3 returning *',
      [scope.organizationId, task.id, input.subscriptionId, input.enabled]
    )
    if (!rows.rows[0]) delegationFail('Subscription not found.', 404)
    await appendDelegationEvent(client, task, 'subscription.changed', {
      subscriptionId: input.subscriptionId,
      enabled: input.enabled,
    })
    return mapSubscription(rows.rows[0])
  })
}

export interface ActiveSubscription extends DelegationSubscription {
  organizationId: string
  projectId: string
}

/** Subscriptions of one source that are enabled and not expired, for the watcher loop. */
export async function activeSubscriptions(
  client: DatabaseClient,
  input: { organizationId: string; source: DelegationSubscription['source'] }
): Promise<ActiveSubscription[]> {
  const rows = await client.query(
    `select s.*, t.project_id as task_project_id from delegation_subscriptions s
     join delegation_tasks t on t.id = s.task_id
     where s.organization_id=$1 and s.source=$2 and s.enabled
       and (s.expires_at is null or s.expires_at > now())
     order by s.next_fire_at nulls last, s.created_at`,
    [input.organizationId, input.source]
  )
  return rows.rows.map((row) => ({
    ...mapSubscription(row),
    organizationId: input.organizationId,
    projectId: String(row.project_id),
  }))
}

/** Disable a subscription whose watch window closed, recording the reason. */
export async function expireSubscriptions(client: DatabaseClient, organizationId: string): Promise<number> {
  const rows = await client.query<{ id: string; task_id: string; project_id: string }>(
    `update delegation_subscriptions set enabled=false, updated_at=now()
     where organization_id=$1 and enabled and expires_at is not null and expires_at <= now()
     returning id, task_id, project_id`,
    [organizationId]
  )
  for (const row of rows.rows) {
    const task = await loadTaskRow(client, { organizationId, projectId: row.project_id }, row.task_id)
    await appendDelegationEvent(client, task, 'subscription.expired', { subscriptionId: row.id })
  }
  return rows.rows.length
}

/** Advance a timer after it fired, so a missed window schedules the next one instead of catching up. */
export async function rescheduleTimer(
  client: DatabaseClient,
  subscription: ActiveSubscription,
  rule: Extract<DelegationSubscriptionRule, { action: 'create_task_from_preset' }>
): Promise<void> {
  await client.query(
    'update delegation_subscriptions set next_fire_at=$2, last_fired_at=now(), fired_count=fired_count+1, updated_at=now() where id=$1',
    [subscription.id, nextTimerOccurrence(rule, subscription.timezone, new Date())]
  )
}

export async function markPolled(
  client: DatabaseClient,
  subscriptionId: string,
  intervalSeconds: number
): Promise<void> {
  await client.query(
    `update delegation_subscriptions set next_fire_at = now() + ($2 || ' seconds')::interval,
       last_fired_at = now(), fired_count = fired_count + 1, updated_at = now() where id=$1`,
    [subscriptionId, String(intervalSeconds)]
  )
}

/** Whether a task is still being watched by an enabled subscription whose window is open. */
export async function hasActiveSubscription(
  client: DatabaseClient,
  input: { organizationId: string; taskId: string; source: DelegationSubscription['source'] }
): Promise<boolean> {
  const rows = await client.query<{ count: string }>(
    `select count(*)::text as count from delegation_subscriptions
     where organization_id=$1 and task_id=$2 and source=$3 and enabled
       and (expires_at is null or expires_at > now())`,
    [input.organizationId, input.taskId, input.source]
  )
  return Number(rows.rows[0]!.count) > 0
}

export async function subscriptionsFor(
  client: DatabaseClient,
  task: DelegationTask,
  source: DelegationSubscription['source']
): Promise<DelegationSubscription[]> {
  const rows = await client.query(
    'select * from delegation_subscriptions where organization_id=$1 and task_id=$2 and source=$3 and enabled',
    [task.organizationId, task.id, source]
  )
  return rows.rows.map(mapSubscription)
}
