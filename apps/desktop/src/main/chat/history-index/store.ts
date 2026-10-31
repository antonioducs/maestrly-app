import { rmSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, inTransaction, transaction } from '../../store'
import { conversationToken, extractHistoryDocument, HISTORY_EXTRACTOR_VERSION, historyDocumentHash } from './extract'

/**
 * The conversation-history search index: a rebuildable SQLite file next to the main database, attached to its
 * connection so queries can join `chat_messages` (a stale index can never surface a deleted message) and so it
 * closes with the store. Word (unicode61) and trigram FTS5 tables are contentless: the text stays in
 * `chat_messages` only. Any fault in the file rebuilds it; search then falls back to scanning messages.
 */
export const HISTORY_INDEX_FILE = 'maestrly-history-index.sqlite'
const SCHEMA = 'history_index'
const SCHEMA_VERSION = '1'
/** Queue rows this recent may still be streaming; the background pass leaves them for later. */
export const HISTORY_QUEUE_SETTLE_MS = 3_000
const BATCH = 64
const RETRY_AFTER_FAILURE_MS = 60_000

type State =
  | { db: DatabaseSync; kind: 'attached'; file: string }
  | { db: DatabaseSync; kind: 'unsupported' }
  | { db: DatabaseSync; kind: 'failed'; at: number }
let state: State | null = null
let priorityConversation: string | null = null

const now = () => Date.now()

function mainFile(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as
    | { file?: string }
    | undefined
  return row?.file ? path.join(path.dirname(row.file), HISTORY_INDEX_FILE) : null
}

/** Contentless-delete tables (SQLite 3.43) and the trigram tokenizer (3.34); without them search keeps scanning. */
function supportsIndex(db: DatabaseSync): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.history_index_probe USING fts5(x, content='', contentless_delete=1, tokenize='trigram');
      DROP TABLE temp.history_index_probe;`)
    return true
  } catch {
    return false
  }
}

function removeFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true })
}

function detach(db: DatabaseSync): void {
  try {
    db.exec(`DETACH DATABASE ${SCHEMA}`)
  } catch {
    // Not attached.
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA ${SCHEMA}.journal_mode = WAL;
    PRAGMA ${SCHEMA}.synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- The index's own ids: rowids of chat_messages are not stable across VACUUM.
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.history_docs (
      doc_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      indexed         INTEGER NOT NULL,
      partial         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ${SCHEMA}.idx_history_docs_conversation ON history_docs(conversation_id, indexed);
    CREATE INDEX IF NOT EXISTS ${SCHEMA}.idx_history_docs_partial ON history_docs(conversation_id) WHERE partial = 1;
    -- Backfill progress per conversation: messages below backfill_below are still to check.
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.history_conversations (
      conversation_id TEXT PRIMARY KEY,
      backfill_below  INTEGER,
      complete        INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${SCHEMA}.history_words USING fts5(
      body, tools, cjk, conv,
      content = '', contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${SCHEMA}.history_trigram USING fts5(
      body,
      content = '', contentless_delete = 1,
      tokenize = 'trigram'
    );
  `)
  for (const table of ['history_words', 'history_trigram']) {
    try {
      // Deleted terms are removed from the file, not just unlinked.
      db.exec(`INSERT INTO ${SCHEMA}.${table}(${table}, rank) VALUES ('secure-delete', 1)`)
    } catch {
      // Older SQLite: deletions still stop matching.
    }
  }
}

/** True when the file was created by this schema and extractor; a new file is stamped. */
function compatible(db: DatabaseSync): boolean {
  const expected: Record<string, string> = {
    schema_version: SCHEMA_VERSION,
    extractor_version: HISTORY_EXTRACTOR_VERSION,
  }
  const read = db.prepare(`SELECT value FROM ${SCHEMA}.history_meta WHERE key = ?`)
  const write = db.prepare(`INSERT OR REPLACE INTO ${SCHEMA}.history_meta(key, value) VALUES (?, ?)`)
  for (const [key, value] of Object.entries(expected)) {
    const row = read.get(key) as { value: string } | undefined
    if (row && row.value !== value) return false
  }
  for (const [key, value] of Object.entries(expected)) write.run(key, value)
  return true
}

function attach(db: DatabaseSync, file: string): void {
  db.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(file)
  try {
    createSchema(db)
    if (compatible(db)) return
  } catch (error) {
    detach(db)
    throw error
  }
  detach(db)
  removeFiles(file)
  db.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(file)
  createSchema(db)
  compatible(db)
}

/**
 * The main connection with the index attached, or null while it cannot be used (unsupported SQLite, a failed open
 * waiting to retry, or inside a caller's transaction, where ATTACH is not allowed).
 */
