import { getDb, transaction } from './store'
import type {
  ConversationDispatchPhase,
  ConversationDispatchPlacement,
  ConversationDispatchSettings,
  ConversationDispatchSourceRef,
} from '../shared/conversation-dispatch'

/** Durable journal for one destination conversation started from a source conversation. */
export interface ConversationDispatchRecord {
  dispatchId: string
  sourceConversationId: string
  /** Initiating human message (`message:<id>`) or approved plan (`plan:<version>:<hash>`). */
  originKey: string
  requestKey: string
  kind: 'task' | 'plan'
  fingerprint: string
  title: string
  prompt: string
  placement: ConversationDispatchPlacement
  settings: ConversationDispatchSettings
  inherited: string[]
  sourceRef: ConversationDispatchSourceRef | null
  workspaceId: string
  /** Reserved before allocation; the conversation row may not exist yet. */
  conversationId: string
  conversationName: string
  branch: string | null
  baseRevision: string | null
  phase: ConversationDispatchPhase
  error: string | null
  createdAt: number
  updatedAt: number
}

type Row = Omit<ConversationDispatchRecord, 'settings' | 'inherited' | 'sourceRef'> & {
  settingsJson: string
  inheritedJson: string
  sourceRefJson: string | null
}

const columns = `dispatch_id AS dispatchId, source_conversation_id AS sourceConversationId, origin_key AS originKey,
  request_key AS requestKey, kind, fingerprint, title, prompt, placement, settings_json AS settingsJson,
  inherited_json AS inheritedJson, source_ref_json AS sourceRefJson, workspace_id AS workspaceId,
  conversation_id AS conversationId, conversation_name AS conversationName, branch, base_revision AS baseRevision,
  phase, error, created_at AS createdAt, updated_at AS updatedAt`

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function fromRow(row: Row | undefined): ConversationDispatchRecord | null {
  if (!row) return null
  const { settingsJson, inheritedJson, sourceRefJson, ...rest } = row
  return {
    ...rest,
    settings: parseJson<ConversationDispatchSettings>(settingsJson, {
      providerId: '',
      modelId: '',
      reasoning: 'off',
      fastMode: false,
    }),
    inherited: parseJson<string[]>(inheritedJson, []),
    sourceRef: parseJson<ConversationDispatchSourceRef | null>(sourceRefJson, null),
  }
}

export function findConversationDispatch(
  sourceConversationId: string,
  originKey: string,
  requestKey: string
): ConversationDispatchRecord | null {
  return fromRow(
    getDb()
      .prepare(
        `SELECT ${columns} FROM conversation_dispatches
         WHERE source_conversation_id=? AND origin_key=? AND request_key=?`
      )
      .get(sourceConversationId, originKey, requestKey) as Row | undefined
  )
}

export function getConversationDispatch(dispatchId: string): ConversationDispatchRecord | null {
  return fromRow(
    getDb().prepare(`SELECT ${columns} FROM conversation_dispatches WHERE dispatch_id=?`).get(dispatchId) as
      | Row
      | undefined
  )
}

export function getConversationDispatchByDestination(conversationId: string): ConversationDispatchRecord | null {
  return fromRow(
    getDb().prepare(`SELECT ${columns} FROM conversation_dispatches WHERE conversation_id=?`).get(conversationId) as
      | Row
      | undefined
  )
}

