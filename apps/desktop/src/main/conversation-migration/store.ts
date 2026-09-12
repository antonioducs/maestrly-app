import type { SQLInputValue } from 'node:sqlite'
import type {
  ConversationMigrationRecord,
  MigrationPhase,
  MigrationStatus,
  SidecarMutation,
} from '../../shared/conversation-migration'
import { getDb, transaction } from '../store/db'
import { collectChatToolImageRefs, releaseUnreferencedChatToolImages } from '../chat/chat-store'
import { deleteConversationToolImageMetadata } from '../chat/tool-output'
import { deleteConversation, getConversation, setConversationLocation } from '../store/conversations'

const terminalStatuses = new Set<MigrationStatus>(['completed', 'cancelled', 'rolled-back'])

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowToRecord(row: any): ConversationMigrationRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ...(row.legacy_successor_conversation_id
      ? { legacySuccessorConversationId: row.legacy_successor_conversation_id }
      : {}),
    sourceWorkspaceId: row.source_workspace_id,
    sourceBranch: row.source_branch,
    destinationBranch: row.destination_branch,
    sourceCwd: row.source_cwd,
    destinationCwd: row.destination_cwd,
    sourceHeadOid: row.source_head_oid,
    changes: json(row.changes_json, { staged: [], unstaged: [], untracked: [] }),
    ignored: json(row.ignored_json, []),
    selectedIgnoredPaths: json(row.selected_ignored_json, []),
    confirmedSensitivePaths: json(row.confirmed_sensitive_json, []),
    gitPlan: json(row.git_plan_json, null),
    sidecars: json(row.sidecars_json, []),
    phase: row.phase,
    status: row.status,
    stashOid: row.stash_oid ?? undefined,
    stashMarker: row.stash_marker ?? undefined,
    baselineAssistants: row.baseline_assistants ?? 0,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertMigration(record: ConversationMigrationRecord): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_migrations
     (id, conversation_id, legacy_successor_conversation_id, source_workspace_id, source_branch, destination_branch, source_cwd,
      destination_cwd, source_head_oid, changes_json, ignored_json, selected_ignored_json,
      confirmed_sensitive_json, git_plan_json, sidecars_json, phase, status, stash_oid,
      stash_marker, baseline_assistants, error, created_at, updated_at)
     VALUES
     (@id, @conversationId, @legacySuccessorConversationId, @sourceWorkspaceId, @sourceBranch, @destinationBranch, @sourceCwd,
      @destinationCwd, @sourceHeadOid, @changes, @ignored, @selectedIgnoredPaths,
      @confirmedSensitivePaths, @gitPlan, @sidecars, @phase, @status, @stashOid,
      @stashMarker, @baselineAssistants, @error, @createdAt, @updatedAt)`
    )
    .run({
      ...record,
      legacySuccessorConversationId: record.legacySuccessorConversationId ?? null,
      changes: JSON.stringify(record.changes),
      ignored: JSON.stringify(record.ignored),
      selectedIgnoredPaths: JSON.stringify(record.selectedIgnoredPaths),
      confirmedSensitivePaths: JSON.stringify(record.confirmedSensitivePaths),
      gitPlan: JSON.stringify(record.gitPlan),
      sidecars: JSON.stringify(record.sidecars),
      stashOid: record.stashOid ?? null,
      stashMarker: record.stashMarker ?? null,
      error: record.error ?? null,
    })
}

export function getMigration(id: string): ConversationMigrationRecord | undefined {
  const row = getDb().prepare('SELECT * FROM conversation_migrations WHERE id = ?').get(id)
  return row ? rowToRecord(row) : undefined
}

export function listIncompleteMigrations(): ConversationMigrationRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM conversation_migrations WHERE status NOT IN ('completed','cancelled','rolled-back') ORDER BY created_at"
      )
      .all() as any[]
  ).map(rowToRecord)
}

export function incompleteMigrationForConversation(conversationId: string): ConversationMigrationRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM conversation_migrations
     WHERE status NOT IN ('completed','cancelled','rolled-back')
       AND (conversation_id = ? OR legacy_successor_conversation_id = ?)
     ORDER BY created_at LIMIT 1`
    )
    .get(conversationId, conversationId)
  return row ? rowToRecord(row) : undefined
}

