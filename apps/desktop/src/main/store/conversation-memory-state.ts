import { getDb } from './db'

export interface MemoryCoreSource {
  key: string
  text: string
  hash: string
}

export interface ConversationMemoryState {
  conversationId: string
  spaceId: string
  coreEpoch: string
  coreText: string
  baseline: MemoryCoreSource[]
  recallEpoch: string
  recalledIds: string[]
  updatedAt: number
}

function parseJson<T>(raw: string, guard: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(guard) : []
  } catch {
    return []
  }
}
const isSource = (value: unknown): value is MemoryCoreSource =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as MemoryCoreSource).key === 'string' &&
  typeof (value as MemoryCoreSource).text === 'string' &&
  typeof (value as MemoryCoreSource).hash === 'string'
const isString = (value: unknown): value is string => typeof value === 'string'

export function getConversationMemoryState(conversationId: string): ConversationMemoryState | undefined {
  const row = getDb()
    .prepare('SELECT * FROM conversation_memory_state WHERE conversation_id = ?')
    .get(conversationId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    conversationId,
    spaceId: String(row.space_id),
    coreEpoch: String(row.core_epoch),
    coreText: String(row.core_text),
    baseline: parseJson(String(row.baseline_json), isSource),
    recallEpoch: String(row.recall_epoch),
    recalledIds: parseJson(String(row.recalled_json), isString),
    updatedAt: Number(row.updated_at),
  }
}

export function saveConversationMemoryState(state: ConversationMemoryState): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_memory_state
       (conversation_id, space_id, core_epoch, core_text, baseline_json, recall_epoch, recalled_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET space_id = excluded.space_id, core_epoch = excluded.core_epoch,
         core_text = excluded.core_text, baseline_json = excluded.baseline_json, recall_epoch = excluded.recall_epoch,
         recalled_json = excluded.recalled_json, updated_at = excluded.updated_at`
    )
    .run(
      state.conversationId,
      state.spaceId,
      state.coreEpoch,
      state.coreText,
      JSON.stringify(state.baseline),
      state.recallEpoch,
      JSON.stringify(state.recalledIds),
      state.updatedAt
    )
}

export function deleteConversationMemoryState(conversationId: string): void {
  getDb().prepare('DELETE FROM conversation_memory_state WHERE conversation_id = ?').run(conversationId)
}
