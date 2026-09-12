import { authorizeProject } from '../access/authorize.js'
import type { Actor, DomainEvent } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'

interface EventRow {
  id: string
  organization_id: string
  project_id: string
  sequence: string
  type: string
  aggregate_type: string
  aggregate_id: string
  actor: Actor
  reason: string | null
  data: Record<string, unknown>
  created_at: Date
}

function mapEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sequence: Number(row.sequence),
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    actor: row.actor,
    reason: row.reason ?? undefined,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  }
}

export async function appendDomainEvent(
  client: DatabaseClient,
  input: {
    organizationId: string
    projectId: string
    type: string
    aggregateType: string
    aggregateId: string
    actor: Actor
    reason?: string
    data?: Record<string, unknown>
  },
): Promise<DomainEvent> {
  const result = await client.query<EventRow>(`
    insert into domain_events(
      organization_id, project_id, sequence, type, aggregate_type, aggregate_id, actor, reason, data
    ) values ($1, $2, next_project_event_sequence($1, $2), $3, $4, $5, $6, $7, $8)
    returning *
  `, [
    input.organizationId, input.projectId, input.type, input.aggregateType, input.aggregateId,
    input.actor, input.reason ?? null, input.data ?? {},
  ])
  return mapEvent(result.rows[0]!)
}

export async function listDomainEvents(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; cursor: number; limit?: number; actor: Actor },
): Promise<DomainEvent[]> {
  return inTenantTransaction(pool, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actor: input.actor,
  }, async (client) => {
    if(input.actor.type==='human'||input.actor.type==='desktop_agent'){
      await client.query('select id from projects where organization_id=$1 and id=$2 for share',[input.organizationId,input.projectId])
      await authorizeProject(client,input.organizationId,input.projectId,input.actor.userId,'project:read')
    }
    const result = await client.query<EventRow>(`
      select * from domain_events
      where organization_id = $1 and project_id = $2 and sequence > $3
      order by sequence asc limit $4
    `, [input.organizationId, input.projectId, input.cursor, Math.min(input.limit ?? 100, 500)])
    return result.rows.map(mapEvent)
  })
}
