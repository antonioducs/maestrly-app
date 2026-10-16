import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { conversationWorkspaceIds, scopeAppliesTo } from '../../src/main/chat/workspace-scope'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'

beforeEach(() => freshDb())
afterEach(() => closeDb())

describe('workspace scope of a conversation', () => {
  it('applies a project scope only to conversations of those projects', () => {
    const w1 = makeWorkspace()
    const w2 = makeWorkspace()
    const p1 = makeConversation(w1.id)
    const standalone = makeStandaloneConversation()
    const scope = { kind: 'projects' as const, workspaceIds: [w1.id] }
    expect(conversationWorkspaceIds(p1.id)).toEqual([w1.id])
    expect(conversationWorkspaceIds(standalone.id)).toEqual([])
    expect(scopeAppliesTo(scope, p1.id)).toBe(true)
    expect(scopeAppliesTo(scope, makeConversation(w2.id).id)).toBe(false)
    expect(scopeAppliesTo(scope, standalone.id)).toBe(false)
    expect(scopeAppliesTo(scope, null)).toBe(false)
    // Settings (no conversation) sees everything; a global scope applies everywhere.
    expect(scopeAppliesTo(scope, undefined)).toBe(true)
    expect(scopeAppliesTo({ kind: 'global' }, standalone.id)).toBe(true)
  })
})
