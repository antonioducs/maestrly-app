import { describe, expect, it } from 'vitest'
import type { StoredChatMessage } from '../../src/main/chat/chat-store'
import { toModelMessages } from '../../src/main/chat/message'
import { MODEL_FALLBACK_CONTINUE_PROMPT } from '../../src/main/chat/model-fallback/turn-fallback'

const user = (id: string, text: string, createdAt: number, internal = false): StoredChatMessage => ({
  id,
  conversationId: 'c1',
  role: 'user',
  parts: [{ type: 'text', id: `${id}-t`, text }],
  createdAt,
  ...(internal ? { internal: true } : {}),
})

const assistant = (
  id: string,
  parts: StoredChatMessage['parts'],
  createdAt: number,
  model = { providerId: 'primary', modelId: 'big' }
): StoredChatMessage => ({ id, conversationId: 'c1', role: 'assistant', parts, createdAt, model })

/** A turn that failed on the primary mid tool call and was continued on a fallback, in a new bubble. */
const before: StoredChatMessage[] = [
  user('u1', 'what does this repo do?', 1),
  assistant('a1', [{ type: 'text', id: 'a1-t', text: 'It builds a desktop app.' }], 2),
]
const episode: StoredChatMessage[] = [
  user('u2', 'fix the flaky test', 3),
  assistant(
    'a2',
    [
      { type: 'text', id: 'a2-t', text: 'Looking at the test first.' },
      {
        type: 'tool',
        id: 'call-1',
        toolCallId: 'call-1',
        toolName: 'read',
        input: { path: 'a.test.ts' },
        state: { status: 'running' },
      },
    ],
    4
  ),
  user('u3', MODEL_FALLBACK_CONTINUE_PROMPT, 5, true),
  assistant('a3', [{ type: 'text', id: 'a3-t', text: 'Fixed the race in the test.' }], 6, {
    providerId: 'fallback',
    modelId: 'small',
  }),
]

describe('transcript across a model fallback episode', () => {
  it('keeps the prefix sent before the episode byte for byte, so the primary reuses its cache', () => {
    const prefix = toModelMessages(before)
    const after = toModelMessages([...before, ...episode, user('u4', 'thanks, now update the docs', 7)])
    expect(JSON.stringify(after.slice(0, prefix.length))).toBe(JSON.stringify(prefix))
  })

  it('never sends a tool call without its result from the failed attempt', () => {
    const messages = toModelMessages([...before, ...episode])
    const calls = new Set<string>()
    const results = new Set<string>()
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
        if (part.type === 'tool-call' && part.toolCallId) calls.add(part.toolCallId)
        if (part.type === 'tool-result' && part.toolCallId) results.add(part.toolCallId)
      }
    }
    for (const id of calls) expect(results.has(id)).toBe(true)
    expect(JSON.stringify(messages)).toContain(MODEL_FALLBACK_CONTINUE_PROMPT)
  })
})