/** Request keys of one origin that still own (or owned) a destination; discarded attempts do not count. */
export function listConversationDispatchRequestKeys(sourceConversationId: string, originKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT request_key AS requestKey FROM conversation_dispatches
       WHERE source_conversation_id=? AND origin_key=? AND phase <> 'discarded'`
    )
    .all(sourceConversationId, originKey) as Array<{ requestKey: string }>
  return rows.map((row) => row.requestKey)
}

export function listConversationDispatchesInPhases(
  phases: readonly ConversationDispatchPhase[]
): ConversationDispatchRecord[] {
  if (!phases.length) return []
  const rows = getDb()
    .prepare(
      `SELECT ${columns} FROM conversation_dispatches WHERE phase IN (${phases.map(() => '?').join(',')})
       ORDER BY created_at`
    )
    .all(...phases) as unknown as Row[]
  return rows.map((row) => fromRow(row)!)
}

/** Whether a conversation has any persisted message (a seeded first turn persists its message at admission). */
export function conversationHasMessages(conversationId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM chat_messages WHERE conversation_id=? LIMIT 1').get(conversationId)
}

export type NewConversationDispatch = Omit<ConversationDispatchRecord, 'phase' | 'error' | 'createdAt' | 'updatedAt'>

/**
 * Insert a reservation. Returns the existing record instead when a concurrent caller reserved the same
 * (source, origin, request) first, so the caller can apply replay semantics.
 */
export function reserveConversationDispatch(value: NewConversationDispatch): {
  record: ConversationDispatchRecord
  created: boolean
} {
  let result = null as { record: ConversationDispatchRecord; created: boolean } | null
  transaction(() => {
    const existing = findConversationDispatch(value.sourceConversationId, value.originKey, value.requestKey)
    if (existing) {
      result = { record: existing, created: false }
      return
    }
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO conversation_dispatches
         (dispatch_id, source_conversation_id, origin_key, request_key, kind, fingerprint, title, prompt, placement,
          settings_json, inherited_json, source_ref_json, workspace_id, conversation_id, conversation_name, branch,
          base_revision, phase, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?)`
      )
      .run(
        value.dispatchId,
        value.sourceConversationId,
        value.originKey,
        value.requestKey,
        value.kind,
        value.fingerprint,
        value.title,
        value.prompt,
        value.placement,
        JSON.stringify(value.settings),
        JSON.stringify(value.inherited),
        value.sourceRef ? JSON.stringify(value.sourceRef) : null,
        value.workspaceId,
        value.conversationId,
        value.conversationName,
        value.branch,
        value.baseRevision,
        now,
        now
      )
    result = { record: getConversationDispatch(value.dispatchId)!, created: true }
  })
  return result!
}

/**
 * Reuse a discarded reservation for a fresh allocation attempt (plan handoff retry after rollback). The previous
 * destination no longer exists, so a new conversation id is reserved.
 */
export function renewDiscardedConversationDispatch(
  dispatchId: string,
  next: Pick<
    ConversationDispatchRecord,
    'conversationId' | 'conversationName' | 'branch' | 'baseRevision' | 'settings' | 'inherited' | 'workspaceId'
  >
): boolean {
  const changed = getDb()
    .prepare(
      `UPDATE conversation_dispatches
       SET conversation_id=?, conversation_name=?, branch=?, base_revision=?, settings_json=?, inherited_json=?,
           workspace_id=?, phase='reserved', error=NULL, updated_at=?
       WHERE dispatch_id=? AND phase='discarded'`
    )
    .run(
      next.conversationId,
      next.conversationName,
      next.branch,
      next.baseRevision,
      JSON.stringify(next.settings),
      JSON.stringify(next.inherited),
      next.workspaceId,
      Date.now(),
      dispatchId
    )
  return Number(changed.changes) > 0
}

/**
 * Compare-and-set phase transition. `from` guards against a concurrent transition (e.g. two retries racing to
 * start the same destination); returns false when the record was not in an allowed phase.
 */
export function transitionConversationDispatch(
  dispatchId: string,
  from: readonly ConversationDispatchPhase[],
  to: ConversationDispatchPhase,
  error: string | null = null
): boolean {
  if (!from.length) return false
  const changed = getDb()
    .prepare(
      `UPDATE conversation_dispatches SET phase=?, error=?, updated_at=?
       WHERE dispatch_id=? AND phase IN (${from.map(() => '?').join(',')})`
    )
    .run(to, error, Date.now(), dispatchId, ...from)
  return Number(changed.changes) > 0
}
