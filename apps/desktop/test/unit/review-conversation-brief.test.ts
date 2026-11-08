import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { upsertChatMessage, type StoredChatMessage } from '../../src/main/chat/chat-store'
import { conversationBrief, conversationVisibleText } from '../../src/main/chat/review/conversation-brief'
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

describe('reviewer conversation brief', () => {
  it('projects only visible requirement text', () => {
    const text = conversationVisibleText([
      { type: 'text', id: 'text', text: 'visible decision' },
      { type: 'text', id: 'checkpoint', text: 'opaque checkpoint', checkpoint: 'openai-native' },
      { type: 'reasoning', id: 'reasoning', text: 'private reasoning' },
      {
        type: 'tool',
        id: 'tool',
        toolCallId: 'tool',
        toolName: 'secret_tool',
        input: { token: 'tool input' },
        state: { status: 'completed', output: { text: 'tool output' } },
      },
      { type: 'file', id: 'file', name: 'spec.txt', mediaType: 'text/plain', kind: 'text', data: 'file payload' },
      {
        type: 'file',
        id: 'hidden',
        name: 'hidden.md',
        mediaType: 'text/plain',
        kind: 'text',
        data: 'hidden payload',
        hidden: true,
      },
      { type: 'skill-invocation', id: 'skill', name: 'review', args: '--strict', body: 'skill body', dir: '/skill' },
      { type: 'context', id: 'context', text: 'imported context' },
    ])
    expect(text).toBe('visible decision\n[Attachment: spec.txt]\n/review --strict\nimported context')
  })

  it('keeps the recent visible messages of the main context and leaves internal ones out', () => {
    const id = conversationId()
    put(id, 'm1', [{ type: 'text', id: 't1', text: 'first requirement' }])
    put(id, 'm2', [{ type: 'text', id: 't2', text: 'internal framing' }], { internal: true })
    put(id, 'm3', [{ type: 'reasoning', id: 't3', text: 'nothing visible' }], { role: 'assistant' })
    put(id, 'm4', [{ type: 'text', id: 't4', text: 'answer' }], { role: 'assistant' })
    const brief = conversationBrief(id)
    expect(brief.map((message) => [message.message_id, message.role, message.content])).toEqual([
      ['m1', 'user', 'first requirement'],
      ['m4', 'assistant', 'answer'],
    ])
  })

  it('stays within its budget by keeping the newest messages and clipping long ones', () => {
    const id = conversationId()
    for (let index = 1; index <= 30; index += 1) {
      put(id, `m${index}`, [{ type: 'text', id: `t${index}`, text: `message ${index} ${'x'.repeat(5_000)}` }])
    }
    const brief = conversationBrief(id)
    expect(brief.length).toBeGreaterThan(0)
    expect(brief.length).toBeLessThanOrEqual(20)
    expect(brief.at(-1)?.message_id).toBe('m30')
    expect(brief.every((message) => message.truncated === true)).toBe(true)
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(24_000)
  })
})
