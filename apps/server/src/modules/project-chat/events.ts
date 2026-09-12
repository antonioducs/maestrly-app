import { randomUUID } from 'node:crypto'
import type { ChatPayload, ProjectChatSession, ProjectChatEvent } from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { chatTransaction, ownedSession, chatFail, type ChatScope } from './service.js'

/** Callers hold the session lock; the projection and event commit atomically. */
export async function appendChatEvent(
  c: DatabaseClient,
  s: ProjectChatSession,
  payload: ChatPayload,
  eventId: string = randomUUID(),
  turnId: string | null = null
): Promise<ProjectChatEvent> {
  const old = await c.query('select sequence,payload from chat_events where session_id=$1 and event_id=$2', [
    s.id,
    eventId,
  ])
  if (old.rows[0]) {
    if (!sameJson(old.rows[0].payload, payload)) chatFail('Event ID reused with different content.')
    return { version: 1, sessionId: s.id, sequence: Number(old.rows[0].sequence), eventId, payload }
  }
  const r = await c.query(
    'update chat_sessions set event_sequence=event_sequence+1,updated_at=now() where id=$1 returning event_sequence',
    [s.id]
  )
  const sequence = Number(r.rows[0].event_sequence)
  await c.query(
    'insert into chat_events(organization_id,project_id,session_id,turn_id,sequence,event_id,payload) values($1,$2,$3,$4,$5,$6,$7)',
    [s.organizationId, s.projectId, s.id, turnId, sequence, eventId, payload]
  )
  return { version: 1, sessionId: s.id, sequence, eventId, payload }
}
export function sameJson(a: unknown, b: unknown): boolean {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, normalize(x)])
          )
        : v
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
export async function listChatEvents(pool: DatabasePool, scope: ChatScope, id: string, cursor: number) {
  return chatTransaction(pool, scope, false, async (c) => {
    await ownedSession(c, scope, id)
    const r = await c.query(
      'select * from chat_events where session_id=$1 and sequence>$2 order by sequence limit 100',
      [id, cursor]
    )
    return r.rows.map((row) => ({
      version: 1 as const,
      sessionId: id,
      sequence: Number(row.sequence),
      eventId: row.event_id,
      payload: row.payload as ChatPayload,
    }))
  })
}
