import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import { chatHistoryStats, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import { openAINativeCompactionMarkerPart, parseParts } from '../../src/main/chat/message'
import { buildOpenAIModelMessages } from '../../src/main/chat/openai/history'
import {
  canReplayOpenAIInferenceState,
  getOpenAIInferenceState,
  putChatMessageWithOpenAIInferenceState,
  type OpenAIInferenceState,
} from '../../src/main/chat/openai/inference-store'
import type { OpenAILedgerObject } from '../../src/main/chat/openai/types'
import { getDb } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

beforeEach(freshDb)
afterEach(closeDb)

const CURRENT_IDENTITY = {
  providerId: 'openai',
  modelId: 'gpt-5.6-codex',
  providerFingerprint: 'a'.repeat(64),
}

function chatConversation() {
  const workspace = makeWorkspace()
  return makeConversation(workspace.id, { mode: 'local' })
}

function textMessage(
  conversationId: string,
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt: number
): ChatMessage {
  return {
    id,
    conversationId,
    role,
    parts: [{ type: 'text', id: `text-${id}`, text }],
    createdAt,
  }
}

function nativeMarker(conversationId: string, id: string, createdAt: number): ChatMessage {
  return {
    id,
    conversationId,
    role: 'assistant',
    parts: [openAINativeCompactionMarkerPart(`compact-${id}`)],
    createdAt,
  }
}

function inferenceState(tag: string): OpenAIInferenceState {
  const retained: OpenAILedgerObject = {
    type: 'message',
    id: `retained-${tag}`,
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text: `retained canonical context ${tag}` }],
  }
  // The standalone endpoint may return a checkpoint without id; the payload must stay opaque and byte-for-byte
  // equivalent after restart without passing through the ModelMessage codec.
  const checkpoint: OpenAILedgerObject = {
    type: 'compaction',
    encrypted_content: `encrypted-${tag}`,
  }
  return {
    version: 3,
    ...CURRENT_IDENTITY,
    harnessProfile: 'openai-responses-v1',
    ledger: {
      version: 1,
      provider: 'openai-responses',
      store: false,
      entries: [],
    },
    canonicalWindow: {
      kind: 'responses.compact',
      response: {
        id: `resp-compact-${tag}`,
        object: 'response.compaction',
        output: [retained, checkpoint],
        usage: { input_tokens: 123, output_tokens: 7, total_tokens: 130 },
      },
    },
  }
}

function compatibleStateLookup(identity = CURRENT_IDENTITY) {
  return (messageId: string) => {
    const state = getOpenAIInferenceState(messageId)
    return state && canReplayOpenAIInferenceState(state, identity) ? state : null
  }
}

