import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { forgetHistoryIndexState } from '../../src/main/chat/history-index/store'
import { searchHistory, trigramQuery, type HistorySearchOptions } from '../../src/main/chat/history-index/search'
import type { MessagePart } from '../../src/shared/chat'

beforeEach(() => {
  forgetHistoryIndexState()
  freshDb()
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})

const DAY = 86_400_000
let clock = Date.now() - 400 * DAY

function say(
  conversationId: string,
  text: string,
  options: { role?: 'user' | 'assistant'; at?: number; parts?: object[]; extra?: object } = {}
): string {
  const id = randomUUID()
  clock += 1_000
  upsertChatMessage({
    id,
    conversationId,
    role: options.role ?? 'user',
    createdAt: options.at ?? clock,
    parts: [{ type: 'text', id: randomUUID(), text }, ...((options.parts ?? []) as MessagePart[])],
    ...(options.extra ?? {}),
  })
  return id
}

async function search(conversationId: string, query: string, options: Partial<HistorySearchOptions> = {}) {
  return searchHistory({ conversationIds: [conversationId], query, ...options })
}
const snippets = (result: Awaited<ReturnType<typeof search>>) => result.hits.map((hit) => hit.snippet)

describe('history search by relevance', () => {
  it('ranks a message covering every term above a newer one that covers fewer', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'Decidimos usar Postgres com particionamento por tenant')
    say(conversation.id, 'unrelated chatter about lunch')
    say(conversation.id, 'Postgres está lento hoje', { at: Date.now() })
    const result = await search(conversation.id, 'particionamento postgres')
    expect(result.mode).toBe('relevance')
    expect(result.building).toBeUndefined()
    expect(snippets(result)[0]).toContain('particionamento')
    expect(snippets(result)[1]).toContain('lento')
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score!)
    expect(snippets(result).join()).not.toContain('lunch')
  })

  it('matches word stems regardless of accents and case', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'A compactação do bot terminou')
    say(conversation.id, 'filler')
    say(conversation.id, 'Vamos compactar de novo amanhã')
    const hits = (await search(conversation.id, 'COMPACTACAO')).hits
    expect(hits).toHaveLength(2)
  })

  it('keeps quoted phrases together', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'edited src/main/chat/chat-store.ts')
    say(conversation.id, 'store the chat transcript')
    expect(snippets(await search(conversation.id, '"chat store"'))).toEqual(['edited src/main/chat/chat-store.ts'])
  })

  it('finds parts of words and CJK text through the trigram and bigram indexes', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'Background compaction finished')
    say(conversation.id, '新しい機能テストを追加しました')
    say(conversation.id, '数据库迁移完成')
    expect(snippets(await search(conversation.id, 'paction'))).toEqual(['Background compaction finished'])
    expect(snippets(await search(conversation.id, 'テスト'))).toEqual(['新しい機能テストを追加しました'])
    expect(snippets(await search(conversation.id, '機能'))).toEqual(['新しい機能テストを追加しました'])
    expect(snippets(await search(conversation.id, '迁移'))).toEqual(['数据库迁移完成'])
  })

  it('finds content from before a compaction and marks the compaction summary', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'The flaky test was caused by the timezone offset')
    say(conversation.id, 'filler')
    say(conversation.id, '', {
      role: 'assistant',
      parts: [{ type: 'compaction', id: randomUUID(), text: 'Summary: fixed the timezone offset in tests' }],
    })
    say(conversation.id, 'next topic')
    const result = await search(conversation.id, 'timezone offset')
    expect(result.hits.map((hit) => hit.kind ?? 'message').sort()).toEqual(['compaction', 'message'])
  })

  it('searches tool calls but never memory blocks, history tool echoes, internal or isolated messages', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'ran the suite', {
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          id: 't',
          toolCallId: 't',
          toolName: 'terminal_run',
          input: { command: 'npm test' },
          state: { status: 'completed', output: 'FAIL test/unit/quokka.test.ts' },
        },
        {
          type: 'tool',
          id: 'h',
          toolCallId: 'h',
          toolName: 'history_search',
          input: { query: 'x' },
          state: { status: 'completed', output: 'wombat from an earlier search' },
        },
      ],
    })
    say(conversation.id, 'question', {
      parts: [
        {
          type: 'file',
          id: 'f',
          name: 'maestrly-memory-recall',
          mediaType: 'text/markdown',
          kind: 'text',
          data: 'platypus recalled',
          hidden: true,
        },
      ],
    })
    say(conversation.id, 'internal echidna nudge', { extra: { internal: true } })
    say(conversation.id, 'Implement.\n<approved_plan>\nechidna plan\n</approved_plan>', { extra: { internal: true } })
    say(conversation.id, 'review echidna round', {
      extra: {
        executionScope: { kind: 'review-loop', executionId: 'e', loopId: 'l', iteration: 1, maxIterations: 2 },
      },
    })
    const tool = await search(conversation.id, 'quokka')
    expect(tool.hits).toHaveLength(1)
    expect(tool.hits[0].snippet).toContain('quokka')
    for (const query of ['wombat', 'platypus']) expect((await search(conversation.id, query)).hits).toEqual([])
    expect(snippets(await search(conversation.id, 'echidna'))).toEqual([
      'Implement. <approved_plan> echidna plan </approved_plan>',
    ])
  })

  it('collapses repeated prompts and neighbouring hits', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    const oldest = say(conversation.id, 'please deploy the staging server')
    say(conversation.id, 'filler one')
    say(conversation.id, 'filler two')
    const resent = say(conversation.id, 'please deploy the staging server')
    say(conversation.id, 'filler three')
    say(conversation.id, 'filler four')
    const answer = say(conversation.id, 'staging deploy done', { role: 'assistant' })
    const followUp = say(conversation.id, 'staging deploy done, checked', { role: 'assistant' })
    const hits = (await search(conversation.id, 'staging deploy')).hits.map((hit) => hit.messageId)
    // The resent prompt stands for both copies; of two neighbouring answers, one is enough.
    expect(hits).toHaveLength(2)
    expect(hits).toContain(resent)
    expect(hits).not.toContain(oldest)
    expect(hits.filter((id) => id === answer || id === followUp)).toHaveLength(1)
  })

  it('reranks with a semantic scorer and admits summaries that share no word with the query', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'login page styling tweaks')
    say(conversation.id, 'filler')
    say(conversation.id, '', {
      role: 'assistant',
      parts: [{ type: 'compaction', id: randomUUID(), text: 'We replaced the session cookie with OAuth tokens' }],
    })
    const rerank = vi.fn(async (_query: string, candidates: ReadonlyArray<{ key: number; text: string }>) => {
      return new Map(candidates.map((candidate) => [candidate.key, candidate.text.includes('OAuth') ? 0.9 : 0]))
    })
    const result = await search(conversation.id, 'login authentication', { rerank })
    expect(rerank).toHaveBeenCalledOnce()
    expect(result.hits.map((hit) => hit.kind ?? hit.snippet)).toEqual(['login page styling tweaks', 'compaction'])
    const without = await search(conversation.id, 'authentication', { rerank: async () => new Map() })
    expect(without.hits).toEqual([])
  })
})

