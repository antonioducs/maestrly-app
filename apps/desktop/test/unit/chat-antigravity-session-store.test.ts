import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAntigravitySessionBindings,
  getAntigravitySessionBinding,
  putAntigravitySessionBinding,
  retireAntigravitySessionBinding,
} from '../../src/main/chat/antigravity-subscription/session-store'
import { deleteConversation } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(conversationId: string, sessionId: string, accountId: string | null = null) {
  putAntigravitySessionBinding({
    conversationId,
    accountId,
    accountFingerprint: 'project:abc',
    sessionId,
    modelValue: 'gemini-pro-agent',
    toolSignature: 'sig',
    instructionHash: 'hash',
    lastMessageId: `last-${sessionId}`,
  })
}

describe('Antigravity session store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('round-trips the full resume contract', () => {
    const conversation = makeConversation(makeWorkspace().id, {})
    bind(conversation.id, 's1')
    expect(getAntigravitySessionBinding(conversation.id)).toEqual({
      conversationId: conversation.id,
      accountId: null,
      accountFingerprint: 'project:abc',
      sessionId: 's1',
      modelValue: 'gemini-pro-agent',
      toolSignature: 'sig',
      instructionHash: 'hash',
      lastMessageId: 'last-s1',
      updatedAt: expect.any(Number),
    })
    bind(conversation.id, 's2', 'acc_1')
    expect(getAntigravitySessionBinding(conversation.id)).toMatchObject({ sessionId: 's2', accountId: 'acc_1' })
  })

  it('retires only the expected session', () => {
    const conversation = makeConversation(makeWorkspace().id, {})
    bind(conversation.id, 's1')
    expect(retireAntigravitySessionBinding(conversation.id, 'other')).toBe(false)
    expect(getAntigravitySessionBinding(conversation.id)?.sessionId).toBe('s1')
    expect(retireAntigravitySessionBinding(conversation.id, 's1')).toBe(true)
    expect(getAntigravitySessionBinding(conversation.id)).toBeUndefined()
  })

  it('clears bindings per account', () => {
    const workspace = makeWorkspace()
    const first = makeConversation(workspace.id, {})
    const second = makeConversation(workspace.id, {})
    bind(first.id, 's1', null)
    bind(second.id, 's2', 'acc_2')
    clearAntigravitySessionBindings('acc_2')
    expect(getAntigravitySessionBinding(first.id)).toBeDefined()
    expect(getAntigravitySessionBinding(second.id)).toBeUndefined()
    clearAntigravitySessionBindings()
    expect(getAntigravitySessionBinding(first.id)).toBeUndefined()
  })

  it('cascades with the conversation', () => {
    const conversation = makeConversation(makeWorkspace().id, {})
    bind(conversation.id, 's1')
    deleteConversation(conversation.id)
    expect(getAntigravitySessionBinding(conversation.id)).toBeUndefined()
  })
})
