import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteChatMessagesFrom, getMessageSeq, upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  canReplayOpenAIInferenceState,
  deleteOpenAIInferenceState,
  getOpenAIInferenceState,
  getToolExecution,
  putOpenAIInferenceState,
  putToolExecution,
  type OpenAIInferenceState,
} from '../../src/main/chat/openai/inference-store'
import { captureOpenAIResponsesStream } from '../../src/main/chat/openai/ledger'
import { deleteConversation, getDb } from '../../src/main/store'

beforeEach(freshDb)
afterEach(closeDb)

function chatConversation() {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id, { mode: 'local' })
  return { workspace, conversation }
}

function insertAssistantMessage(conversationId: string, id: string, createdAt = 1): void {
  upsertChatMessage({
    id,
    conversationId,
    role: 'assistant',
    parts: [{ type: 'text', id: `text-${id}`, text: 'checkpoint visual' }],
    createdAt,
  })
}

function inferenceState(overrides: Partial<OpenAIInferenceState> = {}): OpenAIInferenceState {
  return {
    version: 2,
    providerId: 'openai',
    modelId: 'gpt-5.6-codex',
    providerFingerprint: 'a'.repeat(64),
    harnessProfile: 'openai-responses-v1',
    ledger: captureOpenAIResponsesStream([
      {
        type: 'reasoning-start',
        id: 'reasoning-1',
        providerMetadata: { openai: { itemId: 'rs_1' } },
      },
      { type: 'reasoning-delta', id: 'reasoning-1', text: 'inspect repository' },
      {
        type: 'reasoning-end',
        id: 'reasoning-1',
        providerMetadata: { openai: { reasoningEncryptedContent: 'encrypted-state' } },
      },
      {
        type: 'finish-step',
        finishReason: 'stop',
        response: { id: 'resp_1' },
      },
    ]),
    ...overrides,
  }
}

