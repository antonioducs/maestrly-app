import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation, deleteWorkspace, getDb } from '../../src/main/store'
import {
  clearChatMessages,
  deleteChatMessage,
  deleteChatMessagesFrom,
  getMessageSeq,
  upsertChatMessage,
  updateChatMessageParts,
} from '../../src/main/chat/chat-store'
import {
  backfillHistoryConversation,
  drainHistoryQueue,
  forgetHistoryIndexState,
  HISTORY_INDEX_FILE,
  historyConversationsReady,
  historyIndexDb,
  historyIndexStatus,
  prepareHistoryConversations,
  resetHistoryIndex,
  runHistoryIndexStep,
} from '../../src/main/chat/history-index/store'
import { cjkGrams, extractHistoryDocument, historyEligible } from '../../src/main/chat/history-index/extract'
import type { MessagePart } from '../../src/shared/chat'

beforeEach(() => {
  forgetHistoryIndexState()
  freshDb()
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})

function say(conversationId: string, text: string, extra: Partial<Parameters<typeof upsertChatMessage>[0]> = {}) {
  const id = randomUUID()
  upsertChatMessage({
    id,
    conversationId,
    role: 'user',
    createdAt: Date.now(),
    parts: [{ type: 'text', id: randomUUID(), text }],
    ...extra,
  })
  return id
}

const queue = () =>
  (
    getDb().prepare('SELECT message_id FROM chat_history_index_queue ORDER BY message_id').all() as Array<{
      message_id: string
    }>
  ).map((row) => row.message_id)
const docs = (conversationId?: string) =>
  (
    getDb()
      .prepare(
        `SELECT message_id, indexed FROM history_index.history_docs ${conversationId ? 'WHERE conversation_id = ?' : ''}`
      )
      .all(...(conversationId ? [conversationId] : [])) as Array<{ message_id: string; indexed: number }>
  ).map((row) => `${row.message_id}:${row.indexed}`)
const words = (match: string) =>
  (getDb().prepare('SELECT rowid FROM history_index.history_words WHERE history_words MATCH ?').all(match) as unknown[])
    .length
const indexFile = () =>
  path.join(
    path.dirname(getDb().prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()!.file as string),
    HISTORY_INDEX_FILE
  )
const drainAll = () => {
  const db = historyIndexDb()!
  getDb().prepare('UPDATE chat_history_index_queue SET queued_at = 0').run()
  expect(drainHistoryQueue(db, Date.now() + 10_000)).toBe(true)
}

describe('history index queue', () => {
  it('records inserts, real changes, deletions and cascades, but not unchanged upserts', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const id = randomUUID()
    const message = {
      id,
      conversationId: conversation.id,
      role: 'assistant' as const,
      createdAt: Date.now(),
      parts: [{ type: 'text', id: 'p', text: 'draft' }] as MessagePart[],
    }
    upsertChatMessage(message)
    expect(queue()).toEqual([id])
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    upsertChatMessage(message)
    expect(queue()).toEqual([])
    upsertChatMessage({ ...message, parts: [{ type: 'text', id: 'p', text: 'final' }] })
    expect(queue()).toEqual([id])
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    updateChatMessageParts(conversation.id, id, [{ type: 'text', id: 'p', text: 'enriched' }])
    expect(queue()).toEqual([id])
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    deleteChatMessage(id)
    expect(queue()).toEqual([id])

    const other = makeConversation(workspace.id)
    const a = say(other.id, 'one')
    const b = say(other.id, 'two')
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    deleteWorkspace(workspace.id)
    expect(queue()).toEqual([a, b].sort())
  })
})

