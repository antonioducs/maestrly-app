import { beforeEach, afterEach, it, expect } from 'vitest'
import {
  getCodexThreadBinding,
  putCodexThreadBinding,
  listCodexThreadCleanup,
} from '../../src/main/chat/codex-subscription/thread-store'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { transaction } from '../../src/main/store/db'
import {
  upsertChatMessage,
  listConversationContextMessages,
  type StoredChatMessage,
  aggregateChatUsage,
} from '../../src/main/chat/chat-store'
import {
  previewPreparedActivation,
  commitPreparedActivation,
} from '../../src/main/chat/background-compaction/activation'
import { activeChatContext, renderNativeSeedTranscript } from '../../src/main/chat/message'
import { getOpenAIInferenceState, putOpenAIInferenceState } from '../../src/main/chat/openai/inference-store'
import { captureOpenAIResponsesStream } from '../../src/main/chat/openai/ledger'
import { buildOpenAIModelMessages } from '../../src/main/chat/openai/history'
import { estimatePortableContextTokens } from '../../src/main/chat/portable-context'

let conversationId: string
const model = { providerId: 'provider', modelId: 'model' }
const marker = { messageId: 'anchor', afterPartId: 'covered', partId: 'summary' }
function fixture(): StoredChatMessage[] {
  return [
    {
      id: 'anchor',
      conversationId,
      role: 'assistant',
      createdAt: 1,
      parts: [
        { type: 'text', id: 'covered', text: 'OLD_COVERED_TEXT' },
        { type: 'text', id: 'suffix', text: 'SAME_MESSAGE_SUFFIX' },
      ],
    },
    {
      id: 'later',
      conversationId,
      role: 'assistant',
      createdAt: 2,
      model,
      parts: [{ type: 'text', id: 'later-text', text: 'LATER_MESSAGE' }],
      usage: { usageVersion: 2, input: 180000, output: 500, contextIdentity: 'old-identity' },
      contextSnapshot: { model, usedTokens: 180500, quality: 'measured', sequence: 4, observedAt: 2 },
    },
  ]
}
function ledger(messageId: string, text: string) {
  putOpenAIInferenceState(messageId, {
    version: 4,
    providerId: model.providerId,
    modelId: model.modelId,
    providerFingerprint: 'a'.repeat(64),
    modelHarnessProfileId: 'openai-default-v1',
    ledger: captureOpenAIResponsesStream([
      { type: 'text-start', id: messageId },
      { type: 'text-delta', id: messageId, text },
      { type: 'text-end', id: messageId },
    ]),
  })
}
beforeEach(() => {
  freshDb()
  conversationId = makeConversation(makeWorkspace().id).id
})
afterEach(closeDb)

it('inserts into the covered message, preserves both suffixes and invalidates only unsafe replay and measurements', () => {
  const history = fixture()
  history.forEach(upsertChatMessage)
  ledger('anchor', 'OLD_COVERED_TEXT')
  ledger('later', 'LATER_MESSAGE')
  const cost = aggregateChatUsage()
  const projected = previewPreparedActivation(history, marker, 'MEMORY')!
  transaction(() =>
    commitPreparedActivation({ conversationId, history: projected, marker, destination: model, contextWindow: 200000 })
  )
  const durable = listConversationContextMessages(conversationId)
  expect(durable[0].parts.map((part) => part.id)).toEqual(['covered', 'summary', 'suffix'])
  expect(activeChatContext(durable).messages.map((message) => message.id)).toEqual(['anchor', 'later'])
  const transfer = renderNativeSeedTranscript(durable)
  expect(transfer).toContain('MEMORY')
  expect(transfer).toContain('SAME_MESSAGE_SUFFIX')
  expect(transfer).toContain('LATER_MESSAGE')
  expect(transfer).not.toContain('OLD_COVERED_TEXT')
  expect(getOpenAIInferenceState('anchor')).toBeNull()
  expect(getOpenAIInferenceState('later')).not.toBeNull()
  const replay = JSON.stringify(buildOpenAIModelMessages(durable, getOpenAIInferenceState).messages)
  expect(replay).not.toContain('OLD_COVERED_TEXT')
  expect(replay).toContain('SAME_MESSAGE_SUFFIX')
  expect(durable[1].contextSnapshot).toMatchObject({
    quality: 'estimated',
    usedTokens: estimatePortableContextTokens(durable),
    sequence: 5,
  })
  expect(durable[1].usage?.contextIdentity).toBeUndefined()
  expect(aggregateChatUsage()).toEqual(cost)
})

it('rolls back marker, measurement and sidecar together if candidate consumption fails', () => {
  const history = fixture()
  history.forEach(upsertChatMessage)
  ledger('anchor', 'OLD_COVERED_TEXT')
  expect(() =>
    transaction(() => {
      commitPreparedActivation({
        conversationId,
        history: previewPreparedActivation(history, marker, 'MEMORY')!,
        marker,
        destination: model,
        contextWindow: 200000,
      })
      throw new Error('candidate conflict')
    })
  ).toThrow('candidate conflict')
  const durable = listConversationContextMessages(conversationId)
  expect(durable[0].parts).toEqual(history[0].parts)
  expect(durable[1].contextSnapshot?.quality).toBe('measured')
  expect(getOpenAIInferenceState('anchor')).not.toBeNull()
})

it('invalidates the conversation native binding atomically even when the compactor is another provider', () => {
  const history = fixture()
  history.forEach(upsertChatMessage)
  putCodexThreadBinding({
    conversationId,
    threadId: 'native-before',
    modelId: 'codex-model',
    toolSignature: 'tools',
    lastMessageId: 'later',
    accountId: 'original-account',
    usage: { inputTokens: 180000, outputTokens: 500, cachedInputTokens: 0, reasoningOutputTokens: 0 },
  })
  const apply = () =>
    commitPreparedActivation({
      conversationId,
      history: previewPreparedActivation(history, marker, 'MEMORY')!,
      marker,
      destination: { providerId: 'codex-subscription', modelId: 'codex-model' },
      contextWindow: 200000,
    })
  expect(() =>
    transaction(() => {
      apply()
      throw new Error('rollback')
    })
  ).toThrow('rollback')
  expect(getCodexThreadBinding(conversationId)?.threadId).toBe('native-before')
  expect(listCodexThreadCleanup()).toHaveLength(0)
  transaction(apply)
  expect(getCodexThreadBinding(conversationId)).toBeNull()
  expect(listCodexThreadCleanup()).toEqual([
    expect.objectContaining({ threadId: 'native-before', accountId: 'original-account' }),
  ])
})