describe('exact history search', () => {
  it('requires every word and lists newest first, like the original search', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'Compactação do bot às 09:00')
    say(conversation.id, 'Feito: compactacao concluída para o bot', { role: 'assistant' })
    say(conversation.id, 'só compactação')
    const result = await search(conversation.id, 'compactação bot', { mode: 'exact' })
    expect(result.mode).toBe('exact')
    expect(result.hits.map((hit) => hit.role)).toEqual(['assistant', 'user'])
    expect(result.hits[0].seq).toBeGreaterThan(result.hits[1].seq)
    expect(result.hits[0].score).toBeUndefined()
  })

  it('finds a term past the trigram cap, two-letter words and pages with beforeSeq', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, `${'filler '.repeat(4_000)} needle at the very end`)
    say(conversation.id, 'ran it once')
    say(conversation.id, 'ran it twice')
    expect(snippets(await search(conversation.id, 'needle', { mode: 'exact' }))[0]).toContain('needle at the very end')
    const both = await search(conversation.id, 'ran it', { mode: 'exact' })
    expect(snippets(both)).toEqual(['ran it twice', 'ran it once'])
    expect(snippets(await search(conversation.id, 'ran it', { mode: 'exact', beforeSeq: both.hits[0].seq }))).toEqual([
      'ran it once',
    ])
    expect(snippets(await search(conversation.id, 'it', { mode: 'exact' }))).toEqual(['ran it twice', 'ran it once'])
  })
})

describe('substring prefilter', () => {
  it('drops messages that hold every trigram of a term but not the term itself', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'table partition done')
    say(conversation.id, 'filler')
    say(conversation.id, 'par art rti tit iti tio ion')
    expect(trigramQuery('partition')).toBe('"par" AND "art" AND "rti" AND "tit" AND "iti" AND "tio" AND "ion"')
    expect(snippets(await search(conversation.id, 'partition', { mode: 'exact' }))).toEqual(['table partition done'])
    expect(snippets(await search(conversation.id, 'artitio'))).toEqual(['table partition done'])
  })
})

describe('history search without the index', () => {
  it('scans messages when this SQLite cannot host the index', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'plain scan still works')
    const exec = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes('history_index_probe')) throw new Error('no such tokenizer: trigram')
      return exec.call(this, sql)
    })
    const result = await search(conversation.id, 'plain scan')
    expect(snippets(result)).toEqual(['plain scan still works'])
    expect(result.building).toBeUndefined()
  })

  it('indexes a database that predates the index on first search', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    say(conversation.id, 'legacy row about kubernetes')
    getDb().prepare('DELETE FROM chat_history_index_queue').run()
    const result = await search(conversation.id, 'kubernetes')
    expect(snippets(result)).toEqual(['legacy row about kubernetes'])
    expect(result.building).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM history_index.history_docs').get()).toMatchObject({ n: 1 })
  })
})
