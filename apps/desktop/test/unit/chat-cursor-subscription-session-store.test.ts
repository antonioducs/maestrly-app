import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllCursorAgentCleanup,
  clearCursorAgentBindings,
  getCursorAgentBinding,
  listCursorAgentCleanup,
  markCursorAgentCleanupFailed,
  putCursorAgentBinding,
  queueCursorAgentCleanup,
  retireCursorAgentBinding,
} from '../../src/main/chat/cursor-subscription/session-store'
import { deleteConversation } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

function bind(conversationId: string, agentId: string, overrides: Record<string, unknown> = {}): void {
  putCursorAgentBinding({
    conversationId,
    agentId,
    modelId: 'composer-2.5',
    modelParams: [{ id: 'fast', value: 'false' }],
    cwd: '/repo',
    harnessProfile: 'cursor-subscription-v1',
    instructionHash: 'h1',
    toolSignature: 'sig1',
    lastMessageId: `last-${agentId}`,
    accountFingerprint: 'user:7',
    usageJson: '{}',
    ...overrides,
  } as never)
}

describe('Cursor agent session store', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists and updates the complete resume contract', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')
    expect(getCursorAgentBinding(conversation.id)).toMatchObject({
      conversationId: conversation.id,
      agentId: 'agent-1',
      modelId: 'composer-2.5',
      modelParams: [{ id: 'fast', value: 'false' }],
      cwd: '/repo',
      harnessProfile: 'cursor-subscription-v1',
      instructionHash: 'h1',
      toolSignature: 'sig1',
      lastMessageId: 'last-agent-1',
      accountFingerprint: 'user:7',
      accountId: null,
    })

    bind(conversation.id, 'agent-2', { accountId: 'acc_A', modelParams: [] })
    const updated = getCursorAgentBinding(conversation.id)
    expect(updated?.agentId).toBe('agent-2')
    expect(updated?.accountId).toBe('acc_A')
    expect(updated?.modelParams).toEqual([])
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(Date.now() - 5_000)
  })

  it('queues a tombstone on retirement using an agent ID compare-and-swap', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')
    expect(retireCursorAgentBinding(conversation.id, 'wrong-agent')).toBe(false)
    expect(getCursorAgentBinding(conversation.id)).not.toBeNull()
    expect(retireCursorAgentBinding(conversation.id, 'agent-1')).toBe(true)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    const cleanup = listCursorAgentCleanup()
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({ agentId: 'agent-1', conversationId: conversation.id, cwd: '/repo', attempts: 0 })
  })

  it('marks and clears tombstones and scopes cleanup by account', () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-a', { accountId: null })
    bind(b.id, 'agent-b', { accountId: 'acc_A' })
    queueCursorAgentCleanup(a.id, 'agent-a', '/repo')
    queueCursorAgentCleanup(b.id, 'agent-b', '/repo', 'acc_A')
    markCursorAgentCleanupFailed('agent-a', 'boom')
    const rows = listCursorAgentCleanup()
    expect(rows.find((r) => r.agentId === 'agent-a')?.attempts).toBe(1)
    expect(rows.find((r) => r.agentId === 'agent-a')?.lastError).toBe('boom')

    expect(clearCursorAgentBindings('acc_A')).toBe(1)
    expect(getCursorAgentBinding(b.id)).toBeNull()
    expect(getCursorAgentBinding(a.id)).not.toBeNull()
    expect(clearAllCursorAgentCleanup('acc_A')).toBe(1)
    expect(listCursorAgentCleanup().map((r) => r.agentId)).toEqual(['agent-a'])
  })

  it('sanitizes cleanup errors from both Error objects and strings', () => {
    const workspace = makeWorkspace()
    const a = makeConversation(workspace.id, {})
    const b = makeConversation(workspace.id, {})
    bind(a.id, 'agent-a')
    bind(b.id, 'agent-b')
    queueCursorAgentCleanup(a.id, 'agent-a', '/repo')
    queueCursorAgentCleanup(b.id, 'agent-b', '/repo')
    const crsrSecret = 'crsr_live_AbCdEf1234567890'
    const keySecret = 'key_ZZZyyyxxx111222333'

    markCursorAgentCleanupFailed('agent-a', new Error(`store locked: Authorization: Bearer ${crsrSecret}`))

    markCursorAgentCleanupFailed('agent-b', `retry failed: apiKey=${keySecret}`)

    const rows = listCursorAgentCleanup()
    const aRow = rows.find((r) => r.agentId === 'agent-a')
    expect(aRow?.lastError).not.toContain(crsrSecret)
    expect(aRow?.lastError).toContain('[REDACTED]')
    expect(aRow?.attempts).toBe(1)
    const bRow = rows.find((r) => r.agentId === 'agent-b')
    expect(bRow?.lastError).not.toContain(keySecret)
    expect(bRow?.lastError).toContain('[REDACTED]')
    expect(bRow?.attempts).toBe(1)
  })

  it('queues cleanup when conversation deletion cascades to the binding', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'agent-1')
    deleteConversation(conversation.id)
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(listCursorAgentCleanup().map((r) => r.agentId)).toEqual(['agent-1'])
  })
  it('retains sanitized cleanup tombstones across database restart', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})
    bind(conversation.id, 'durable-agent', { accountId: 'account_A' })
    retireCursorAgentBinding(conversation.id, 'durable-agent')
    markCursorAgentCleanupFailed('durable-agent', new Error('Authorization: Bearer crsr_private'))
    restartDb()
    expect(getCursorAgentBinding(conversation.id)).toBeNull()
    expect(listCursorAgentCleanup()).toMatchObject([
      {
        agentId: 'durable-agent',
        accountId: 'account_A',
        attempts: 1,
      },
    ])
    expect(listCursorAgentCleanup()[0]?.lastError).not.toContain('crsr_private')
  })
})
