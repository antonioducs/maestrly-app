import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import {
  getCodexThreadBinding,
  putCodexThreadBinding,
} from '../../src/main/chat/codex-subscription/thread-store'

beforeEach(freshDb)
afterEach(closeDb)

describe('Codex subscription harness-profile binding', () => {
  it('persists Astra identity and defaults old-compatible writes to the current profile', () => {
    const workspace = makeWorkspace()
    const astraConversation = makeConversation(workspace.id, {})
    const defaultConversation = makeConversation(workspace.id, {})
    const base = {
      modelId: 'gpt-6-astra',
      toolSignature: 'tools',
      instructionHash: 'instructions',
      lastMessageId: 'message',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    }
    putCodexThreadBinding({
      ...base,
      conversationId: astraConversation.id,
      threadId: 'thread-astra',
      harnessProfile: 'openai-gpt-6-astra-v1',
    })
    putCodexThreadBinding({
      ...base,
      conversationId: defaultConversation.id,
      threadId: 'thread-default',
    })
    expect(getCodexThreadBinding(astraConversation.id)?.harnessProfile).toBe('openai-gpt-6-astra-v1')
    expect(getCodexThreadBinding(defaultConversation.id)?.harnessProfile).toBe('openai-default-v1')
  })

  it('adds the non-destructive schema default', () => {
    const columns = getDb().prepare('PRAGMA table_info(chat_codex_threads)').all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    expect(columns.find((column) => column.name === 'harness_profile')).toMatchObject({
      notnull: 1,
      dflt_value: "'openai-default-v1'",
    })
  })
})
