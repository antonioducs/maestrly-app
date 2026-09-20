import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackgroundCompactionStore } from '../../src/main/chat/background-compaction/store'
import {
  backgroundCompactionConfigIdentity,
  parseBackgroundCompactionConfig,
} from '../../src/main/chat/background-compaction/config'
import { aggregateChatUsage, clearChatMessages, recordChatUsageAttempt } from '../../src/main/chat/chat-store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

describe('background configuration and durable accounting', () => {
  let conversationId: string
  const config = {
    enabled: true,
    intervalTokens: 100000,
    selection: { providerId: 'provider', modelId: 'model', effort: 'off', fastMode: false },
  }
  beforeEach(() => {
    freshDb()
    conversationId = makeConversation(makeWorkspace().id).id
  })
  afterEach(closeDb)

  it('requires a model when enabled and validates whole positive intervals', () => {
    expect(parseBackgroundCompactionConfig({ ...config, selection: null })).toBeNull()
    expect(parseBackgroundCompactionConfig({ ...config, intervalTokens: 1.5 })).toBeNull()
    expect(parseBackgroundCompactionConfig({ ...config, intervalTokens: Infinity })).toBeNull()
    expect(parseBackgroundCompactionConfig({ ...config, enabled: false, selection: null })).not.toBeNull()
    expect(parseBackgroundCompactionConfig(config)).toEqual(config)
  })

  it('persists generation and revision through restart and bumps generation on history clear', async () => {
    const store = new BackgroundCompactionStore()
    const identity = backgroundCompactionConfigIdentity(config)
    store.write(conversationId, { generation: 7, configIdentity: identity, status: 'idle', ready: null, work: null })
    restartDb()
    expect(store.get(conversationId)).toMatchObject({ generation: 7, state: { revision: 1 }, configIdentity: identity })
    await clearChatMessages(conversationId)
    expect(store.get(conversationId)).toMatchObject({
      generation: 8,
      state: { revision: 2, status: 'idle' },
      ready: null,
      work: null,
    })
  })

  it('keeps billed attempts after preparation cleanup and never counts them as chat turns', async () => {
    const attempt = {
      id: 'background-compaction:work:1',
      conversationId,
      model: { providerId: 'provider', modelId: 'summarizer' },
      usage: { input: 100, output: 20, cacheRead: 10, cacheCreate: 5 },
    }
    recordChatUsageAttempt(attempt)
    recordChatUsageAttempt({ ...attempt, usage: { input: 999, output: 999, cacheRead: 0, cacheCreate: 0 } })
    await clearChatMessages(conversationId)
    expect(aggregateChatUsage()).toMatchObject({
      totalTurns: 0,
      perModel: [expect.objectContaining({ input: 100, output: 20, cacheRead: 10, cacheCreate: 5 })],
    })
  })
})
