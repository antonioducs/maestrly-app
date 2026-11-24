import { getDb } from './db'
import type { MaestroSwarmChangesReason, MaestroSwarmPhase, MaestroSwarmTask } from '../../shared/maestro-swarm'

interface MaestroSwarmTaskRow {
  orchestratorConversationId: string
  key: string
  title: string
  resourceId: string | null
  dependsOnJson: string
  conversationId: string | null
  branch: string | null
  baseCommit: string | null
  phase: MaestroSwarmPhase
  changesReason: MaestroSwarmChangesReason | null
  reviewRound: number
  note: string | null
  mergedCommit: string | null
  createdAt: number
  updatedAt: number
}

const COLUMNS = `orchestrator_conversation_id AS orchestratorConversationId,
  task_key AS key,
  title,
  resource_id AS resourceId,
  depends_on_json AS dependsOnJson,
  conversation_id AS conversationId,
  branch,
  base_commit AS baseCommit,
  phase,
  changes_reason AS changesReason,
  review_round AS reviewRound,
  note,
  merged_commit AS mergedCommit,
  created_at AS createdAt,
  updated_at AS updatedAt`

function parseDependsOn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function fromRow(row: MaestroSwarmTaskRow | undefined): MaestroSwarmTask | null {
  if (!row) return null
  return {
    orchestratorConversationId: row.orchestratorConversationId,
    key: row.key,
    title: row.title,
    resourceId: row.resourceId,
    dependsOn: parseDependsOn(row.dependsOnJson),
    conversationId: row.conversationId,
    branch: row.branch,
    baseCommit: row.baseCommit,
    phase: row.phase,
    changesReason: row.changesReason,
    reviewRound: Number(row.reviewRound),
    note: row.note,
    mergedCommit: row.mergedCommit,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  }
}

export function listMaestroSwarmTasks(orchestratorConversationId: string): MaestroSwarmTask[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS}
       FROM maestro_swarm_tasks
       WHERE orchestrator_conversation_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(orchestratorConversationId) as unknown as MaestroSwarmTaskRow[]
  return rows.map((row) => fromRow(row)!).filter(Boolean)
}

export function getMaestroSwarmTask(orchestratorConversationId: string, key: string): MaestroSwarmTask | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS}
       FROM maestro_swarm_tasks
       WHERE orchestrator_conversation_id = ? AND task_key = ?`
    )
    .get(orchestratorConversationId, key) as unknown as MaestroSwarmTaskRow | undefined
  return fromRow(row)
}

export function findMaestroSwarmTaskByConversation(
  conversationId: string,
  orchestratorConversationId?: string
): MaestroSwarmTask | null {
  const row = orchestratorConversationId
    ? (getDb()
        .prepare(
          `SELECT ${COLUMNS}
           FROM maestro_swarm_tasks
           WHERE conversation_id = ? AND orchestrator_conversation_id = ?`
        )
        .get(conversationId, orchestratorConversationId) as unknown as MaestroSwarmTaskRow | undefined)
    : (getDb()
        .prepare(
          `SELECT ${COLUMNS}
           FROM maestro_swarm_tasks
           WHERE conversation_id = ?`
        )
        .get(conversationId) as unknown as MaestroSwarmTaskRow | undefined)
  return fromRow(row)
}

export function upsertMaestroSwarmTask(task: MaestroSwarmTask): void {
  getDb()
    .prepare(
      `INSERT INTO maestro_swarm_tasks (
         orchestrator_conversation_id,
         task_key,
         title,
         resource_id,
         depends_on_json,
         conversation_id,
         branch,
         base_commit,
         phase,
         changes_reason,
         review_round,
         note,
         merged_commit,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(orchestrator_conversation_id, task_key) DO UPDATE SET
         title = excluded.title,
         resource_id = excluded.resource_id,
         depends_on_json = excluded.depends_on_json,
         conversation_id = excluded.conversation_id,
         branch = excluded.branch,
         base_commit = excluded.base_commit,
         phase = excluded.phase,
         changes_reason = excluded.changes_reason,
         review_round = excluded.review_round,
         note = excluded.note,
         merged_commit = excluded.merged_commit,
         updated_at = excluded.updated_at`
    )
    .run(
      task.orchestratorConversationId,
      task.key,
      task.title,
      task.resourceId,
      JSON.stringify(task.dependsOn),
      task.conversationId,
      task.branch,
      task.baseCommit,
      task.phase,
      task.changesReason,
      task.reviewRound,
      task.note,
      task.mergedCommit,
      task.createdAt,
      task.updatedAt
    )
}

export function deleteMaestroSwarmTasks(orchestratorConversationId: string): void {
  getDb()
    .prepare('DELETE FROM maestro_swarm_tasks WHERE orchestrator_conversation_id = ?')
    .run(orchestratorConversationId)
}