describe('history index', () => {
  it('indexes queued messages and removes deleted, truncated and cleared ones', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const kept = say(conversation.id, 'Compactação do bot')
    const removed = say(conversation.id, 'apagada depois')
    const truncated = say(conversation.id, 'cortada no truncate')
    drainAll()
    expect(queue()).toEqual([])
    expect(words('body : "compactacao"')).toBe(1)
    expect(words('body : "apagada"')).toBe(1)
    deleteChatMessage(removed)
    deleteChatMessagesFrom(conversation.id, getMessageSeq(truncated)!)
    drainAll()
    expect(words('body : "apagada"')).toBe(0)
    expect(words('body : "cortada"')).toBe(0)
    expect(docs()).toEqual([`${kept}:1`])
    await clearChatMessages(conversation.id)
    drainAll()
    expect(docs()).toEqual([])
    expect(words('body : "compactacao"')).toBe(0)
  })

  it('keeps ineligible messages out of the full-text tables', () => {
    const conversation = makeConversation(makeWorkspace().id)
    const internal = say(conversation.id, 'internal nudge', { internal: true })
    const plan = say(conversation.id, 'Implement.\n<approved_plan>\nplan body\n</approved_plan>', { internal: true })
    const isolated = say(conversation.id, 'review round', {
      executionScope: { kind: 'review-loop', executionId: 'e', loopId: 'l', iteration: 1, maxIterations: 2 },
    } as never)
    drainAll()
    expect(docs().sort()).toEqual([`${internal}:0`, `${isolated}:0`, `${plan}:1`].sort())
    expect(words('body : "nudge"')).toBe(0)
    expect(words('body : "round"')).toBe(0)
  })

  it('backfills an existing database newest first, resuming after a restart', () => {
    const conversation = makeConversation(makeWorkspace().id)
    const ids = Array.from({ length: 5 }, (_, index) => say(conversation.id, `old message ${index}`))
    // A database from before the index: messages exist, nothing is queued.
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    const db = historyIndexDb()!
    expect(historyConversationsReady(db, [conversation.id])).toBe(false)
    // An expired deadline still makes progress: one message, newest first.
    expect(backfillHistoryConversation(db, conversation.id, 0)).toBe(false)
    expect(docs()).toEqual([`${ids[4]}:1`])
    forgetHistoryIndexState()
    restartDb()
    expect(prepareHistoryConversations([conversation.id], 5_000)).toBe(true)
    expect(docs().sort()).toEqual(ids.map((id) => `${id}:1`).sort())
    expect(historyIndexStatus()).toMatchObject({ available: true, documents: 5, queued: 0 })
  })

  it('backfills in the background, starting with the most recently active conversation', () => {
    const workspace = makeWorkspace()
    const older = makeConversation(workspace.id, { lastActivityAt: 1 })
    const newer = makeConversation(workspace.id, { lastActivityAt: 2 })
    say(older.id, 'older')
    say(newer.id, 'newer')
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    historyIndexDb()
    runHistoryIndexStep(0)
    expect(docs(newer.id)).toHaveLength(1)
    expect(docs(older.id)).toHaveLength(0)
    for (let step = 0; step < 10 && runHistoryIndexStep(50); step++);
    expect(docs(older.id)).toHaveLength(1)
    expect(historyIndexStatus()).toMatchObject({ conversations: 2, completeConversations: 2 })
  })

  it('leaves unsettled queue rows to the background pass but not to a search', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'streaming now')
    expect(runHistoryIndexStep(50)).toBe(false)
    expect(queue()).toHaveLength(1)
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    expect(queue()).toEqual([])
  })

  it('rebuilds a corrupt index file', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'survives corruption')
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    const file = indexFile()
    forgetHistoryIndexState()
    getDb().exec('DETACH DATABASE history_index')
    writeFileSync(file, 'not a database at all, just garbage bytes '.repeat(200))
    for (const suffix of ['-wal', '-shm']) writeFileSync(`${file}${suffix}`, '')
    restartDb()
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    expect(words('body : "survives"')).toBe(1)
  })

  it('rebuilds an index written by another extractor version', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'reindexed after upgrade')
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    getDb().prepare("UPDATE history_index.history_meta SET value = 'old' WHERE key = 'extractor_version'").run()
    forgetHistoryIndexState()
    restartDb()
    historyIndexDb()
    expect(docs()).toEqual([])
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    expect(words('body : "reindexed"')).toBe(1)
  })

  it('keeps search usable without FTS5 trigram support and stops the queue from growing', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'no trigram here')
    const exec = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes('history_index_probe')) throw new Error('no such tokenizer: trigram')
      return exec.call(this, sql)
    })
    expect(historyIndexDb()).toBeNull()
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(false)
    expect(runHistoryIndexStep(50)).toBe(false)
    expect(queue()).toEqual([])
    expect(existsSync(indexFile())).toBe(false)
  })

  it('drops the index file and pending changes on local data reset', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'to be reset')
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    say(conversation.id, 'still queued')
    expect(existsSync(indexFile())).toBe(true)
    resetHistoryIndex()
    expect(existsSync(indexFile())).toBe(false)
    expect(queue()).toEqual([])
  })

  it('cleans up progress rows of deleted conversations', () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'gone soon')
    expect(prepareHistoryConversations([conversation.id], 1_000)).toBe(true)
    deleteConversation(conversation.id)
    drainAll()
    runHistoryIndexStep(50)
    expect(docs()).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM history_index.history_conversations').get()).toMatchObject({
      n: 0,
    })
  })
})

describe('history extraction', () => {
  it('indexes visible text and shortened tool calls, without memory blocks or history tool echoes', () => {
    const document = extractHistoryDocument(
      JSON.stringify([
        { type: 'text', id: 't', text: 'Rodei os testes' },
        { type: 'text', id: 'n', text: 'native checkpoint', checkpoint: 'openai-native' },
        {
          type: 'file',
          id: 'f',
          name: 'maestrly-memory-recall',
          mediaType: 'text/markdown',
          kind: 'text',
          data: 'SECRET',
          hidden: true,
        },
        {
          type: 'tool',
          id: 'a',
          toolCallId: 'a',
          toolName: 'terminal_run',
          input: { command: 'npm test' },
          state: { status: 'completed', output: `PASS ${'x'.repeat(5_000)}` },
        },
        {
          type: 'tool',
          id: 'b',
          toolCallId: 'b',
          toolName: 'mcp__maestrly__history_search',
          input: { query: 'echo' },
          state: { status: 'completed', output: 'ECHOED RESULT' },
        },
      ]),
      null
    )
    expect(document.body).toBe('rodei os testes')
    expect(document.tools).toContain('[tool terminal_run] {"command":"npm test"} pass')
    expect(document.tools).not.toContain('echoed result')
    expect(document.tools.length).toBeLessThan(2_700)
    expect(document.body + document.tools).not.toContain('secret')
  })

  it('splits CJK runs into bigrams and follows the main-context rule', () => {
    expect(cjkGrams('機能テスト ok 字')).toBe('機能 能テ テス スト 字')
    expect(historyEligible('not json', 'x')).toBe(true)
    expect(historyEligible(JSON.stringify({ executionScope: { kind: 'conversation' } }), 'x')).toBe(true)
    expect(historyEligible(JSON.stringify({ executionScope: { kind: 'review-loop' } }), 'x')).toBe(false)
    expect(historyEligible(JSON.stringify({ internal: true }), '<approved_plan>')).toBe(true)
    expect(historyEligible(JSON.stringify({ internal: true }), 'x')).toBe(false)
  })
})
