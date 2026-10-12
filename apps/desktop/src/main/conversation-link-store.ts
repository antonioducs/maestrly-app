import { getDb, transaction } from './store'
import type {
  ConversationPeerMessageKind,
  ConversationRelation,
  ConversationTurnResultStatus,
} from '../shared/conversation-link'

export type ConversationPeerMessagePhase = 'queued' | 'delivered' | 'reported' | 'failed'

/**
 * Durable journal entry for one message between conversations. `queued` waits for the target to be free;
 * `delivered` started a turn there; `reported` delivered and its requested result was already sent back.
 */
export interface ConversationPeerMessageRecord {
  messageId: string
  fromConversationId: string
  toConversationId: string
  /** `message:<id of the sending turn's message>`, `result:<messageId>` or `dispatch-result:<dispatchId>`. */
  originKey: string
  dedupeKey: string
  kind: ConversationPeerMessageKind
  body: string
  /** Agent-to-agent turns since the last message a person typed, counting the turn this message starts. */
  hop: number
  /** The sender wants the final answer of the turn this message starts. */
  reportBack: boolean
  resultStatus: ConversationTurnResultStatus | null
  phase: ConversationPeerMessagePhase
  error: string | null
  createdAt: number
  updatedAt: number
}

export type NewConversationPeerMessage = Omit<ConversationPeerMessageRecord, 'phase' | 'error' | 'createdAt' | 'updatedAt'>

type Row = Omit<ConversationPeerMessageRecord, 'reportBack'> & { reportBack: number }

const columns = `message_id AS messageId, from_conversation_id AS fromConversationId,
  to_conversation_id AS toConversationId, origin_key AS originKey, dedupe_key AS dedupeKey, kind, body, hop,
  report_back AS reportBack, result_status AS resultStatus, phase, error, created_at AS createdAt,
  updated_at AS updatedAt`

function fromRow(row: Row | undefined): ConversationPeerMessageRecord | null {
  if (!row) return null
  return { ...row, hop: Number(row.hop), reportBack: Number(row.reportBack) === 1 }
}

function find(fromConversationId: string, originKey: string, dedupeKey: string): ConversationPeerMessageRecord | null {
  return fromRow(
    getDb()
      .prepare(
        `SELECT ${columns} FROM conversation_peer_messages
         WHERE from_conversation_id=? AND origin_key=? AND dedupe_key=?`
      )
      .get(fromConversationId, originKey, dedupeKey) as Row | undefined
  )
}

export function getPeerMessage(messageId: string): ConversationPeerMessageRecord | null {
  return fromRow(
    getDb().prepare(`SELECT ${columns} FROM conversation_peer_messages WHERE message_id=?`).get(messageId) as
      | Row
      | undefined
  )
}

/**
 * Insert a queued message. Returns the existing record instead when the same (sender, origin, dedupe key) was
 * already recorded, so a repeated send replays instead of delivering twice.
 */