describe('OpenAI persisted canonical compaction window', () => {
  it('persists downgrade-safe markers visible as empty text', () => {
    const part = openAINativeCompactionMarkerPart('checkpoint')

    expect(part).toEqual({ type: 'text', id: 'checkpoint', text: '', checkpoint: 'openai-native' })
    expect(parseParts(JSON.stringify([part]))).toEqual([part])
    // Legacy schemas preserve this shape after stripping new keys.
    expect({ type: part.type, id: part.id, text: part.text }).toEqual({
      type: 'text',
      id: 'checkpoint',
      text: '',
    })
  })

  it('replays complete persisted raw output after restart', () => {
    const conversation = chatConversation()
    upsertChatMessage(textMessage(conversation.id, 'user-old', 'user', 'visual prefix', 1))
    const marker = nativeMarker(conversation.id, 'marker-1', 2)
    const state = inferenceState('restart')
    putChatMessageWithOpenAIInferenceState(marker, state)
    upsertChatMessage(textMessage(conversation.id, 'user-tail', 'user', 'continue after checkpoint', 3))

    const beforeRestart = buildOpenAIModelMessages(listChatMessages(conversation.id), compatibleStateLookup())
    expect(beforeRestart.rawPrefix).toEqual(state.canonicalWindow?.response.output)
    expect(beforeRestart.messages).toEqual([{ role: 'user', content: 'continue after checkpoint' }])

    restartDb()

    const restored = getOpenAIInferenceState(marker.id)
    expect(restored?.canonicalWindow).toEqual(state.canonicalWindow)
    const afterRestart = buildOpenAIModelMessages(listChatMessages(conversation.id), compatibleStateLookup())
    expect(afterRestart).toEqual(beforeRestart)
  })

  it('uses only the latest canonical checkpoint', () => {
    const conversation = chatConversation()
    upsertChatMessage(textMessage(conversation.id, 'user-old', 'user', 'old visual prefix', 1))

    const olderMarker = nativeMarker(conversation.id, 'marker-old', 2)
    const olderState = inferenceState('older')
    putChatMessageWithOpenAIInferenceState(olderMarker, olderState)
    upsertChatMessage(textMessage(conversation.id, 'user-between', 'user', 'between checkpoints', 3))

    const latestMarker = nativeMarker(conversation.id, 'marker-latest', 4)
    const latestState = inferenceState('latest')
    putChatMessageWithOpenAIInferenceState(latestMarker, latestState)
    upsertChatMessage(textMessage(conversation.id, 'user-tail', 'user', 'visible suffix', 5))

    const built = buildOpenAIModelMessages(listChatMessages(conversation.id), compatibleStateLookup())

    expect(built.rawPrefix).toEqual(latestState.canonicalWindow?.response.output)
    expect(built.rawPrefix).not.toEqual(olderState.canonicalWindow?.response.output)
    expect(built.messages).toEqual([{ role: 'user', content: 'visible suffix' }])
    expect(JSON.stringify(built)).not.toContain('between checkpoints')
    expect(JSON.stringify(built)).not.toContain('encrypted-older')
  })

  it('falls back to full visual history on identity mismatch', () => {
    const conversation = chatConversation()
    upsertChatMessage(textMessage(conversation.id, 'user-old', 'user', 'visual user prefix', 1))
    upsertChatMessage(textMessage(conversation.id, 'assistant-old', 'assistant', 'visual assistant prefix', 2))
    const marker = nativeMarker(conversation.id, 'marker-1', 3)
    putChatMessageWithOpenAIInferenceState(marker, inferenceState('provider-bound'))
    upsertChatMessage(textMessage(conversation.id, 'user-tail', 'user', 'visual suffix', 4))

    const expectedVisualHistory = [
      { role: 'user', content: 'visual user prefix' },
      { role: 'assistant', content: 'visual assistant prefix' },
      { role: 'user', content: 'visual suffix' },
    ]
    const incompatibleIdentities = [
      { ...CURRENT_IDENTITY, providerId: 'another-openai-provider' },
      { ...CURRENT_IDENTITY, providerFingerprint: 'b'.repeat(64) },
    ]

    for (const identity of incompatibleIdentities) {
      const built = buildOpenAIModelMessages(listChatMessages(conversation.id), compatibleStateLookup(identity))
      expect(built.rawPrefix).toBeUndefined()
      expect(built.messages).toEqual(expectedVisualHistory)
    }
  })

  it('does not reduce stats without confirmed current-identity sidecars', () => {
    const conversation = chatConversation()
    const previousTurn = textMessage(conversation.id, 'assistant-real', 'assistant', 'large previous turn', 1)
    previousTurn.usage = {
      usageVersion: 2,
      input: 40_000,
      output: 2_000,
      contextInput: 40_000,
      contextOutput: 2_000,
    }
    upsertChatMessage(previousTurn)
    const marker = nativeMarker(conversation.id, 'marker-stats', 2)
    marker.usage = { usageVersion: 2, input: 42_000, output: 321, billingOnly: true }
    putChatMessageWithOpenAIInferenceState(marker, inferenceState('stats'))

    expect(chatHistoryStats(conversation.id).lastUsage?.contextInput).toBe(40_000)
    expect(
      chatHistoryStats(conversation.id, {
        isNativeCompactionActive: (messageId) => compatibleStateLookup()(messageId) != null,
      }).lastUsage?.contextInput
    ).toBe(321)
    expect(chatHistoryStats(conversation.id, { isNativeCompactionActive: () => false }).lastUsage?.contextInput).toBe(
      40_000
    )
  })

  it('rolls back markers on sidecar failure and keeps prior checkpoints', () => {
    const conversation = chatConversation()
    upsertChatMessage(textMessage(conversation.id, 'user-old', 'user', 'stable visual prefix', 1))
    const stableMarker = nativeMarker(conversation.id, 'marker-stable', 2)
    const stableState = inferenceState('stable')
    putChatMessageWithOpenAIInferenceState(stableMarker, stableState)

    getDb().exec(`
      CREATE TRIGGER fail_new_compaction_sidecar
      BEFORE INSERT ON chat_inference_state
      WHEN NEW.message_id = 'marker-failing'
      BEGIN
        SELECT RAISE(ABORT, 'forced sidecar failure');
      END;
    `)

    const failingMarker = nativeMarker(conversation.id, 'marker-failing', 3)
    expect(() => putChatMessageWithOpenAIInferenceState(failingMarker, inferenceState('must-rollback'))).toThrow(
      /forced sidecar failure/
    )

    expect(listChatMessages(conversation.id).map((message) => message.id)).toEqual(['user-old', 'marker-stable'])
    expect(getOpenAIInferenceState(failingMarker.id)).toBeNull()
    expect(getOpenAIInferenceState(stableMarker.id)?.canonicalWindow).toEqual(stableState.canonicalWindow)

    const replay = buildOpenAIModelMessages(listChatMessages(conversation.id), compatibleStateLookup())
    expect(replay.rawPrefix).toEqual(stableState.canonicalWindow?.response.output)
    expect(replay.messages).toEqual([])
  })

  it('rejects windows computed before concurrent history changes', () => {
    const conversation = chatConversation()
    upsertChatMessage(textMessage(conversation.id, 'user-before', 'user', 'history used by compact', 1))
    const snapshot = JSON.stringify(listChatMessages(conversation.id))

    upsertChatMessage(textMessage(conversation.id, 'user-concurrent', 'user', 'arrived during network wait', 2))
    const staleMarker = nativeMarker(conversation.id, 'marker-stale', 3)
    expect(() =>
      putChatMessageWithOpenAIInferenceState(staleMarker, inferenceState('stale'), () => {
        if (JSON.stringify(listChatMessages(conversation.id)) !== snapshot) throw new Error('history changed')
      })
    ).toThrow(/history changed/)

    expect(listChatMessages(conversation.id).map((message) => message.id)).toEqual(['user-before', 'user-concurrent'])
    expect(getOpenAIInferenceState(staleMarker.id)).toBeNull()
  })
})