export function historyIndexDb(): DatabaseSync | null {
  const db = getDb()
  if (!db) return null
  if (state?.db === db) {
    if (state.kind === 'attached') return db
    if (state.kind === 'unsupported') return null
    if (now() - state.at < RETRY_AFTER_FAILURE_MS) return null
  }
  if (inTransaction()) return null
  const file = mainFile(db)
  if (!file || !supportsIndex(db)) {
    state = { db, kind: 'unsupported' }
    // The queue is pruned from now on, so progress kept in an older file would no longer be true.
    if (file) {
      try {
        removeFiles(file)
      } catch {
        // Retried by the next process start.
      }
    }
    return null
  }
  try {
    attach(db, file)
  } catch (first) {
    // A corrupt or foreign file is a cache: start over once.
    try {
      detach(db)
      removeFiles(file)
      attach(db, file)
      console.warn('[history-index] rebuilt:', first instanceof Error ? first.message : first)
    } catch (error) {
      console.warn('[history-index] unavailable:', error instanceof Error ? error.message : error)
      state = { db, kind: 'failed', at: now() }
      return null
    }
  }
  state = { db, kind: 'attached', file }
  return db
}

/** Whether this SQLite can host the index at all (a disabled index never blocks search). */
export function historyIndexUnsupported(): boolean {
  historyIndexDb()
  return state?.db === getDb() && state.kind === 'unsupported'
}

/** Drops the index file; the next use rebuilds it from `chat_messages`. */
export function discardHistoryIndex(reason?: unknown): void {
  const db = getDb()
  if (!db || inTransaction()) return
  const file = state?.db === db && state.kind === 'attached' ? state.file : mainFile(db)
  detach(db)
  state = null
  if (file) {
    try {
      removeFiles(file)
    } catch (error) {
      console.warn('[history-index] could not remove the index:', error instanceof Error ? error.message : error)
    }
  }
  if (reason !== undefined)
    console.warn('[history-index] discarded:', reason instanceof Error ? reason.message : reason)
}

/** Local data reset: the index and its pending changes go with the conversations. */
export function resetHistoryIndex(): void {
  discardHistoryIndex()
  getDb().prepare('DELETE FROM chat_history_index_queue').run()
}

// A query syntax error is not a fault of the file; corruption reads as SQLITE_CORRUPT ("disk image is malformed").
const FAULT = /corrupt|malformed|not a database|disk image|no such (?:table|column)|database schema/i
const isFault = (error: unknown) => FAULT.test(error instanceof Error ? error.message : String(error))

/** Indexes one message; an error that is not the file's fault skips it, so one bad row cannot stall the queue. */
function indexOrSkip(db: DatabaseSync, messageId: string): void {
  try {
    indexHistoryMessage(db, messageId)
  } catch (error) {
    if (isFault(error)) throw error
    console.warn('[history-index] skipped a message:', error instanceof Error ? error.message : error)
  }
}

/** Runs an index operation; a fault in the index file discards it so the next use rebuilds. */
export function withHistoryIndex<T>(fallback: T, operation: (db: DatabaseSync) => T): T {
  const db = historyIndexDb()
  if (!db) return fallback
  try {
    return operation(db)
  } catch (error) {
    if (isFault(error)) discardHistoryIndex(error)
    else console.warn('[history-index] operation failed:', error instanceof Error ? error.message : error)
    return fallback
  }
}

type DocRow = { doc_id: number; conversation_id: string; content_hash: string; indexed: number }

function removeFts(db: DatabaseSync, docId: number): void {
  db.prepare(`DELETE FROM ${SCHEMA}.history_words WHERE rowid = ?`).run(docId)
  db.prepare(`DELETE FROM ${SCHEMA}.history_trigram WHERE rowid = ?`).run(docId)
}

