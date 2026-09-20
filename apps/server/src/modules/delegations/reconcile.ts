/**
 * Recovery for delegation tasks. It never repeats an external effect: an attempt whose outcome cannot be
 * established becomes visible as `needs_attention` instead of being retried silently.
 *
 * Like the scheduler, reconciliation acts as each task's owner so chat-session RLS and project permission
 * apply unchanged.
 */
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { appendDelegationEvent, loadTaskRow, setTaskState } from './repository.js'
import { advanceDelegation, settleStageFromTurn, taskIdentity } from './scheduler.js'

const LIVE_ATTEMPT_STATES = ['queued', 'running', 'waiting_input'] as const

interface Candidate {
  taskId: string
  projectId: string
  ownerUserId: string
  reason: 'settle' | 'orphaned'
  turnIds: string[]
  commandIds: string[]
}

/** Tenant-scoped scan over the delegation tables only; chat rows are touched later as the owner. */
async function candidates(pool: DatabasePool, organizationId: string): Promise<Candidate[]> {
  return inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
    async (client) => {
      const found = new Map<string, Candidate>()
      const add = (row: { task_id: string; project_id: string; owner_user_id: string }, reason: Candidate['reason']) => {
        const existing = found.get(row.task_id)
        if (existing) return existing
        const candidate: Candidate = {
          taskId: row.task_id,
          projectId: row.project_id,
          ownerUserId: row.owner_user_id,
          reason,
          turnIds: [],
          commandIds: [],
        }
        found.set(row.task_id, candidate)
        return candidate
      }
      const stale = await client.query<{
        task_id: string
        project_id: string
        owner_user_id: string
        turn_id: string
      }>(
        `select a.task_id, a.project_id, t.owner_user_id, a.turn_id
         from delegation_attempts a
         join delegation_tasks t on t.id = a.task_id
         where a.organization_id=$1 and a.state = any($2::text[]) and a.turn_id is not null`,
        [organizationId, [...LIVE_ATTEMPT_STATES]]
      )
      for (const row of stale.rows) add(row, 'settle').turnIds.push(row.turn_id)

      const pending = await client.query<{
        id: string
        task_id: string
        project_id: string
        owner_user_id: string
      }>(
        `select c.id, c.task_id, c.project_id, t.owner_user_id from delegation_commands c
         join delegation_tasks t on t.id = c.task_id
         where c.organization_id=$1 and c.state='pending' and c.created_at < now() - interval '2 minutes'`,
        [organizationId]
      )
      for (const row of pending.rows) add(row, 'settle').commandIds.push(row.id)

      const orphaned = await client.query<{ task_id: string; project_id: string; owner_user_id: string }>(
        `select t.id as task_id, t.project_id, t.owner_user_id from delegation_tasks t
         join runners r on r.id = t.executor_id
         where t.organization_id=$1 and t.state in ('queued','running')
           and (r.status='revoked' or r.delegation_capabilities is null)`,
        [organizationId]
      )
      for (const row of orphaned.rows) {
        const candidate = add(row, 'orphaned')
        candidate.reason = 'orphaned'
      }
      return [...found.values()]
    }
  )
}

export async function reconcileDelegations(
  pool: DatabasePool,
  options: { organizationId?: string } = {}
): Promise<void> {
  const organizations = options.organizationId
    ? [{ id: options.organizationId }]
    : (await pool.query<{ id: string }>('select id from organizations')).rows
  for (const organization of organizations) {
    for (const candidate of await candidates(pool, organization.id)) {
      const settled = await inTenantTransaction(
        pool,
        {
          organizationId: organization.id,
          projectId: candidate.projectId,
          actor: { type: 'human', userId: candidate.ownerUserId },
        },
        async (client) => {
          const locked = await client.query(
            'select id from delegation_tasks where organization_id=$1 and id=$2 for update skip locked',
            [organization.id, candidate.taskId]
          )
          if (!locked.rowCount) return false
          let advance = false
          for (const turnId of candidate.turnIds) {
            const terminal = await client.query<{ state: string }>(
              "select state from chat_turns where id=$1 and state in ('succeeded','failed','cancelled','interrupted')",
              [turnId]
            )
            if (!terminal.rowCount) continue
            if (await settleStageFromTurn(client, { organizationId: organization.id, turnId })) advance = true
          }
          for (const commandId of candidate.commandIds) {
            await client.query("update delegation_commands set state='failed', error=$2 where id=$1 and state='pending'", [
              commandId,
              'The command did not complete. Inspect the task and send it again with a new key.',
            ])
            const task = await loadTaskRow(
              client,
              { organizationId: organization.id, projectId: candidate.projectId },
              candidate.taskId
            )
            await appendDelegationEvent(client, task, 'task.command_unresolved', { commandId })
            await setTaskState(client, organization.id, task.id, 'needs_attention', {
              reason: 'executor_error',
              detail: 'A command did not complete. Confirm the task state before continuing.',
              since: new Date().toISOString(),
            })
            advance = false
          }
          if (candidate.reason === 'orphaned') {
            const task = await loadTaskRow(
              client,
              { organizationId: organization.id, projectId: candidate.projectId },
              candidate.taskId
            )
            await setTaskState(client, organization.id, task.id, 'needs_attention', {
              reason: 'executor_offline',
              detail: 'The selected executor no longer advertises delegation stages.',
              since: new Date().toISOString(),
            })
            await appendDelegationEvent(client, task, 'task.executor_unavailable', { executorId: task.executorId })
            advance = false
          }
          return advance
        }
      )
      if (settled) {
        const identity = await taskIdentity(pool, organization.id, candidate.taskId)
        if (identity) await advanceDelegation(pool, { organizationId: organization.id, taskId: candidate.taskId })
      }
    }
  }
}