export function assertConversationMigrationMutationAllowed(conversationId: string, action: string): void {
  const migration = incompleteMigrationForConversation(conversationId)
  if (migration) throw new Error(`${action} is blocked by incomplete migration ${migration.id}.`)
}

export function findIncompleteMigrationForScope(
  conversationId: string,
  cwd: string
): ConversationMigrationRecord | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM conversation_migrations
     WHERE status NOT IN ('completed','cancelled','rolled-back')
       AND (conversation_id = ? OR legacy_successor_conversation_id = ? OR source_cwd = ? OR destination_cwd = ?)
     ORDER BY created_at LIMIT 1`
    )
    .get(conversationId, conversationId, cwd, cwd)
  return row ? rowToRecord(row) : undefined
}

export function advanceMigration(
  id: string,
  expectedPhase: MigrationPhase | MigrationPhase[],
  patch: {
    phase: MigrationPhase
    status?: MigrationStatus
    selectedIgnoredPaths?: string[]
    confirmedSensitivePaths?: string[]
    sidecars?: SidecarMutation[]
    stashOid?: string
    stashMarker?: string
    baselineAssistants?: number
    error?: string | null
  }
): boolean {
  const expected = Array.isArray(expectedPhase) ? expectedPhase : [expectedPhase]
  if (expected.length === 0) return false
  const assignments = ['phase = @phase', 'updated_at = @updatedAt']
  const params: Record<string, SQLInputValue> = { id, phase: patch.phase, updatedAt: Date.now() }
  const assign = (column: string, key: string, value: SQLInputValue): void => {
    assignments.push(`${column} = @${key}`)
    params[key] = value
  }
  if (patch.status) assign('status', 'status', patch.status)
  if (patch.selectedIgnoredPaths)
    assign('selected_ignored_json', 'selectedIgnoredPaths', JSON.stringify(patch.selectedIgnoredPaths))
  if (patch.confirmedSensitivePaths)
    assign('confirmed_sensitive_json', 'confirmedSensitivePaths', JSON.stringify(patch.confirmedSensitivePaths))
  if (patch.sidecars) assign('sidecars_json', 'sidecars', JSON.stringify(patch.sidecars))
  if (patch.stashOid) assign('stash_oid', 'stashOid', patch.stashOid)
  if (patch.stashMarker) assign('stash_marker', 'stashMarker', patch.stashMarker)
  if (patch.baselineAssistants !== undefined)
    assign('baseline_assistants', 'baselineAssistants', patch.baselineAssistants)
  if (patch.error !== undefined) assign('error', 'error', patch.error)
  expected.forEach((phase, index) => {
    params[`expected${index}`] = phase
  })
  const placeholders = expected.map((_, index) => `@expected${index}`).join(',')
  return (
    Number(
      getDb()
        .prepare(
          `UPDATE conversation_migrations SET ${assignments.join(', ')} WHERE id = @id AND phase IN (${placeholders})`
        )
        .run(params).changes
    ) === 1
  )
}

export function replaceMigrationSidecars(id: string, sidecars: SidecarMutation[]): void {
  getDb()
    .prepare('UPDATE conversation_migrations SET sidecars_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(sidecars), Date.now(), id)
}

export function updateMigrationGitState(
  id: string,
  patch: { stashOid?: string; stashMarker?: string; error?: string | null }
): void {
  const assignments = ['updated_at = @updatedAt']
  const values: Record<string, SQLInputValue> = { id, updatedAt: Date.now() }
  if (patch.stashOid !== undefined) {
    assignments.push('stash_oid = @stashOid')
    values.stashOid = patch.stashOid
  }
  if (patch.stashMarker !== undefined) {
    assignments.push('stash_marker = @stashMarker')
    values.stashMarker = patch.stashMarker
  }
  if (patch.error !== undefined) {
    assignments.push('error = @error')
    values.error = patch.error
  }
  getDb()
    .prepare(`UPDATE conversation_migrations SET ${assignments.join(', ')} WHERE id = @id`)
    .run(values)
}

export function commitConversationLocation(
  migrationId: string,
  expectedPhase: MigrationPhase,
  args: { conversationId: string; branch: string; cwd: string }
): boolean {
  let committed = false
  transaction(() => {
    const row = getMigration(migrationId)
    if (!row || row.phase !== expectedPhase) return
    setConversationLocation(args.conversationId, { branch: args.branch, mode: 'worktree', cwd: args.cwd })
    committed = advanceMigration(migrationId, expectedPhase, {
      phase: 'finalizing',
      status: 'running',
    })
    if (!committed) throw new Error('The migration phase changed while committing the location.')
  })
  return committed
}

export function rollbackMigrationIdentity(migrationId: string): boolean {
  let rolledBack = false
  let deletedLegacySuccessorId: string | undefined
  let deletedToolImageRefs = new Set<string>()
  transaction(() => {
    const row = getMigration(migrationId)
    if (row?.phase !== 'rolling-back') return
    if (row.legacySuccessorConversationId) {
      if (row.legacySuccessorConversationId === row.conversationId) {
        throw new Error('The legacy journal references the original conversation as its successor.')
      }
      deletedLegacySuccessorId = row.legacySuccessorConversationId
      if (getConversation(row.legacySuccessorConversationId)) {
        deletedToolImageRefs = collectChatToolImageRefs(row.legacySuccessorConversationId)
      }
    } else {
      const conversation = getConversation(row.conversationId)
      if (!conversation) throw new Error('Conversation not found.')
      if (
        conversation.cwd !== row.sourceCwd ||
        conversation.branch !== row.sourceBranch ||
        conversation.mode !== 'local'
      ) {
        if (
          conversation.cwd !== row.destinationCwd ||
          conversation.branch !== row.destinationBranch ||
          conversation.mode !== 'worktree'
        ) {
          throw new Error('The conversation location changed after migration.')
        }
        setConversationLocation(conversation.id, { branch: row.sourceBranch, mode: 'local', cwd: row.sourceCwd })
      }
    }
    rolledBack = advanceMigration(migrationId, 'rolling-back', {
      phase: 'rolled-back',
      status: 'rolled-back',
      error: null,
    })
    if (!rolledBack) throw new Error('The phase changed while completing rollback.')
    if (deletedLegacySuccessorId && getConversation(deletedLegacySuccessorId)) {
      // The trigger protects the successor until this checkpoint. Transactional checkpoint/deletion rolls
      // back together on failure, preserving retry after restart. Foreign keys cascade Chat history, tool
      // executions, and other links.
      deleteConversation(deletedLegacySuccessorId)
    }
  })
  if (deletedLegacySuccessorId) {
    releaseUnreferencedChatToolImages(deletedToolImageRefs)
    deleteConversationToolImageMetadata(deletedLegacySuccessorId)
  }
  return rolledBack
}

export function completeMigration(migrationId: string): boolean {
  return advanceMigration(migrationId, 'finalizing-stash', {
    phase: 'completed',
    status: 'completed',
    error: null,
  })
}

export function markMigrationRecoveryRequired(id: string, error: string): void {
  getDb()
    .prepare("UPDATE conversation_migrations SET status = 'recovery-required', error = ?, updated_at = ? WHERE id = ?")
    .run(error, Date.now(), id)
}

export function isMigrationTerminal(record: ConversationMigrationRecord): boolean {
  return terminalStatuses.has(record.status)
}