/** Brings one message's entry in line with `chat_messages`: added, replaced, emptied or removed. */
export function indexHistoryMessage(db: DatabaseSync, messageId: string): void {
  const row = db
    .prepare('SELECT conversation_id, parts_json, meta_json FROM main.chat_messages WHERE id = ?')
    .get(messageId) as { conversation_id: string; parts_json: string | null; meta_json: string | null } | undefined
  const existing = db
    .prepare(`SELECT doc_id, conversation_id, content_hash, indexed FROM ${SCHEMA}.history_docs WHERE message_id = ?`)
    .get(messageId) as DocRow | undefined
  if (!row) {
    if (!existing) return
    if (existing.indexed) removeFts(db, existing.doc_id)
    db.prepare(`DELETE FROM ${SCHEMA}.history_docs WHERE doc_id = ?`).run(existing.doc_id)
    return
  }
  const document = extractHistoryDocument(row.parts_json, row.meta_json)
  const indexed = document.eligible && (document.body.length > 0 || document.tools.length > 0)
  const hash = indexed ? historyDocumentHash(document) : 'empty'
  if (existing && existing.content_hash === hash && existing.conversation_id === row.conversation_id) return
  let docId: number
  if (existing) {
    if (existing.indexed) removeFts(db, existing.doc_id)
    db.prepare(
      `UPDATE ${SCHEMA}.history_docs SET conversation_id = ?, content_hash = ?, indexed = ?, partial = ? WHERE doc_id = ?`
    ).run(row.conversation_id, hash, indexed ? 1 : 0, indexed && document.partial ? 1 : 0, existing.doc_id)
    docId = existing.doc_id
  } else {
    docId = Number(
      db
        .prepare(
          `INSERT INTO ${SCHEMA}.history_docs (message_id, conversation_id, content_hash, indexed, partial)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(messageId, row.conversation_id, hash, indexed ? 1 : 0, indexed && document.partial ? 1 : 0).lastInsertRowid
    )
  }
  if (!indexed) return
  db.prepare(`INSERT INTO ${SCHEMA}.history_words (rowid, body, tools, cjk, conv) VALUES (?, ?, ?, ?, ?)`).run(
    docId,
    document.body,
    document.tools,
    document.cjk,
    conversationToken(row.conversation_id)
  )
  if (document.trigram) {
    db.prepare(`INSERT INTO ${SCHEMA}.history_trigram (rowid, body) VALUES (?, ?)`).run(docId, document.trigram)
  }
}

type QueueRow = { message_id: string; queued_at: number }

/**
 * Applies queued changes, oldest first, until the deadline: for one conversation (everything, so a search sees the
 * latest turn) or across conversations (only settled rows). The index commits before the queue rows go, so a crash in
 * between only repeats work. Returns true when nothing selectable is left.
 */
export function drainHistoryQueue(
  db: DatabaseSync,
  deadline: number,
  options: { conversationId?: string } = {}
): boolean {
  const select = options.conversationId
    ? db.prepare(
        `SELECT message_id, queued_at FROM main.chat_history_index_queue WHERE conversation_id = ?
         ORDER BY queued_at LIMIT ${BATCH}`
      )
    : db.prepare(
        `SELECT message_id, queued_at FROM main.chat_history_index_queue WHERE queued_at <= ?
         ORDER BY queued_at LIMIT ${BATCH}`
      )
  const forget = db.prepare('DELETE FROM main.chat_history_index_queue WHERE message_id = ? AND queued_at = ?')
  for (;;) {
    const rows = select.all(options.conversationId ?? now() - HISTORY_QUEUE_SETTLE_MS) as QueueRow[]
    if (!rows.length) return true
    const done: QueueRow[] = []
    transaction(() => {
      for (const row of rows) {
        indexOrSkip(db, row.message_id)
        done.push(row)
        if (now() >= deadline) break
      }
    })
    transaction(() => {
      for (const row of done) forget.run(row.message_id, row.queued_at)
    })
    if (done.length < rows.length || now() >= deadline) return false
  }
}

/** Indexes a conversation's existing messages, newest first, from where it stopped. True once all are covered. */
export function backfillHistoryConversation(db: DatabaseSync, conversationId: string, deadline: number): boolean {
  const progress = db
    .prepare(`SELECT backfill_below, complete FROM ${SCHEMA}.history_conversations WHERE conversation_id = ?`)
    .get(conversationId) as { backfill_below: number | null; complete: number } | undefined
  if (progress?.complete) return true
  let below = progress?.backfill_below ?? Number.MAX_SAFE_INTEGER
  const page = db.prepare(
    `SELECT id, seq FROM main.chat_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ${BATCH}`
  )
  const known = db.prepare(`SELECT 1 FROM ${SCHEMA}.history_docs WHERE message_id = ?`)
  const save = db.prepare(
    `INSERT INTO ${SCHEMA}.history_conversations (conversation_id, backfill_below, complete) VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET backfill_below = excluded.backfill_below, complete = excluded.complete`
  )
  for (;;) {
    const rows = page.all(conversationId, below) as Array<{ id: string; seq: number }>
    if (!rows.length) {
      save.run(conversationId, null, 1)
      return true
    }
    transaction(() => {
      for (const row of rows) {
        if (!known.get(row.id)) indexOrSkip(db, row.id)
        below = Number(row.seq)
        if (now() >= deadline) break
      }
      save.run(conversationId, below, 0)
    })
    if (now() >= deadline) return false
  }
}

/** True when every message of these conversations is indexed and nothing of theirs waits in the queue. */
export function historyConversationsReady(db: DatabaseSync, conversationIds: readonly string[]): boolean {
  if (!conversationIds.length) return true
  const marks = conversationIds.map(() => '?').join(',')
  const complete = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${SCHEMA}.history_conversations WHERE complete = 1 AND conversation_id IN (${marks})`
        )
        .get(...conversationIds) as { n: number }
    ).n
  )
  if (complete < conversationIds.length) return false
  return !db
    .prepare(`SELECT 1 FROM main.chat_history_index_queue WHERE conversation_id IN (${marks}) LIMIT 1`)
    .get(...conversationIds)
}

