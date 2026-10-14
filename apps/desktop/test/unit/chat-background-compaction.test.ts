import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackgroundCompactionStore } from '../../src/main/chat/background-compaction/store'
import { BACKGROUND_COMPACTION_PERSISTENCE_VERSION } from '../../src/main/chat/background-compaction/types'
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

  it('persists the frozen fallback route of an in-flight summary and drops a malformed one', () => {
    const store = new BackgroundCompactionStore()
    const failoverRoute = [
      { providerId: 'builtin_claude_subscription', identityFingerprint: 'account-A', identityEpoch: 2 },
      { providerId: 'builtin_claude_subscription@acc_b', identityFingerprint: 'account-B', identityEpoch: 7 },
    ]
    const work = (route: unknown) => ({
      version: BACKGROUND_COMPACTION_PERSISTENCE_VERSION,
      id: 'work-1',
      generation: 1,
      configIdentity: 'identity',
      boundary: { messageId: 'm', partId: 'p', partIndex: 0 },
      sourceHash: 'hash',
      selection: {
        providerId: 'builtin_claude_subscription',
        modelId: 'sonnet',
        fastMode: false,
        failoverRoute: route,
      } as never,
      coveredTokens: 0,
      newTokens: 10,
      intervalTokens: 100000,
      conversationWindow: 200000,
      contextWindow: 200000,
      maxSummaryTokens: 4000,
      attemptSequence: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    store.write(conversationId, { generation: 1, status: 'running', ready: null, work: work(failoverRoute) })
    restartDb()
    expect(store.get(conversationId)?.work?.selection.failoverRoute).toEqual(failoverRoute)

    store.write(conversationId, {
      generation: 1,
      status: 'running',
      ready: null,
      work: work([{ providerId: 42 }]),
    })
    restartDb()
    expect(store.get(conversationId)?.work).toBeNull()
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
