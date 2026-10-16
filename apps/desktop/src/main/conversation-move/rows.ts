import type { SQLInputValue } from 'node:sqlite'
import type { ConvUiPrefs } from '../../shared/conversation'
import type { ConversationExperience } from '../../shared/conversation-experience'
import { forgetChatStoreCaches, insertMovedChatMessages } from '../chat/chat-store'
import { deleteConversation, getConversation, insertConversation } from '../store/conversations'
import { getDb, transaction } from '../store/db'
import { MoveError } from './errors'

/**
 * The SQLite rows a conversation move carries, in foreign-key order. Provider sessions, inference sidecars,
 * compaction and memory state stay behind: they are bound to the source's runtime and are rebuilt from the transcript.
 */
export const MOVE_TABLES = [
  'chat_messages',
  'chat_tool_executions',
  'chat_subagent_sessions',
  'chat_subagent_transcript',
  'chat_maestro_runs',
  'chat_maestro_run_messages',
] as const
export type MoveTable = (typeof MOVE_TABLES)[number]

export interface MoveConversationRow {
  id: string
  name: string
  experience: string
  createdAt: number
  lastActivityAt: number
  pinnedAt: number | null
  uiPrefs: Record<string, unknown>
}

export interface MoveRows {
  conversation: MoveConversationRow
  tables: Record<MoveTable, Array<Record<string, unknown>>>
}

type Row = Record<string, unknown>

function all(sql: string, ...params: SQLInputValue[]): Row[] {
  return getDb()
    .prepare(sql)
    .all(...params) as Row[]
}

function inList(ids: string[]): string {
  return ids.map(() => '?').join(',')
}

export function readConversationRows(conversationId: string, now = Date.now()): MoveRows {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new MoveError('not-found', 'Conversation not found.')
  const messages = all('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq', conversationId)
  const toolExecutions = all('SELECT * FROM chat_tool_executions WHERE conversation_id = ?', conversationId)
  // A native subagent handle is bound to the source's runtime, and nothing runs while a conversation moves.
  const sessions = all('SELECT * FROM chat_subagent_sessions WHERE conversation_id = ?', conversationId).map(
    (row): Row => ({
      ...row,
      runtime_handle_json: null,
      ...(row.status === 'preparing' || row.status === 'running'
        ? { status: 'interrupted', finished_at: row.finished_at ?? now }
        : {}),
    })
  )
  const sessionIds = sessions.map((row) => String(row.id))
  const transcript = sessionIds.length
    ? all(`SELECT * FROM chat_subagent_transcript WHERE session_id IN (${inList(sessionIds)})`, ...sessionIds)
    : []
  const runs = all('SELECT * FROM chat_maestro_runs WHERE conversation_id = ?', conversationId).map((row) =>
    row.status === 'active' ? { ...row, status: 'interrupted', finished_at: row.finished_at ?? now } : row
  )
  const runIds = runs.map((row) => String(row.id))
  const runMessages = runIds.length
    ? all(`SELECT * FROM chat_maestro_run_messages WHERE run_id IN (${inList(runIds)})`, ...runIds).map((row) =>
        row.status === 'pending' ? { ...row, status: 'cancelled' } : row
      )
    : []
  return {
    conversation: {
      id: conversation.id,
      name: conversation.name,
      experience: conversation.experience,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      pinnedAt: conversation.pinnedAt,
      uiPrefs: hostIndependentPrefs(conversation.uiPrefs),
    },
    tables: {
      chat_messages: messages,
      chat_tool_executions: toolExecutions,
      chat_subagent_sessions: sessions,
      chat_subagent_transcript: transcript,
      chat_maestro_runs: runs,
      chat_maestro_run_messages: runMessages,
    },
  }
}

const SQL_VALUE_TYPES = new Set(['string', 'number', 'bigint'])
const OWNED_BY_CONVERSATION: ReadonlySet<MoveTable> = new Set([
  'chat_messages',
  'chat_tool_executions',
  'chat_subagent_sessions',
  'chat_maestro_runs',
])
function sqlValue(value: unknown, table: string, column: string): SQLInputValue {
  if (value === null || value === undefined) return null
  if (SQL_VALUE_TYPES.has(typeof value)) return value as SQLInputValue
  throw new MoveError('package-invalid', `Unexpected value in ${table}.${column}.`)
}

/**
 * The conversation's preferences without what belongs to this host: where its plugin `SessionStart` hooks last ran.
 * The destination's plugins are its own, so their hooks start the session again there (as `resume`).
 */
function hostIndependentPrefs(prefs: ConvUiPrefs | undefined): Record<string, unknown> {
  const { hookSession: _hookSession, ...rest } = prefs ?? {}
  return rest as Record<string, unknown>
}

/** Inserts a moved conversation with its own ids at its new location, in one transaction. */
export function insertConversationRows(
  rows: MoveRows,
  location: { workspaceId: string; branch: string; cwd: string }
): void {
  const { conversation } = rows
  transaction(() => {
    if (getConversation(conversation.id))
      throw new MoveError('conversation-exists', 'The conversation already exists on this host.')
    insertConversation({
      scope: 'project',
      id: conversation.id,
      workspaceId: location.workspaceId,
      name: conversation.name,
      branch: location.branch,
      mode: 'worktree',
      experience: conversation.experience as ConversationExperience,
      cwd: location.cwd,
      status: 'idle',
      createdAt: conversation.createdAt,
      archived: 0,
      pinnedAt: conversation.pinnedAt,
      lastActivityAt: conversation.lastActivityAt,
      isMulti: 0,
      uiPrefs: conversation.uiPrefs,
    })
    const db = getDb()
    for (const table of MOVE_TABLES) {
      const tableRows = rows.tables[table] ?? []
      if (!Array.isArray(tableRows)) throw new MoveError('package-invalid', `Rows of ${table} are malformed.`)
      if (tableRows.length === 0) continue
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      )
      const values = tableRows.map((row) => {
        if (!row || typeof row !== 'object') throw new MoveError('package-invalid', `A row of ${table} is malformed.`)
        const unknown = Object.keys(row).find((name) => !columns.has(name))
        if (unknown) throw new MoveError('package-invalid', `Schema mismatch: ${table}.${unknown}.`)
        if (OWNED_BY_CONVERSATION.has(table) && row.conversation_id !== conversation.id)
          throw new MoveError('package-invalid', `A row of ${table} belongs to another conversation.`)
        return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, sqlValue(value, table, name)]))
      })
      // Messages go through the chat store, which keeps what it derives from them coherent.
      if (table === 'chat_messages') {
        insertMovedChatMessages(conversation.id, values)
        continue
      }
      for (const row of values) {
        const names = Object.keys(row)
        db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(
          ...names.map((name) => row[name])
        )
      }
    }
  })
  forgetChatStoreCaches()
}

/** Removes a conversation an import inserted; its rows cascade with it. */
export function deleteImportedConversationRows(conversationId: string): void {
  deleteConversation(conversationId)
  forgetChatStoreCaches()
}