/**
 * Brings these conversations up to date within the budget, before a search reads them. Whatever is left becomes the
 * background pass's priority. Returns whether all are ready.
 */
export function prepareHistoryConversations(conversationIds: readonly string[], budgetMs: number): boolean {
  return withHistoryIndex(false, (db) => {
    const deadline = now() + budgetMs
    for (const conversationId of conversationIds) {
      if (now() >= deadline) break
      if (!drainHistoryQueue(db, deadline, { conversationId })) break
      if (!backfillHistoryConversation(db, conversationId, deadline)) break
    }
    const ready = historyConversationsReady(db, conversationIds)
    if (!ready) {
      const pending = conversationIds.find(
        (id) =>
          !(
            db.prepare(`SELECT complete FROM ${SCHEMA}.history_conversations WHERE conversation_id = ?`).get(id) as
              | { complete: number }
              | undefined
          )?.complete
      )
      if (pending) priorityConversation = pending
    }
    return ready
  })
}

let lastSweep = 0
const SWEEP_EVERY_MS = 60_000

/**
 * One slice of background work: settled queue rows, then the backfill of the conversation a search waited on or the
 * most recently active one not yet covered. Returns true while more work remains.
 */
export function runHistoryIndexStep(budgetMs: number): boolean {
  const db = getDb()
  if (!db || inTransaction()) return false
  if (historyIndexUnsupported()) {
    // Nothing can consume the queue on this SQLite: keep it from growing.
    db.prepare('DELETE FROM chat_history_index_queue').run()
    return false
  }
  return withHistoryIndex(false, (indexDb) => {
    const deadline = now() + budgetMs
    if (!drainHistoryQueue(indexDb, deadline)) return true
    for (;;) {
      const next =
        priorityConversation ??
        (
          indexDb
            .prepare(
              `SELECT c.id FROM main.conversations c
               LEFT JOIN ${SCHEMA}.history_conversations h ON h.conversation_id = c.id
               WHERE COALESCE(h.complete, 0) = 0
               ORDER BY c.last_activity_at DESC LIMIT 1`
            )
            .get() as { id: string } | undefined
        )?.id
      if (!next) break
      const done = backfillHistoryConversation(indexDb, next, deadline)
      if (!done) return true
      if (priorityConversation === next) priorityConversation = null
      if (now() >= deadline) return true
    }
    if (now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = now()
      // Deleted conversations: their messages left through the queue; their progress rows go here.
      indexDb
        .prepare(
          `DELETE FROM ${SCHEMA}.history_conversations
           WHERE conversation_id NOT IN (SELECT id FROM main.conversations)`
        )
        .run()
    }
    return false
  })
}

export interface HistoryIndexStatus {
  available: boolean
  documents: number
  queued: number
  conversations: number
  completeConversations: number
}

export function historyIndexStatus(): HistoryIndexStatus {
  const queued = Number(
    (getDb().prepare('SELECT COUNT(*) AS n FROM chat_history_index_queue').get() as { n: number }).n
  )
  return withHistoryIndex<HistoryIndexStatus>(
    { available: false, documents: 0, queued, conversations: 0, completeConversations: 0 },
    (db) => {
      const docs = db.prepare(`SELECT COUNT(*) AS n FROM ${SCHEMA}.history_docs WHERE indexed = 1`).get() as {
        n: number
      }
      const progress = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM main.conversations) AS total,
             (SELECT COUNT(*) FROM ${SCHEMA}.history_conversations h JOIN main.conversations c ON c.id = h.conversation_id
              WHERE h.complete = 1) AS complete`
        )
        .get() as { total: number; complete: number }
      return {
        available: true,
        documents: Number(docs.n),
        queued,
        conversations: Number(progress.total),
        completeConversations: Number(progress.complete),
      }
    }
  )
}

/** Test hook: forget the cached connection state (the next use re-detects and re-attaches). */
export function forgetHistoryIndexState(): void {
  state = null
  priorityConversation = null
  lastSweep = 0
}
