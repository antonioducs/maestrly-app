import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { snapshotAllowsResume } from '../../src/main/chat/harness/compatibility'
import { resolveChatHarness } from '../../src/main/chat/harness/execution'
import { getDb } from '../../src/main/store'
import { getClaudeSessionBinding, putClaudeSessionBinding } from '../../src/main/chat/claude-agent-sdk/session-store'
import { INVALID_HARNESS_SNAPSHOT } from '../../src/shared/harness'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

describe('Claude Agent SDK session store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('blocks resume when the stored snapshot is corrupt or has an unsupported version', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    putClaudeSessionBinding({
      conversationId: conversation.id,
      sessionId: 'session-corrupt',
      modelId: 'claude-opus',
      effort: 'high',
      fastMode: false,
      cwd: conversation.cwd,
      harnessProfile: 'maestrly-claude-v1',
      promptHash: 'prompt-hash',
      toolSignature: 'tools-sha256',
      lastMessageId: 'message-456',
      lastAssistantUuid: null,
      accountFingerprint: 'account-fingerprint',
      accountEpoch: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        turns: 0,
        durationMs: 0,
        durationApiMs: 0,
      },
      context: null,
    })
    const harness = resolveChatHarness('claude-subscription', 'claude-opus').harness

    for (const snapshotJson of ['{bad', '{"snapshotVersion":99}']) {
      getDb()
        .prepare('UPDATE chat_claude_sessions SET harness_snapshot_json = ? WHERE conversation_id = ?')
        .run(snapshotJson, conversation.id)
      const binding = getClaudeSessionBinding(conversation.id)
      expect(binding?.harnessSnapshot).toBe(INVALID_HARNESS_SNAPSHOT)
      expect(snapshotAllowsResume(binding?.harnessSnapshot ?? null, harness)).toBe(false)
    }
  })
})