describe('OpenAI inference sidecar', () => {
  it('persists the Astra model profile as the opaque replay identity', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-astra')
    const state = inferenceState({
      version: 4,
      modelId: 'gpt-6-astra',
      harnessProfile: undefined,
      modelHarnessProfileId: 'openai-gpt-6-astra-v1',
    })
    putOpenAIInferenceState('assistant-astra', state)
    expect(getOpenAIInferenceState('assistant-astra')).toEqual(state)
    expect(
      getDb()
        .prepare('SELECT harness_profile FROM chat_inference_state WHERE message_id = ?')
        .get('assistant-astra')
    ).toEqual({ harness_profile: 'openai-gpt-6-astra-v1' })
  })

  it('persists complete ledgers including encrypted metadata', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')

    const expected = inferenceState()
    putOpenAIInferenceState('assistant-1', expected)

    expect(getOpenAIInferenceState('assistant-1')).toEqual(expected)
    expect(getOpenAIInferenceState('missing-message')).toBeNull()
    expect(
      getDb()
        .prepare(
          `SELECT provider_id, model_id, harness_profile
           FROM chat_inference_state WHERE message_id = ?`
        )
        .get('assistant-1')
    ).toEqual({
      provider_id: 'openai',
      model_id: 'gpt-5.6-codex',
      harness_profile: 'openai-default-v1',
    })
  })

  it('atomically upserts messages and query columns without duplicates', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')

    putOpenAIInferenceState('assistant-1', inferenceState())
    const replacement = inferenceState({
      providerId: 'openai-prod',
      modelId: 'gpt-5.7-codex',
      ledger: captureOpenAIResponsesStream([
        { type: 'text-start', id: 'message-2' },
        { type: 'text-delta', id: 'message-2', text: 'new result' },
        { type: 'text-end', id: 'message-2' },
      ]),
    })
    putOpenAIInferenceState('assistant-1', replacement)

    expect(getOpenAIInferenceState('assistant-1')).toEqual(replacement)
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) AS count, MIN(provider_id) AS provider_id, MIN(model_id) AS model_id
           FROM chat_inference_state WHERE message_id = ?`
        )
        .get('assistant-1')
    ).toEqual({ count: 1, provider_id: 'openai-prod', model_id: 'gpt-5.7-codex' })
  })

  it('returns null for malformed or schema-invalid state JSON', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')
    putOpenAIInferenceState('assistant-1', inferenceState())

    getDb()
      .prepare('UPDATE chat_inference_state SET state_json = ? WHERE message_id = ?')
      .run('{json incompleto', 'assistant-1')
    expect(() => getOpenAIInferenceState('assistant-1')).not.toThrow()
    expect(getOpenAIInferenceState('assistant-1')).toBeNull()

    getDb()
      .prepare('UPDATE chat_inference_state SET state_json = ? WHERE message_id = ?')
      .run(JSON.stringify({ ...inferenceState(), ledger: { version: 1, entries: [] } }), 'assistant-1')
    expect(getOpenAIInferenceState('assistant-1')).toBeNull()
  })

  it('rejects legacy sidecars without backend fingerprints', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')
    const insertRaw = (state: unknown) =>
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO chat_inference_state
             (message_id, provider_id, model_id, harness_profile, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('assistant-1', 'openai', 'gpt-5.6-codex', 'openai-responses-v1', JSON.stringify(state), Date.now())

    const current = inferenceState()
    insertRaw({ ...current, version: 1, providerFingerprint: undefined })
    expect(getOpenAIInferenceState('assistant-1')).toBeNull()

    insertRaw({ ...current, providerFingerprint: 'short-demais' })
    expect(getOpenAIInferenceState('assistant-1')).toBeNull()
  })

  it('limits opaque replay to matching provider, model, endpoint and credentials', () => {
    const state = inferenceState()
    expect(canReplayOpenAIInferenceState(state, state)).toBe(true)
    expect(canReplayOpenAIInferenceState(state, { ...state, providerId: 'other-provider' })).toBe(false)
    expect(canReplayOpenAIInferenceState(state, { ...state, modelId: 'gpt-5.7-codex' })).toBe(false)
    expect(canReplayOpenAIInferenceState(state, { ...state, providerFingerprint: 'b'.repeat(64) })).toBe(false)
    expect(
      canReplayOpenAIInferenceState(state, { ...state, modelHarnessProfileId: 'openai-gpt-6-astra-v1' })
    ).toBe(false)
  })

  it('makes explicit deletion idempotent', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')
    putOpenAIInferenceState('assistant-1', inferenceState())

    deleteOpenAIInferenceState('assistant-1')
    deleteOpenAIInferenceState('assistant-1')

    expect(getOpenAIInferenceState('assistant-1')).toBeNull()
  })

  it('cascades truncated sidecars while preserving history prefixes', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1', 1)
    insertAssistantMessage(conversation.id, 'assistant-2', 2)
    insertAssistantMessage(conversation.id, 'assistant-3', 3)
    putOpenAIInferenceState('assistant-1', inferenceState())
    putOpenAIInferenceState('assistant-2', inferenceState())
    putOpenAIInferenceState('assistant-3', inferenceState())

    const fromSeq = getMessageSeq('assistant-2')
    expect(fromSeq).not.toBeNull()
    deleteChatMessagesFrom(conversation.id, fromSeq!)

    expect(getOpenAIInferenceState('assistant-1')).not.toBeNull()
    expect(getOpenAIInferenceState('assistant-2')).toBeNull()
    expect(getOpenAIInferenceState('assistant-3')).toBeNull()
  })
})

describe('OpenAI tool execution ledger', () => {
  it('upserts executions without affecting other calls', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')
    putToolExecution({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-1',
      toolName: 'bash',
      inputHash: 'hash-v1',
      status: 'running',
    })
    putToolExecution({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-2',
      toolName: 'read',
      inputHash: 'hash-read',
      status: 'completed',
      output: 'content',
    })

    putToolExecution({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-1',
      toolName: 'bash',
      inputHash: 'hash-v1',
      status: 'completed',
      output: { stdout: 'ok', exitCode: 0 },
    })

    expect(getToolExecution(conversation.id, 'call-1')).toEqual({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-1',
      toolName: 'bash',
      inputHash: 'hash-v1',
      status: 'completed',
      output: { stdout: 'ok', exitCode: 0 },
    })
    expect(getToolExecution(conversation.id, 'call-2')?.output).toBe('content')
    expect(getToolExecution(conversation.id, 'missing-call')).toBeNull()
    expect(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM chat_tool_executions WHERE conversation_id = ?')
        .get(conversation.id)
    ).toEqual({ count: 2 })
  })

  it('tolerates corrupt output JSON during reads', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1')
    putToolExecution({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-1',
      toolName: 'bash',
      inputHash: 'hash-v1',
      status: 'completed',
      output: { stdout: 'ok' },
    })
    getDb()
      .prepare('UPDATE chat_tool_executions SET output_json = ? WHERE conversation_id = ? AND call_id = ?')
      .run('{json incompleto', conversation.id, 'call-1')

    expect(() => getToolExecution(conversation.id, 'call-1')).not.toThrow()
    expect(getToolExecution(conversation.id, 'call-1')).toMatchObject({
      conversationId: conversation.id,
      messageId: 'assistant-1',
      callId: 'call-1',
      status: 'completed',
      output: undefined,
    })
  })

  it('cascades conversation deletion without affecting other conversations', () => {
    const workspace = makeWorkspace()
    const deleted = makeConversation(workspace.id, { mode: 'local' })
    const survivor = makeConversation(workspace.id, { mode: 'local' })
    insertAssistantMessage(deleted.id, 'deleted-assistant')
    insertAssistantMessage(survivor.id, 'survivor-assistant')
    putOpenAIInferenceState('deleted-assistant', inferenceState())
    putOpenAIInferenceState('survivor-assistant', inferenceState())
    putToolExecution({
      conversationId: deleted.id,
      messageId: 'deleted-assistant',
      callId: 'shared-call-id',
      toolName: 'bash',
      inputHash: 'deleted-hash',
      status: 'completed',
      output: 'deleted',
    })
    putToolExecution({
      conversationId: survivor.id,
      messageId: 'survivor-assistant',
      callId: 'shared-call-id',
      toolName: 'read',
      inputHash: 'survivor-hash',
      status: 'completed',
      output: 'survivor',
    })

    deleteConversation(deleted.id)

    expect(getOpenAIInferenceState('deleted-assistant')).toBeNull()
    expect(getToolExecution(deleted.id, 'shared-call-id')).toBeNull()
    expect(getOpenAIInferenceState('survivor-assistant')).not.toBeNull()
    expect(getToolExecution(survivor.id, 'shared-call-id')?.output).toBe('survivor')
  })

  it('cascades truncated executions while preserving the prefix', () => {
    const { conversation } = chatConversation()
    insertAssistantMessage(conversation.id, 'assistant-1', 1)
    insertAssistantMessage(conversation.id, 'assistant-2', 2)
    insertAssistantMessage(conversation.id, 'assistant-3', 3)
    for (const messageId of ['assistant-1', 'assistant-2', 'assistant-3']) {
      putToolExecution({
        conversationId: conversation.id,
        messageId,
        callId: `call-${messageId}`,
        toolName: 'bash',
        inputHash: `hash-${messageId}`,
        status: 'completed',
        output: messageId,
      })
    }

    const fromSeq = getMessageSeq('assistant-2')
    expect(fromSeq).not.toBeNull()
    deleteChatMessagesFrom(conversation.id, fromSeq!)

    expect(getToolExecution(conversation.id, 'call-assistant-1')?.output).toBe('assistant-1')
    expect(getToolExecution(conversation.id, 'call-assistant-2')).toBeNull()
    expect(getToolExecution(conversation.id, 'call-assistant-3')).toBeNull()
  })
})
