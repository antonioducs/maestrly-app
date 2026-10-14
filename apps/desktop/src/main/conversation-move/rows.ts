/** The SQLite rows a conversation move carries, in foreign-key order. */
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
