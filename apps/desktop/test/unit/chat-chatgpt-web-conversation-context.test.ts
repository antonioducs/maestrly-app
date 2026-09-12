import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  getMessageSeq,
  readCompanionConversationPage,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import {
  companionConversationVisibleText,
  CONVERSATION_CONTEXT_MAX_CHARS,
  CONVERSATION_CONTEXT_MAX_MESSAGES,
  getCompanionConversationContext,
  readCompanionConversation,
  searchCompanionConversation,
} from '../../src/main/chat/chatgpt-web/conversation-context'
import { getDb } from '../../src/main/store'
import type { MessagePart } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

function conversationId(): string {
  const workspace = makeWorkspace()
  return makeConversation(workspace.id, { mode: 'local' }).id
}

function put(conversationId: string, id: string, parts: MessagePart[], extra: Partial<StoredChatMessage> = {}): void {
  upsertChatMessage({
    id,
    conversationId,
    role: 'user',
    parts,
    createdAt: Number(id.replace(/\D/g, '')) || Date.now(),
    ...extra,
  })
}

describe('ChatGPT Web conversation context projection', () => {
  it('projects only visible requirement text and never leaks hidden part payloads', () => {
    const parts: MessagePart[] = [
      { type: 'text', id: 'text', text: 'visible decision' },
      { type: 'text', id: 'checkpoint', text: 'opaque checkpoint secret', checkpoint: 'openai-native' },
      { type: 'reasoning', id: 'reasoning', text: 'reasoning secret' },
      {
        type: 'tool',
        id: 'tool',
        toolCallId: 'tool',
        toolName: 'secret_tool',
        input: { token: 'tool input secret' },
        state: { status: 'completed', output: { text: 'tool output secret' } },
      },
      {
        type: 'file',
        id: 'file',
        name: 'requirements.txt',
        mediaType: 'text/plain',
        kind: 'text',
        data: 'base64-or-inline-secret',
      },
      {
        type: 'file',
        id: 'hidden-file',
        name: 'hidden-mentioned-secret.md',
        mediaType: 'text/plain',
        kind: 'text',
        data: 'hidden-file-payload-secret',
        hidden: true,
      },
      {
        type: 'skill-invocation',
        id: 'skill',
        name: 'review',
        args: '--strict',
        body: 'expanded hidden skill body',
        dir: '/private/skill/path',
      },
      { type: 'context', id: 'context', text: 'imported visible context' },
      { type: 'compaction', id: 'compaction', text: 'portable visible summary', strategy: 'summary' },
    ]

    const visible = companionConversationVisibleText(parts)
    expect(visible).toContain('visible decision')
    expect(visible).toContain('[Attachment: requirements.txt]')
    expect(visible).toContain('/review --strict')
    expect(visible).toContain('imported visible context')
    expect(visible).not.toContain('portable visible summary')
    for (const secret of [
      'opaque checkpoint secret',
      'reasoning secret',
      'tool input secret',
      'tool output secret',
      'base64-or-inline-secret',
      'hidden-mentioned-secret.md',
      'hidden-file-payload-secret',
      'expanded hidden skill body',
      '/private/skill/path',
    ]) {
      expect(visible).not.toContain(secret)
    }
  })

  it('brief/search/read exclude internal and isolated executions and cannot hit hidden text', () => {
    const conv = conversationId()
    put(conv, 'm1', [
      { type: 'text', id: 'p1', text: 'main visible alpha' },
      {
        type: 'file',
        id: 'file',
        name: 'visible-name.txt',
        mediaType: 'text/plain',
        kind: 'text',
        data: 'attachment-payload-needle',
      },
      {
        type: 'skill-invocation',
        id: 'skill',
        name: 'visible-skill',
        body: 'skill-body-needle',
        dir: '/hidden/skill-dir-needle',
      },
    ])
    put(conv, 'm2', [{ type: 'reasoning', id: 'p2', text: 'reasoning-only-needle' }])
    put(conv, 'm3', [
      {
        type: 'tool',
        id: 'p3',
        toolCallId: 'p3',
        toolName: 'hidden',
        input: { query: 'tool-input-needle' },
        state: { status: 'completed', output: { text: 'tool-output-needle' } },
      },
    ])
    put(conv, 'm4', [{ type: 'text', id: 'p4', text: 'internal-needle' }], { internal: true })
    put(conv, 'm5', [{ type: 'text', id: 'p5', text: 'review-loop-needle' }], {
      executionScope: { kind: 'review-loop', executionId: 'exec', loopId: 'loop', iteration: 1, maxIterations: 2 },
    })
    put(conv, 'm6', [{ type: 'text', id: 'p6', text: 'review-summary-needle' }], {
      executionScope: { kind: 'review-summary', loopId: 'loop' },
    })
    put(conv, 'm7', [{ type: 'text', id: 'p7', text: 'host-needle' }], {
      executionScope: { kind: 'host', executionId: 'host' },
    })
    put(conv, 'm8', [{ type: 'text', id: 'p8', text: 'main visible omega' }], {
      executionScope: { kind: 'conversation' },
    })

    const brief = getCompanionConversationContext(conv)
    expect(brief.messages.map((message) => message.message_id)).toEqual(['m1', 'm8'])
    expect(JSON.stringify(brief)).not.toMatch(
      /reasoning-only|tool-input|tool-output|attachment-payload|skill-body|skill-dir|internal-|review-loop|review-summary|host-/
    )
    for (const query of [
      'reasoning-only-needle',
      'tool-input-needle',
      'tool-output-needle',
      'attachment-payload-needle',
      'skill-body-needle',
      'skill-dir-needle',
      'internal-needle',
      'review-loop-needle',
      'review-summary-needle',
      'host-needle',
    ]) {
      expect(searchCompanionConversation(conv, { query }).hits).toEqual([])
    }
    expect(searchCompanionConversation(conv, { query: 'main visible' }).hits.map((hit) => hit.message_id)).toEqual([
      'm8',
      'm1',
    ])
    expect(searchCompanionConversation(conv, { query: 'visible-name.txt' }).hits.map((hit) => hit.message_id)).toEqual([
      'm1',
    ])
    expect(searchCompanionConversation(conv, { query: '/visible-skill' }).hits.map((hit) => hit.message_id)).toEqual([
      'm1',
    ])
    const safeRead = JSON.stringify(readCompanionConversation(conv, { around_seq: getMessageSeq('m1')!, limit: 10 }))
    expect(safeRead).not.toMatch(/attachment-payload|skill-body|skill-dir|reasoning-only|tool-input|tool-output/)
    expect(readCompanionConversation(conv, { around_seq: getMessageSeq('m5')!, limit: 10 }).found).toBe(false)
  })

  it('prioritizes the latest decision when bounded search has more matches than its limit', () => {
    const conv = conversationId()
    for (let i = 1; i <= 21; i++) {
      put(conv, `decision-${i}`, [{ type: 'text', id: `decision-part-${i}`, text: `decision-term occurrence ${i}` }])
    }

    const result = searchCompanionConversation(conv, { query: 'decision-term', limit: 20 })

    expect(result.hits).toHaveLength(20)
    expect(result.hits[0]?.message_id).toBe('decision-21')
    expect(result.hits.map((hit) => hit.message_id)).not.toContain('decision-1')
    expect(result.hits.map((hit) => hit.seq)).toEqual([...result.hits.map((hit) => hit.seq)].sort((a, b) => b - a))
  })

  it('does not expose hidden file names or payloads through the remote projection', () => {
    const conv = conversationId()
    const hiddenName = 'mention-backing-secret.md'
    const hiddenPayload = 'mention-backing-payload-secret'
    put(conv, 'hidden-file', [
      {
        type: 'file',
        id: 'hidden-file-part',
        name: hiddenName,
        mediaType: 'text/plain',
        kind: 'text',
        data: hiddenPayload,
        hidden: true,
      },
    ])
    put(conv, 'visible', [{ type: 'text', id: 'visible-part', text: 'visible decision' }])

    const brief = getCompanionConversationContext(conv)
    expect(JSON.stringify(brief)).not.toContain(hiddenName)
    expect(JSON.stringify(brief)).not.toContain(hiddenPayload)
    expect(searchCompanionConversation(conv, { query: hiddenName }).hits).toEqual([])
    expect(readCompanionConversation(conv, { around_seq: getMessageSeq('hidden-file')!, limit: 10 })).toMatchObject({
      found: false,
      messages: [],
    })
  })

  it('changes the opaque revision when an existing message seq gets new visible content', () => {
    const conv = conversationId()
    put(conv, 'streaming-assistant', [{ type: 'text', id: 'part', text: 'partial response' }], {
      role: 'assistant',
    })
    const before = getCompanionConversationContext(conv)
    const seq = getMessageSeq('streaming-assistant')

    put(conv, 'streaming-assistant', [{ type: 'text', id: 'part', text: 'completed response' }], {
      role: 'assistant',
    })

    expect(getMessageSeq('streaming-assistant')).toBe(seq)
    const after = getCompanionConversationContext(conv)
    expect(after.revision).not.toBe(before.revision)
    expect(after.messages[0]?.content).toBe('completed response')
  })

  it('fails closed when internal or review metadata is corrupted', () => {
    const conv = conversationId()
    put(conv, 'visible', [{ type: 'text', id: 'visible-part', text: 'main visible decision' }])
    put(conv, 'internal', [{ type: 'text', id: 'internal-part', text: 'corrupted internal secret' }], {
      internal: true,
    })
    put(conv, 'review', [{ type: 'text', id: 'review-part', text: 'corrupted review secret' }], {
      executionScope: { kind: 'review-loop', executionId: 'exec', loopId: 'loop', iteration: 1, maxIterations: 2 },
    })

    const corrupt = getDb().prepare('UPDATE chat_messages SET meta_json = ? WHERE id = ?')
    corrupt.run('{malformed metadata', 'internal')
    corrupt.run('{malformed metadata', 'review')

    expect(getCompanionConversationContext(conv).messages.map((message) => message.message_id)).toEqual(['visible'])
    expect(searchCompanionConversation(conv, { query: 'corrupted internal' }).hits).toEqual([])
    expect(searchCompanionConversation(conv, { query: 'corrupted review' }).hits).toEqual([])
    for (const id of ['internal', 'review']) {
      expect(readCompanionConversation(conv, { around_seq: getMessageSeq(id)!, limit: 10 }).found).toBe(false)
    }
  })

  it('uses the last portable compaction marker as a boundary and enforces hard bounds', () => {
    const conv = conversationId()
    put(conv, 'm1', [{ type: 'text', id: 'old', text: 'old transcript must not be in brief' }])
    put(conv, 'm2', [
      { type: 'text', id: 'before', text: 'same-message old text' },
      { type: 'compaction', id: 'summary', text: 'portable summary decision', strategy: 'summary' },
      { type: 'text', id: 'after', text: 'same-message active suffix' },
    ])
    for (let i = 3; i <= 35; i++) {
      put(conv, `m${i}`, [{ type: 'text', id: `p${i}`, text: `${i}: ${'x'.repeat(10_000)}` }])
    }

    const brief = getCompanionConversationContext(conv)
    const serialized = JSON.stringify(brief)
    expect(brief).not.toHaveProperty('compaction_summary')
    expect(serialized).not.toContain('old transcript must not be in brief')
    expect(serialized).not.toContain('same-message old text')
    expect(brief.messages.length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_MESSAGES)
    expect(serialized.length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_CHARS)
    expect(brief.has_earlier_history).toBe(true)
    expect(brief.truncated).toBe(true)
  })

  it('does not expose portable compaction summaries derived from tool or file payloads', () => {
    const conv = conversationId()
    const toolSecret = 'tool-payload-sentinel'
    const fileSecret = 'file-payload-sentinel'
    put(conv, 'before-compaction', [
      { type: 'text', id: 'old-visible', text: 'old visible decision' },
      {
        type: 'file',
        id: 'file',
        name: 'requirements.txt',
        mediaType: 'text/plain',
        kind: 'text',
        data: fileSecret,
      },
      {
        type: 'tool',
        id: 'tool',
        toolCallId: 'tool',
        toolName: 'inspect',
        input: { query: toolSecret },
        state: { status: 'completed', output: { text: toolSecret } },
      },
    ])
    put(conv, 'compaction', [
      {
        type: 'compaction',
        id: 'summary',
        text: `unsafe summary ${toolSecret} ${fileSecret}`,
        strategy: 'summary',
      },
      { type: 'text', id: 'recent', text: 'recent visible decision' },
    ])

    const brief = getCompanionConversationContext(conv)
    expect(brief.has_earlier_history).toBe(true)
    expect(brief.messages.map((message) => message.message_id)).toEqual(['compaction'])
    expect(brief.messages[0]?.content).toBe('recent visible decision')
    expect(JSON.stringify(brief)).not.toContain(toolSecret)
    expect(JSON.stringify(brief)).not.toContain(fileSecret)

    expect(searchCompanionConversation(conv, { query: 'old visible decision' }).hits).toHaveLength(1)
    expect(searchCompanionConversation(conv, { query: toolSecret }).hits).toEqual([])
    expect(searchCompanionConversation(conv, { query: fileSecret }).hits).toEqual([])

    const read = JSON.stringify(
      readCompanionConversation(conv, { around_seq: getMessageSeq('compaction')!, limit: 10 })
    )
    expect(read).toContain('recent visible decision')
    expect(read).not.toContain(toolSecret)
    expect(read).not.toContain(fileSecret)
  })

  it('enforces the serialized hard bound with escaping-heavy summary and messages', () => {
    const conv = conversationId()
    const escapingHeavy = ['"', '\\', '\n', '\r', '\t', '\u0000'].join('').repeat(2_000)
    put(conv, 'summary', [
      { type: 'compaction', id: 'summary-part', text: escapingHeavy, strategy: 'summary' },
      { type: 'text', id: 'active-part', text: 'active decision' },
    ])
    for (let i = 2; i <= 35; i++) {
      put(conv, `escaped-${i}`, [{ type: 'text', id: `escaped-part-${i}`, text: escapingHeavy }])
    }

    const brief = getCompanionConversationContext(conv)
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_CHARS)
    expect(brief).not.toHaveProperty('compaction_summary')
    expect(brief.truncated).toBe(true)
  })

  it('returns a stable balanced seq window with continuation flags and rejects foreign anchors', () => {
    const conv = conversationId()
    for (let i = 1; i <= 7; i++) {
      put(conv, `m${i}`, [{ type: 'text', id: `p${i}`, text: `message ${i}` }])
    }
    put(conv, 'foreign', [{ type: 'text', id: 'foreign-part', text: 'foreign' }], {
      executionScope: { kind: 'review-summary', loopId: 'loop' },
    })
    const aroundSeq = getMessageSeq('m4')!
    const storePage = readCompanionConversationPage(conv, aroundSeq, 3)
    expect(storePage?.messages.map((row) => row.message.id)).toEqual(['m3', 'm4', 'm5'])
    expect(storePage).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })

    const page = readCompanionConversation(conv, { around_seq: aroundSeq, limit: 3 })
    expect(page.messages.map((message) => message.message_id)).toEqual(['m3', 'm4', 'm5'])
    expect(page.messages.map((message) => message.seq)).toEqual(
      [...page.messages.map((message) => message.seq)].sort((a, b) => a - b)
    )
    expect(page).toMatchObject({ found: true, has_more_before: true, has_more_after: true })

    expect(readCompanionConversation(conv, { around_seq: getMessageSeq('foreign')!, limit: 3 })).toEqual({
      around_seq: getMessageSeq('foreign'),
      found: false,
      messages: [],
      has_more_before: false,
      has_more_after: false,
      truncated: false,
    })
  })

  it('counts only projectable messages when filling a read window around an anchor', () => {
    const conv = conversationId()
    put(conv, 'before-visible', [{ type: 'text', id: 'before', text: 'before decision' }])
    put(conv, 'tool-before', [
      {
        type: 'tool',
        id: 'tool-before-part',
        toolCallId: 'tool-before',
        toolName: 'inspect',
        input: { query: 'hidden' },
        state: { status: 'completed', output: { text: 'hidden' } },
      },
    ])
    put(conv, 'reasoning-before', [{ type: 'reasoning', id: 'reasoning-before-part', text: 'hidden' }])
    put(conv, 'anchor', [{ type: 'text', id: 'anchor-part', text: 'anchor decision' }])
    put(conv, 'tool-after', [
      {
        type: 'tool',
        id: 'tool-after-part',
        toolCallId: 'tool-after',
        toolName: 'inspect',
        input: { query: 'hidden' },
        state: { status: 'completed', output: { text: 'hidden' } },
      },
    ])
    put(conv, 'reasoning-after', [{ type: 'reasoning', id: 'reasoning-after-part', text: 'hidden' }])
    put(conv, 'after-visible', [{ type: 'text', id: 'after', text: 'after decision' }])
    put(conv, 'after-visible-2', [{ type: 'text', id: 'after-2', text: 'after decision 2' }])

    const page = readCompanionConversation(conv, { around_seq: getMessageSeq('anchor')!, limit: 3 })
    expect(page.messages.map((message) => message.message_id)).toEqual(['before-visible', 'anchor', 'after-visible'])
    expect(page).toMatchObject({ found: true, has_more_before: false, has_more_after: true })
  })
})