export function reservePeerMessage(value: NewConversationPeerMessage): {
  record: ConversationPeerMessageRecord
  created: boolean
} {
  let result = null as { record: ConversationPeerMessageRecord; created: boolean } | null
  transaction(() => {
    const existing = find(value.fromConversationId, value.originKey, value.dedupeKey)
    if (existing) {
      result = { record: existing, created: false }
      return
    }
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO conversation_peer_messages
         (message_id, from_conversation_id, to_conversation_id, origin_key, dedupe_key, kind, body, hop, report_back,
          result_status, phase, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`
      )
      .run(
        value.messageId,
        value.fromConversationId,
        value.toConversationId,
        value.originKey,
        value.dedupeKey,
        value.kind,
        value.body,
        value.hop,
        value.reportBack ? 1 : 0,
        value.resultStatus,
        now,
        now
      )
    result = { record: getPeerMessage(value.messageId)!, created: true }
  })
  return result!
}

/** Compare-and-set phase transition; false when the record was not in an allowed phase. */
export function transitionPeerMessage(
  messageId: string,
  from: readonly ConversationPeerMessagePhase[],
  to: ConversationPeerMessagePhase,
  error: string | null = null
): boolean {
  if (!from.length) return false
  const changed = getDb()
    .prepare(
      `UPDATE conversation_peer_messages SET phase=?, error=?, updated_at=?
       WHERE message_id=? AND phase IN (${from.map(() => '?').join(',')})`
    )
    .run(to, error, Date.now(), messageId, ...from)
  return Number(changed.changes) > 0
}

/** Messages waiting for a busy target, oldest first. */
export function listQueuedPeerMessagesTo(toConversationId: string): ConversationPeerMessageRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT ${columns} FROM conversation_peer_messages WHERE to_conversation_id=? AND phase='queued'
       ORDER BY created_at, rowid`
    )
    .all(toConversationId) as unknown as Row[]
  return rows.map((row) => fromRow(row)!)
}

export function listPeerMessagesInPhases(
  phases: readonly ConversationPeerMessagePhase[]
): ConversationPeerMessageRecord[] {
  if (!phases.length) return []
  const rows = getDb()
    .prepare(
      `SELECT ${columns} FROM conversation_peer_messages WHERE phase IN (${phases.map(() => '?').join(',')})
       ORDER BY created_at, rowid`
    )
    .all(...phases) as unknown as Row[]
  return rows.map((row) => fromRow(row)!)
}

export function hasQueuedPeerMessage(fromConversationId: string, toConversationId: string): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM conversation_peer_messages
       WHERE from_conversation_id=? AND to_conversation_id=? AND phase='queued' LIMIT 1`
    )
    .get(fromConversationId, toConversationId)
}

const LINKING_DISPATCH_PHASES = `('prepared','starting','started','start-failed')`

/** Every conversation related to `conversationId`; a dispatch relation wins over exchanged messages. */
export function conversationRelations(conversationId: string): Map<string, ConversationRelation> {
  const db = getDb()
  const relations = new Map<string, ConversationRelation>()
  const peers = db
    .prepare(
      `SELECT DISTINCT CASE WHEN from_conversation_id=? THEN to_conversation_id ELSE from_conversation_id END AS id
       FROM conversation_peer_messages
       WHERE (from_conversation_id=? OR to_conversation_id=?) AND phase <> 'failed'`
    )
    .all(conversationId, conversationId, conversationId) as Array<{ id: string }>
  for (const peer of peers) relations.set(peer.id, 'linked')
  const children = db
    .prepare(
      `SELECT conversation_id AS id FROM conversation_dispatches
       WHERE source_conversation_id=? AND phase IN ${LINKING_DISPATCH_PHASES}`
    )
    .all(conversationId) as Array<{ id: string }>
  for (const child of children) relations.set(child.id, 'child')
  const sources = db
    .prepare(
      `SELECT source_conversation_id AS id FROM conversation_dispatches
       WHERE conversation_id=? AND phase IN ${LINKING_DISPATCH_PHASES}`
    )
    .all(conversationId) as Array<{ id: string }>
  for (const source of sources) relations.set(source.id, 'source')
  relations.delete(conversationId)
  return relations
}

/** Relation of `other` as seen from `conversationId`; dispatch relations win over 'linked'. */
export function relationBetween(conversationId: string, other: string): ConversationRelation | null {
  if (conversationId === other) return null
  const db = getDb()
  const dispatch = (source: string, destination: string) =>
    !!db
      .prepare(
        `SELECT 1 FROM conversation_dispatches
         WHERE source_conversation_id=? AND conversation_id=? AND phase IN ${LINKING_DISPATCH_PHASES} LIMIT 1`
      )
      .get(source, destination)
  if (dispatch(other, conversationId)) return 'source'
  if (dispatch(conversationId, other)) return 'child'
  const linked = db
    .prepare(
      `SELECT 1 FROM conversation_peer_messages
       WHERE ((from_conversation_id=? AND to_conversation_id=?) OR (from_conversation_id=? AND to_conversation_id=?))
         AND phase <> 'failed' LIMIT 1`
    )
    .get(conversationId, other, other, conversationId)
  return linked ? 'linked' : null
}

/** Sender of the latest delivered message or report to this conversation (results do not hand over work). */
export function latestPeerSender(conversationId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT from_conversation_id AS id FROM conversation_peer_messages
       WHERE to_conversation_id=? AND kind IN ('message','report') AND phase IN ('delivered','reported')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(conversationId) as { id: string } | undefined
  return row?.id ?? null
}
